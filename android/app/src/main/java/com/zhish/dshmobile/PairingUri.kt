package com.zhish.dshmobile

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/** The one-time token stays in memory; the public certificate pin is persisted with the device session. */
data class PairingUri(val server: URI, val token: String, val certificateSha256: String)

class PairingUriException(message: String) : IllegalArgumentException(message)

object PairingUriParser {
    fun parse(raw: String): PairingUri {
        val uri = try {
            URI(raw.trim())
        } catch (_: Exception) {
            throw PairingUriException("配对码格式无效")
        }
        if (!uri.scheme.equals("dshmobile", ignoreCase = true) || !uri.host.equals("pair", ignoreCase = true)) {
            throw PairingUriException("这不是 DSH Mobile 配对码")
        }
        if (uri.fragment != null || uri.userInfo != null) throw PairingUriException("配对码包含不允许的字段")
        val query = decodeQuery(uri.rawQuery)
        val serverText = query["server"] ?: throw PairingUriException("配对码缺少服务器地址")
        val token = query["token"] ?: throw PairingUriException("配对码缺少配对密钥")
        val certificateSha256 = query["certSha256"]?.lowercase()
            ?: throw PairingUriException("配对码缺少 TLS 证书指纹，请更新电脑端插件")
        if (token.toByteArray(StandardCharsets.UTF_8).size < 32) throw PairingUriException("配对密钥长度不足")
        if (!certificateSha256.matches(Regex("^[0-9a-f]{64}$"))) throw PairingUriException("TLS 证书指纹无效")

        val server = try {
            URI(serverText)
        } catch (_: Exception) {
            throw PairingUriException("服务器地址无效")
        }
        if (!server.scheme.equals("https", ignoreCase = true) || server.host.isNullOrBlank()) {
            throw PairingUriException("仅接受 HTTPS 服务器地址")
        }
        if (server.userInfo != null || server.query != null || server.fragment != null) {
            throw PairingUriException("服务器地址包含不允许的字段")
        }
        if (server.path.isNotEmpty() && server.path != "/") throw PairingUriException("服务器地址不能包含路径")
        return PairingUri(server, token, certificateSha256)
    }

    private fun decodeQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = linkedMapOf<String, String>()
        rawQuery.split('&').forEach { part ->
            val pieces = part.split('=', limit = 2)
            if (pieces.size != 2) return@forEach
            val key = decode(pieces[0])
            if (key !in result) result[key] = decode(pieces[1])
        }
        return result
    }

    private fun decode(value: String): String = try {
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())
    } catch (_: Exception) {
        throw PairingUriException("配对码编码无效")
    }
}
