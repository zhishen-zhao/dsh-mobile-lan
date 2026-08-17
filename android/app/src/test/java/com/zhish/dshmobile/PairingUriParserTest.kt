package com.zhish.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingUriParserTest {
    private val token = "0123456789abcdef0123456789abcdef"

    @Test
    fun parsesHttpsPairingUri() {
        val pairing = PairingUriParser.parse("dshmobile://pair?server=https%3A%2F%2F192.168.1.20%3A3080&token=$token")
        assertEquals("https", pairing.server.scheme)
        assertEquals("192.168.1.20", pairing.server.host)
        assertEquals(token, pairing.token)
    }

    @Test
    fun rejectsCleartextServer() {
        assertThrows(PairingUriException::class.java) {
            PairingUriParser.parse("dshmobile://pair?server=http%3A%2F%2F192.168.1.20%3A3080&token=$token")
        }
    }

    @Test
    fun rejectsShortToken() {
        assertThrows(PairingUriException::class.java) {
            PairingUriParser.parse("dshmobile://pair?server=https%3A%2F%2Fhost.example&token=too-short")
        }
    }
}
