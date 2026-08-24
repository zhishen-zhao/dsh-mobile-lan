package com.zhish.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingUriParserTest {
    private val token = "0123456789abcdef0123456789abcdef"
    private val certificateSha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    @Test
    fun parsesHttpsPairingUri() {
        val pairing = PairingUriParser.parse("dshmobile://pair?server=https%3A%2F%2F192.168.1.20%3A3080&token=$token&certSha256=$certificateSha256")
        assertEquals("https", pairing.server.scheme)
        assertEquals("192.168.1.20", pairing.server.host)
        assertEquals(token, pairing.token)
        assertEquals(certificateSha256, pairing.certificateSha256)
    }

    @Test
    fun rejectsCleartextServer() {
        assertThrows(PairingUriException::class.java) {
            PairingUriParser.parse("dshmobile://pair?server=http%3A%2F%2F192.168.1.20%3A3080&token=$token&certSha256=$certificateSha256")
        }
    }

    @Test
    fun rejectsShortToken() {
        assertThrows(PairingUriException::class.java) {
            PairingUriParser.parse("dshmobile://pair?server=https%3A%2F%2Fhost.example&token=too-short&certSha256=$certificateSha256")
        }
    }

    @Test
    fun rejectsMissingCertificatePin() {
        assertThrows(PairingUriException::class.java) {
            PairingUriParser.parse("dshmobile://pair?server=https%3A%2F%2Fhost.example&token=$token")
        }
    }
}
