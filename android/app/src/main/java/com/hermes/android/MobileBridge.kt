package com.hermes.android

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebStorage
import org.json.JSONObject
import org.json.JSONArray
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * `window.__hermesMobile` —— 暴露给 JS 桥层的原生能力。
 *
 * 核心能力：
 *  - nativeFetch(url, optionsJson)：原生 HTTP（无浏览器 CORS），带 CookieManager cookie 管理，
 *    等价还原 Electron 主进程 Node HTTP 的行为。
 *  - login(url, provider, username, password)：调 dashboard 的 /auth/password-login，
 *    把 session cookie 存进 CookieManager（与 WebView 共享）。
 *  - secureToken / openExternal / saveImage
 */
class MobileBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val capability: String
) {

    private fun requireCapability(provided: String) {
        check(MessageDigest.isEqual(
            capability.toByteArray(Charsets.UTF_8),
            provided.toByteArray(Charsets.UTF_8)
        )) { "Untrusted frame cannot use the native bridge" }
    }

    private val secureStore = SecureTokenStore(activity)
    private val cookieManager: CookieManager = CookieManager.getInstance()
    // Bound concurrent requests so a reconnect/request storm cannot create an
    // unbounded number of threads on low-memory phones and tablets.
    private val fetchExecutor = Executors.newFixedThreadPool(4)
    private val sessionCookieLock = Any()

    // nativeFetch 手动跟随重定向的最大跳数，超出后按最后一个 3xx 原样返回。
    private val maxRedirectHops = 5

    @JavascriptInterface
    fun getRecentLogs(capability: String): String {
        requireCapability(capability)
        val lines = (activity as? MainActivity)?.recentLogs().orEmpty()
        return JSONArray(lines).toString()
    }

    @JavascriptInterface
    fun revealLogs(capability: String) {
        requireCapability(capability)
        val lines = (activity as? MainActivity)?.recentLogs().orEmpty()
        activity.runOnUiThread {
            val content = lines.takeLast(120).joinToString("\n").ifBlank {
                "暂时没有可显示的运行日志。"
            }
            AlertDialog.Builder(activity)
                .setTitle("Hermes 运行日志")
                .setMessage(content)
                .setPositiveButton("复制") { _, _ ->
                    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Hermes 运行日志", content))
                }
                .setNegativeButton("关闭", null)
                .show()
        }
    }

    @JavascriptInterface
    fun secureToken(capability: String, method: String, key: String, value: String): String {
        requireCapability(capability)
        return try {
            when (method) {
                "get" -> secureStore.get(key) ?: ""
                "set" -> {
                    secureStore.set(key, value)
                    "ok"
                }
                "del" -> {
                    secureStore.del(key)
                    "ok"
                }
                else -> "error:bad-method"
            }
        } catch (e: Exception) {
            "error:${e.message}"
        }
    }

    /**
     * 登录 dashboard（basic auth / password provider）。
     * 调 POST /auth/password-login，成功后从 Set-Cookie 提取 session cookie 值，
     * 存入 SecureTokenStore，供 nativeFetch 手动拼 Cookie 头；同时记录登录 Gateway 的
     * HTTPS origin，避免把一个 Gateway 的 session cookie 带给另一个 Gateway。
     *
     * 为什么不用 CookieManager：`__Host-` 前缀 + Secure 的 cookie 在 CookieManager 里
     * 的 domain 匹配有坑（HttpURLConnection 又不走 WebView cookie 栈），手动提取更可靠。
     * 返回 '{"ok":true}' 或 '{"ok":false,"error":"..."}'。
     */
    @JavascriptInterface
    fun login(capability: String, url: String, provider: String, username: String, password: String): String {
        requireCapability(capability)
        return try {
            requireHttps(url)
            val loginOrigin = httpsOrigin(url)
                ?: throw IllegalArgumentException("Invalid HTTPS gateway URL")
            val body = JSONObject()
                .put("provider", provider)
                .put("username", username)
                .put("password", password)
                .toString()

            val conn = URL("$url/auth/password-login").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            // 登录 POST 不跟随重定向：自动跟随会把凭据原样重放到 Location 指向的
            // 任意主机。若网关把登录端点 30x 到别的地址，调用方拿到该 3xx 状态。
            conn.instanceFollowRedirects = false
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", "HermesAndroid/1.0")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val status = conn.responseCode
            val text = (if (status >= 400) conn.errorStream else conn.inputStream)?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { r -> r.readText() }
            } ?: ""

            // 提取 Set-Cookie 里的 session cookie。
            // 注意：HttpURLConnection.getHeaderFields() 会把多个 Set-Cookie 合并成
            // 一个逗号分隔的字符串；且 __Host-hermes_session_at 的值带双引号（内含逗号）。
            // 所以用正则从整串里精准提取，而不是按逗号 split。
            if (status in 200..299) {
                val setCookieJoined = conn.headerFields.entries
                    .filter { it.key?.equals("set-cookie", true) == true }
                    .flatMap { it.value }
                    .joinToString(",")

                // 提取 __Host-hermes_session_at 值（可能带双引号）
                val atMatch = Regex("__Host-hermes_session_at=(\"[^\"]*\"|[^;,]*)")
                    .find(setCookieJoined)
                val atValue = atMatch?.groupValues?.get(1)?.trim()?.trim('"')

                val providerMatch = Regex("__Host-hermes_session_provider=([^;,]*)")
                    .find(setCookieJoined)
                val providerValue = providerMatch?.groupValues?.get(1)?.trim()?.trim('"')

                if (!atValue.isNullOrBlank() || !providerValue.isNullOrBlank()) {
                    synchronized(sessionCookieLock) {
                        if (!atValue.isNullOrBlank()) {
                            secureStore.set(sessionCookieKey("session_cookie_at", loginOrigin), atValue)
                        }
                        if (!providerValue.isNullOrBlank()) {
                            secureStore.set(sessionCookieKey("session_cookie_provider", loginOrigin), providerValue)
                        }
                        val origins = readSessionOriginsLocked()
                        origins.add(loginOrigin)
                        secureStore.set("session_cookie_origins", JSONArray(origins.toList()).toString())
                    }
                }
            }
            conn.disconnect()

            if (status in 200..299) {
                JSONObject().put("ok", true).put("baseUrl", stripPath(url)).toString()
            } else {
                JSONObject().put("ok", false).put("error", "HTTP $status: $text").toString()
            }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "login failed").toString()
        }
    }

    @JavascriptInterface
    fun loginAsync(capability: String, url: String, provider: String, username: String, password: String, requestId: Int) {
        requireCapability(capability)
        fetchExecutor.execute {
            val result = login(capability, url, provider, username, password)
            val quoted = JSONObject.quote(result)
            webView.post {
                webView.evaluateJavascript(
                    "window.__hermesMobileLoginResolve && window.__hermesMobileLoginResolve($requestId, $quoted);",
                    null
                )
            }
        }
    }

    @JavascriptInterface
    fun clearSession(capability: String) {
        requireCapability(capability)
        synchronized(sessionCookieLock) {
            for (origin in readSessionOriginsLocked()) {
                secureStore.del(sessionCookieKey("session_cookie_at", origin))
                secureStore.del(sessionCookieKey("session_cookie_provider", origin))
            }
            secureStore.del("session_cookie_origins")
            // Remove unscoped cookies left by app versions before origin scoping.
            secureStore.del("session_cookie_at")
            secureStore.del("session_cookie_provider")
            secureStore.del("session_cookie_origin")
        }
        cookieManager.removeAllCookies(null)
        cookieManager.flush()
    }

    @JavascriptInterface
    fun hasSessionFor(capability: String, url: String): Boolean {
        requireCapability(capability)
        val origin = httpsOrigin(url) ?: return false
        return synchronized(sessionCookieLock) {
            !secureStore.get(sessionCookieKey("session_cookie_at", origin)).isNullOrBlank() ||
                !secureStore.get(sessionCookieKey("session_cookie_provider", origin)).isNullOrBlank()
        }
    }

    @JavascriptInterface
    fun clearSessionFor(capability: String, url: String) {
        requireCapability(capability)
        val origin = httpsOrigin(url) ?: return
        synchronized(sessionCookieLock) {
            secureStore.del(sessionCookieKey("session_cookie_at", origin))
            secureStore.del(sessionCookieKey("session_cookie_provider", origin))
            val origins = readSessionOriginsLocked()
            origins.remove(origin)
            if (origins.isEmpty()) secureStore.del("session_cookie_origins")
            else secureStore.set("session_cookie_origins", JSONArray(origins.toList()).toString())
            // Remove legacy unscoped cookies only when their recorded origin is
            // this Gateway, or when no origin-scoped sessions exist to preserve.
            val legacyOrigin = httpsOrigin(secureStore.get("session_cookie_origin").orEmpty())
            if (legacyOrigin == origin || (legacyOrigin == null && origins.isEmpty())) {
                secureStore.del("session_cookie_at")
                secureStore.del("session_cookie_provider")
                secureStore.del("session_cookie_origin")
            }
        }
        // These __Host- cookies are host-only and use Path=/; expire them on this
        // Gateway origin without logging the user out of every other Gateway.
        val cookieUrl = "$origin/"
        cookieManager.setCookie(
            cookieUrl,
            "__Host-hermes_session_at=; Max-Age=0; Path=/; Secure; HttpOnly"
        )
        cookieManager.setCookie(
            cookieUrl,
            "__Host-hermes_session_provider=; Max-Age=0; Path=/; Secure; HttpOnly"
        )
        cookieManager.flush()
        webView.post { WebStorage.getInstance().deleteOrigin(origin) }
    }

    /** JS 同步后台通知开关（更多页）。 */
    @JavascriptInterface
    fun setNotifyEnabled(capability: String, enabled: Boolean) {
        requireCapability(capability)
        HermesNotifier.enabled = enabled
    }

    @JavascriptInterface
    fun setNotifyPreviewEnabled(capability: String, enabled: Boolean) {
        requireCapability(capability)
        HermesNotifier.previewEnabled = enabled
    }

    /** JS 同步 runtime session id → {title, stored} 元数据，供通知标题与点按跳转。 */
    @JavascriptInterface
    fun setNotifySessions(capability: String, json: String) {
        requireCapability(capability)
        HermesNotifier.setSessions(json)
    }

    /**
     * 把 base64（或 data URL）内容保存到系统「下载」目录的 Hermes/ 子目录。
     * API 29+ 走 MediaStore.Downloads（无需存储权限）；API 26-28 需要已授予的
     * 写存储权限。返回 '{"ok":true,"path":"下载/Hermes/…"}' 或 '{"ok":false,"error":…}'。
     */
    @JavascriptInterface
    fun saveFileBase64(capability: String, name: String, mime: String, dataUrl: String): String {
        requireCapability(capability)
        return try {
            val base64 = if (dataUrl.contains(",")) dataUrl.substringAfter(',') else dataUrl
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            val safeName = name.replace(Regex("[/\\\\:*?\"<>|]"), "_").ifBlank { "file" }
            val savedPath: String
            if (Build.VERSION.SDK_INT >= 29) {
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(
                        android.provider.MediaStore.Downloads.MIME_TYPE,
                        mime.ifBlank { "application/octet-stream" }
                    )
                    put(android.provider.MediaStore.Downloads.RELATIVE_PATH, "Download/Hermes")
                    put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return JSONObject().put("ok", false).put("error", "无法创建下载项").toString()
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: return JSONObject().put("ok", false).put("error", "无法写入文件").toString()
                values.clear()
                values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                savedPath = "下载/Hermes/$safeName"
            } else {
                val writeGranted = androidx.core.content.ContextCompat.checkSelfPermission(
                    activity, android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                if (!writeGranted) {
                    return JSONObject().put("ok", false)
                        .put("error", "需要存储权限（系统设置 → 应用 → Hermes → 权限）").toString()
                }
                @Suppress("DEPRECATION")
                val dir = java.io.File(
                    android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_DOWNLOADS
                    ), "Hermes"
                )
                dir.mkdirs()
                val target = java.io.File(dir, safeName)
                target.outputStream().use { it.write(bytes) }
                savedPath = target.absolutePath
            }
            JSONObject().put("ok", true).put("path", savedPath).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "保存失败").toString()
        }
    }

    /**
     * 原生 HTTP 请求（无 CORS），自动附带 CookieManager 里的 session cookie。
     * 3xx 重定向手动逐跳跟随（最多 maxRedirectHops 跳），凭据按 origin 裁剪，
     * 见 performNativeFetch。
     *
     * 入参：url: String, optionsJson 含 method / headers / body / cookieScope。
     * 返回：JSON '{"status":200,"body":"...","error":null}'
     */
    @JavascriptInterface
    fun nativeFetch(capability: String, url: String, optionsJson: String): String {
        requireCapability(capability)
        // Compatibility path for older bridge callers. New renderer builds use
        // nativeFetchAsync so a slow tunnel cannot block the WebView thread.
        return performNativeFetch(url, optionsJson)
    }

    @JavascriptInterface
    fun nativeFetchAsync(capability: String, url: String, optionsJson: String, requestId: Int) {
        requireCapability(capability)
        fetchExecutor.execute {
            val result = performNativeFetch(url, optionsJson)
            val quoted = JSONObject.quote(result)
            webView.post {
                webView.evaluateJavascript(
                    "window.__hermesMobileFetchResolve && window.__hermesMobileFetchResolve($requestId, $quoted);",
                    null
                )
            }
        }
    }

    private fun performNativeFetch(url: String, optionsJson: String): String {
        return try {
            requireHttps(url)
            val options = JSONObject(optionsJson)
            val method = options.optString("method", "GET")
            val headersObj = options.optJSONObject("headers") ?: JSONObject()
            val body = options.optString("body", "")
            val requestOrigin = httpsOrigin(url)
                ?: throw IllegalArgumentException("Request URL must use HTTPS")
            val cookieScopeOrigin = httpsOrigin(options.optString("cookieScope", ""))

            // Gateway API 重定向必须留在原始 HTTPS origin；避免 307/308 把聊天
            // 正文转发到其他主机。301/302 POST 与 303 非 GET 仍按 HTTP 语义改为 GET。
            var currentUrl = url
            var currentMethod = method
            var currentBody = body
            var status = 0
            var text = ""
            var redirectError: String? = null
            var hops = 0
            while (true) {
                val conn = openScopedRequest(currentUrl, currentMethod, currentBody, headersObj, cookieScopeOrigin)
                status = conn.responseCode
                recordSetCookies(conn, currentUrl)
                if (status in 300..399 && hops < maxRedirectHops) {
                    val location = conn.getHeaderField("Location")
                    conn.disconnect()
                    val target = NativeRedirectPolicy.resolveTarget(
                        currentUrl, location, requestOrigin
                    )
                    if (target == null) {
                        redirectError = "Redirect blocked: target must remain on the original HTTPS origin"
                        break
                    }
                    val rewritten = NativeRedirectPolicy.redirectMethod(
                        status, currentMethod, currentBody
                    )
                    currentMethod = rewritten.first
                    currentBody = rewritten.second
                    currentUrl = target
                    hops++
                    continue
                }
                val stream = if (status >= 400) conn.errorStream else conn.inputStream
                text = stream?.let {
                    BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { r -> r.readText() }
                } ?: ""
                conn.disconnect()
                break
            }

            JSONObject()
                .put("status", status)
                .put("body", text)
                .put("error", redirectError?.let { it } ?: JSONObject.NULL)
                .toString()
        } catch (e: Exception) {
            JSONObject()
                .put("status", 0)
                .put("body", "")
                .put("error", e.message ?: "network error")
                .toString()
        }
    }

    /**
     * 构建单跳请求。会话 cookie / CookieManager cookie / 认证类请求头只发往
     * cookieScope origin，跳到其它 origin 时一律剥离——手动重定向跟随的
     * 凭据隔离依赖这里（见 performNativeFetch）。
     */
    private fun openScopedRequest(
        url: String,
        method: String,
        body: String,
        headersObj: JSONObject,
        cookieScopeOrigin: String?
    ): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 15000
        // 读超时放宽到 30s：/api/model/set 等端点会做提供商目录/端点探测，
        // 15s 会把服务端仍在处理的请求掐断成超时。
        conn.readTimeout = 30000
        conn.instanceFollowRedirects = false

        val hopOrigin = httpsOrigin(url)
        val allowCredentials = hopOrigin != null && hopOrigin == cookieScopeOrigin
        val credentialHeaders = setOf("cookie", "authorization", "x-hermes-session-token")

        // 请求头
        val keys = headersObj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (!allowCredentials && key.lowercase() in credentialHeaders) continue
            conn.setRequestProperty(key, headersObj.getString(key))
        }
        if (!headersObj.has("Accept")) {
            conn.setRequestProperty("Accept", "application/json")
        }
        if (!headersObj.has("User-Agent")) {
            conn.setRequestProperty("User-Agent", "HermesAndroid/1.0")
        }

        if (allowCredentials) {
            // 附带 session cookie：从 SecureTokenStore 读登录时存的 at cookie。
            // 注意：at 值内含逗号（JWT），服务器用双引号包裹，这里也要带双引号还原。
            val origin = hopOrigin
            val sessionCookies = origin?.let {
                synchronized(sessionCookieLock) {
                    secureStore.get(sessionCookieKey("session_cookie_at", it)) to
                        secureStore.get(sessionCookieKey("session_cookie_provider", it))
                }
            }
            val atCookie = sessionCookies?.first
            val providerCookie = sessionCookies?.second
            val parts = mutableListOf<String>()
            if (!atCookie.isNullOrBlank()) parts.add("__Host-hermes_session_at=\"$atCookie\"")
            if (!providerCookie.isNullOrBlank()) parts.add("__Host-hermes_session_provider=$providerCookie")
            val cmCookie = cookieManager.getCookie(url) ?: cookieManager.getCookie(stripPath(url))
            if (!cmCookie.isNullOrBlank()) parts.add(cmCookie)
            val finalCookie = parts.joinToString("; ")
            if (finalCookie.isNotBlank()) {
                conn.setRequestProperty("Cookie", finalCookie)
            }
        }

        // 写 body
        if (body.isNotEmpty() && (method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE")) {
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        return conn
    }

    /** 把该响应的 Set-Cookie 记入 CookieManager（每个重定向跳转都可能带新 cookie）。 */
    private fun recordSetCookies(conn: HttpURLConnection, requestUrl: String) {
        val setCookies = conn.headerFields.filterKeys { it?.equals("set-cookie", true) == true }
            .flatMap { it.value }
        if (setCookies.isNotEmpty()) {
            val baseUrl = stripPath(requestUrl)
            for (cookieLine in setCookies) {
                cookieManager.setCookie(baseUrl, cookieLine)
            }
            cookieManager.flush()
        }
    }

    @JavascriptInterface
    fun openExternal(capability: String, url: String) {
        requireCapability(capability)
        try {
            requireWebUrl(url)
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            // ignore
        }
    }

    @JavascriptInterface
    fun saveImage(capability: String, url: String) {
        requireCapability(capability)
        try {
            requireWebUrl(url)
            activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
            // ignore
        }
    }

    /** 去掉 path，只留 scheme://host[:port]。 */
    private fun stripPath(url: String): String {
        return try {
            val u = Uri.parse(url)
            val port = if (u.port != -1) ":${u.port}" else ""
            (if (u.scheme != null) "${u.scheme}://" else "") + (u.host ?: "") + port
        } catch (_: Exception) {
            url
        }
    }

    /** Canonical HTTPS origin used to scope manually stored session cookies. */
    private fun httpsOrigin(url: String): String? {
        return try {
            val uri = URI(url)
            if (!uri.scheme.equals("https", ignoreCase = true)) return null
            val host = uri.host?.lowercase() ?: return null
            val normalizedHost = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            val port = uri.port
            val portSuffix = if (port == -1 || port == 443) "" else ":$port"
            "https://$normalizedHost$portSuffix"
        } catch (_: Exception) {
            null
        }
    }

    private fun sessionCookieKey(cookieName: String, origin: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray(Charsets.UTF_8))
        val suffix = digest.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        return "${cookieName}_$suffix"
    }

    /** Called only while holding sessionCookieLock. */
    private fun readSessionOriginsLocked(): MutableSet<String> {
        return try {
            val stored = secureStore.get("session_cookie_origins") ?: return mutableSetOf()
            val json = JSONArray(stored)
            MutableList(json.length()) { index -> json.getString(index) }.toMutableSet()
        } catch (_: Exception) {
            mutableSetOf()
        }
    }

    private fun requireHttps(url: String) {
        check(Uri.parse(url).scheme.equals("https", ignoreCase = true)) {
            "Only HTTPS gateway URLs are supported"
        }
    }

    private fun requireWebUrl(url: String) {
        val scheme = Uri.parse(url).scheme
        check(scheme.equals("https", true) || scheme.equals("http", true)) {
            "Unsupported external URL scheme"
        }
    }

    fun close() {
        fetchExecutor.shutdownNow()
    }
}
