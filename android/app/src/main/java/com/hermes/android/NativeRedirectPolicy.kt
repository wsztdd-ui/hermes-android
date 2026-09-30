package com.hermes.android

import java.net.URI
import java.net.URL

/** Redirects for Gateway API calls must stay on the original HTTPS origin. */
internal object NativeRedirectPolicy {
    fun resolveTarget(currentUrl: String, location: String?, originalOrigin: String): String? {
        if (location.isNullOrBlank()) return null
        return try {
            val resolved = URL(URL(currentUrl), location).toString()
            if (httpsOrigin(currentUrl) != originalOrigin ||
                httpsOrigin(resolved) != originalOrigin
            ) null else resolved
        } catch (_: Exception) {
            null
        }
    }

    fun redirectMethod(status: Int, method: String, body: String): Pair<String, String> = when {
        (status == 301 || status == 302) && method.equals("POST", ignoreCase = true) ->
            "GET" to ""
        status == 303 && !method.equals("GET", ignoreCase = true) &&
            !method.equals("HEAD", ignoreCase = true) -> "GET" to ""
        else -> method to body
    }

    private fun httpsOrigin(url: String): String? {
        return try {
            val uri = URI(url)
            val scheme = uri.scheme
            val host = uri.host?.lowercase()
            if (!scheme.equals("https", ignoreCase = true) || host == null) return null
            val normalizedHost = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            val port = uri.port
            val portSuffix = if (port == -1 || port == 443) "" else ":$port"
            "https://$normalizedHost$portSuffix"
        } catch (_: Exception) {
            null
        }
    }
}
