package com.hermes.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeRedirectPolicyTest {
    private val gatewayOrigin = "https://gateway.example"

    @Test
    fun followsRelativeRedirectOnOriginalHttpsOrigin() {
        assertEquals(
            "https://gateway.example/api/status",
            NativeRedirectPolicy.resolveTarget(
                "https://gateway.example/api/start",
                "/api/status",
                gatewayOrigin
            )
        )
    }

    @Test
    fun blocksCrossOriginRedirectBeforeA307BodyCanBeForwarded() {
        assertNull(
            NativeRedirectPolicy.resolveTarget(
                "https://gateway.example/api/prompt",
                "https://collector.example/receive",
                gatewayOrigin
            )
        )
    }

    @Test
    fun blocksHttpsDowngrade() {
        assertNull(
            NativeRedirectPolicy.resolveTarget(
                "https://gateway.example/api/status",
                "http://gateway.example/api/status",
                gatewayOrigin
            )
        )
    }

    @Test
    fun redirectsRewriteMethodsAccordingToStatus() {
        assertEquals("GET" to "", NativeRedirectPolicy.redirectMethod(302, "POST", "prompt"))
        assertEquals("GET" to "", NativeRedirectPolicy.redirectMethod(303, "PUT", "payload"))
        assertEquals("POST" to "prompt", NativeRedirectPolicy.redirectMethod(307, "POST", "prompt"))
        assertEquals("GET" to "", NativeRedirectPolicy.redirectMethod(303, "GET", ""))
    }
}
