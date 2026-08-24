package com.zhish.dshmobile

import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

data class PairedSession(val server: URI, val cookie: String, val expiresAt: Long, val certificateSha256: String)

private class ApiException(message: String) : Exception(message)

/** Native networking only exchanges a one-time pairing code for a WebView cookie. */
private class DshApiClient(context: Context) {
    private val appContext = context.applicationContext

    fun connect(pairing: PairingUri): PairedSession {
        val login = request(
            "POST",
            pairing.server,
            "/mobile-api/login",
            JSONObject().put("token", pairing.token).put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(80)),
            certificateSha256 = pairing.certificateSha256,
        )
        val cookie = login.cookie ?: throw ApiException("服务器没有签发设备会话，请重新扫码。")
        request("GET", pairing.server, "/mobile-api/state", cookie = cookie, certificateSha256 = pairing.certificateSha256)
        val expiresAt = login.json.optLong("expiresAt").takeIf { it > System.currentTimeMillis() }
            ?: (System.currentTimeMillis() + login.json.optLong("expiresInMs", 12 * 60 * 60 * 1000L))
        return PairedSession(pairing.server, cookie, expiresAt, pairing.certificateSha256)
    }

    fun validate(session: PairedSession) {
        request("GET", session.server, "/mobile-api/state", cookie = session.cookie, certificateSha256 = session.certificateSha256)
    }

    fun logout(session: PairedSession) {
        try {
            request("POST", session.server, "/mobile-api/logout", JSONObject(), session.cookie, session.certificateSha256)
        } catch (_: Exception) {
            // Local credentials are discarded even when the computer is offline.
        }
    }

    private data class Response(val json: JSONObject, val cookie: String?)

    private fun request(
        method: String,
        server: URI,
        path: String,
        body: JSONObject? = null,
        cookie: String? = null,
        certificateSha256: String,
    ): Response {
        val connection = (endpoint(server, path).openConnection() as? HttpsURLConnection)
            ?: throw ApiException("仅允许 HTTPS 连接")
        try {
            connection.sslSocketFactory = createPinnedSocketFactory(certificateSha256)
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("Accept", "application/json")
            cookie?.let { connection.setRequestProperty("Cookie", it) }
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }

            val status = connection.responseCode
            val payload = readAtMost(if (status in 200..299) connection.inputStream else connection.errorStream)
            val json = try {
                JSONObject(payload.ifBlank { "{}" })
            } catch (_: Exception) {
                throw ApiException("服务器返回了无效响应")
            }
            if (status !in 200..299 || !json.optBoolean("ok")) {
                throw ApiException(json.optString("error").ifBlank { "请求失败（HTTP $status）" }.take(300))
            }
            return Response(json, sessionCookie(connection))
        } catch (error: ApiException) {
            throw error
        } catch (_: Exception) {
            throw ApiException("网络或 TLS 连接失败。请确认电脑在线、手机处于同一局域网，并重新扫描当前二维码。")
        } finally {
            connection.disconnect()
        }
    }

    private fun endpoint(server: URI, path: String): URL {
        if (!server.scheme.equals("https", ignoreCase = true) || server.host.isNullOrBlank()) throw ApiException("仅允许 HTTPS 服务器地址")
        return URL(server.toString().removeSuffix("/") + path)
    }

    private fun sessionCookie(connection: HttpsURLConnection): String? = connection.headerFields.entries
        .filter { (name, _) -> name.equals("Set-Cookie", ignoreCase = true) }
        .flatMap { it.value.orEmpty() }
        .asSequence()
        .flatMap { it.split(';').asSequence() }
        .map(String::trim)
        .firstOrNull { it.startsWith("dsh_mobile_session=") }

    private fun readAtMost(stream: InputStream?): String {
        if (stream == null) return ""
        return stream.use {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8_192)
            while (output.size() < MAX_RESPONSE_BYTES) {
                val count = it.read(buffer, 0, minOf(buffer.size, MAX_RESPONSE_BYTES - output.size()))
                if (count < 0) break
                output.write(buffer, 0, count)
            }
            output.toString(Charsets.UTF_8.name())
        }
    }

    private fun createPinnedSocketFactory(certificateSha256: String): SSLSocketFactory {
        val expected = certificateSha256.lowercase()
        val trustManager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("client certificates are not accepted")
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull() ?: throw CertificateException("server certificate is missing")
                leaf.checkValidity()
                val actual = MessageDigest.getInstance("SHA-256").digest(leaf.encoded).joinToString("") { "%02x".format(it) }
                if (!MessageDigest.isEqual(actual.toByteArray(Charsets.US_ASCII), expected.toByteArray(Charsets.US_ASCII))) {
                    throw CertificateException("server certificate fingerprint changed")
                }
            }
        }
        return SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }.socketFactory
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 1_048_576
    }
}

/** Process-memory session only: no token, cookie or server address is persisted. */
object MobileAppSession {
    private lateinit var api: DshApiClient
    private lateinit var store: SecureSessionStore
    private var session: PairedSession? = null

    @Synchronized
    fun initialize(context: Context) {
        if (!::api.isInitialized) api = DshApiClient(context)
        if (!::store.isInitialized) store = SecureSessionStore(context.applicationContext)
        if (session == null) session = store.load()
    }

    @Synchronized
    fun connect(pairing: PairingUri): PairedSession {
        session = client().connect(pairing)
        store.save(requireNotNull(session))
        return requireNotNull(session)
    }

    @Synchronized
    fun current(): PairedSession? {
        val current = session ?: return null
        if (current.expiresAt <= System.currentTimeMillis()) {
            clearLocal()
            return null
        }
        return current
    }

    @Synchronized
    fun restore(): PairedSession? {
        val current = current() ?: return null
        return try {
            client().validate(current)
            current
        } catch (_: Exception) {
            clearLocal()
            null
        }
    }

    @Synchronized
    fun detach(): PairedSession? = session.also {
        session = null
        store.clear()
    }

    @Synchronized
    fun clearLocal() {
        session = null
        if (::store.isInitialized) store.clear()
    }

    fun revoke(session: PairedSession) {
        client().logout(session)
    }

    private fun client(): DshApiClient = if (::api.isInitialized) api else throw ApiException("应用尚未初始化")
}
