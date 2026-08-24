package com.zhish.dshmobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts the short-lived device session with an app-private Android Keystore key. */
internal class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun save(session: PairedSession) {
        val payload = JSONObject()
            .put("server", session.server.toString())
            .put("cookie", session.cookie)
            .put("expiresAt", session.expiresAt)
            .put("certificateSha256", session.certificateSha256)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, key())
            updateAAD(AAD)
        }
        val encrypted = cipher.doFinal(payload)
        val encoded = "${Base64.encodeToString(cipher.iv, Base64.NO_WRAP)}:${Base64.encodeToString(encrypted, Base64.NO_WRAP)}"
        preferences.edit().putString(PAYLOAD, encoded).apply()
    }

    fun load(): PairedSession? {
        val encoded = preferences.getString(PAYLOAD, null) ?: return null
        return try {
            val parts = encoded.split(':', limit = 2)
            require(parts.size == 2)
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
                updateAAD(AAD)
            }
            val json = JSONObject(cipher.doFinal(encrypted).toString(Charsets.UTF_8))
            PairedSession(
                server = URI(json.getString("server")),
                cookie = json.getString("cookie"),
                expiresAt = json.getLong("expiresAt"),
                certificateSha256 = json.getString("certificateSha256"),
            ).takeIf { it.expiresAt > System.currentTimeMillis() }
                ?: run { clear(); null }
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun clear() {
        preferences.edit().remove(PAYLOAD).apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private companion object {
        const val PREFERENCES = "dsh_mobile_secure_session"
        const val PAYLOAD = "encrypted_session_v1"
        const val KEY_ALIAS = "dsh_mobile_device_session_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        val AAD = "com.zhish.dshmobile.session.v1".toByteArray(Charsets.UTF_8)
    }
}
