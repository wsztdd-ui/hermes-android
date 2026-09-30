package com.hermes.android

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import org.json.JSONObject
import java.util.ArrayDeque
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler
import java.io.ByteArrayInputStream
import java.security.SecureRandom
import android.util.Base64

/**
 * 主 Activity：全屏 WebView 壳，加载内置的 Desktop renderer 编译产物。
 *
 * DEBUG 模式（默认开）：把 WebView 的 console 日志 + 未捕获 JS 错误 + 资源加载
 * 错误显示到屏幕顶部，并写入 logcat，方便定位黑屏问题。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val TAG = "HermesAndroid"
        // WebViewAssetLoader 的虚拟域名：所有资产 URL 都映射到这个域下。
        const val APP_ASSET_HOST = "appassets.androidplatform.net"
        const val FILE_CHOOSER_REQUEST = 1001
        // 调试：设为 false 关闭屏幕上的错误显示（发布版应为 false）
        const val DEBUG_OVERLAY = false
    }

    private lateinit var webView: WebView
    private lateinit var bridge: MobileBridge
    private lateinit var assetLoader: WebViewAssetLoader
    private lateinit var debugLabel: TextView
    private val recentLogLines = ArrayDeque<String>()
    private val recentLogLock = Any()
    private var pendingAudioPermissionRequest: PermissionRequest? = null
    private val audioPermissionRequestCode = 2301
    private var startupWatchGeneration = 0
    private val bridgeCapability: String by lazy {
        ByteArray(32).also { SecureRandom().nextBytes(it) }
            .let { Base64.encodeToString(it, Base64.NO_WRAP or Base64.URL_SAFE) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge + 手动内边距：把系统栏（状态栏/导航条/刘海）让出来。
        // 此前 CSS 依赖 env(safe-area-inset-*)，但 WebView 未启用 edge-to-edge，
        // env() 恒为 0，导致底部输入区被手势导航条遮挡。
        // 注意：必须在 setContentView 之前关闭 decorFits，否则 DecorView 先消费
        // insets，子 view 只会收到全零。
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        debugLabel = findViewById(R.id.debug_label)
        findViewById<Button>(R.id.splash_retry).setOnClickListener {
            beginStartupWatch("正在重新加载移动工作台…")
            webView.reload()
        }

        val root = findViewById<android.view.View>(android.R.id.content)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val bars = insets.getInsets(
                androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                androidx.core.view.WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            val bottom = maxOf(bars.bottom, ime.bottom)
            // Resize the content container, rather than only padding WebView's
            // drawing area. This makes Chromium's visual/layout viewport end
            // above the IME and system navigation bar, so fixed composers and
            // footers can actually move into the visible area.
            root.setPadding(bars.left, bars.top, bars.right, bottom)
            log("insets: top=${bars.top} bottom=${bars.bottom} ime=${ime.bottom} left=${bars.left} right=${bars.right}")
            insets
        }
        root.requestApplyInsets()

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", AssetsPathHandler(this))
            .build()

        configureWebView()

        bridge = MobileBridge(this, webView, bridgeCapability)
        webView.addJavascriptInterface(bridge, "__hermesMobileRaw")

        // 原生 WebSocket 桥：绕过 WebView JS WebSocket 的 Origin 检查
        val wsBridge = NativeWebSocketBridge(webView, bridgeCapability)
        webView.addJavascriptInterface(wsBridge, "__hermesWsNativeRaw")

        // 后台消息通知：渠道初始化 + API 33+ 运行时权限（一次性请求，不循环打扰）
        HermesNotifier.init(this)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), notifyPermissionCode)
        }

        // 仅在 debug 包开启远程调试；release 包禁止 DevTools 暴露会话数据。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        }

        log("加载 assets/www/index.html ...")
        beginStartupWatch("正在加载移动工作台…")
        webView.loadUrl("https://$APP_ASSET_HOST/assets/www/index.html")
        pendingOpenSession = intent?.getStringExtra(HermesNotifier.EXTRA_OPEN_SESSION)
    }

    private var pendingOpenSession: String? = null
    private val notifyPermissionCode = 2401

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pendingOpenSession = intent.getStringExtra(HermesNotifier.EXTRA_OPEN_SESSION)
        maybeOpenPendingSession()
    }

    /** 通知点按：跳回对应会话（JS 尚未就绪时退避重试）。 */
    private fun maybeOpenPendingSession(attempt: Int = 0) {
        val sid = pendingOpenSession ?: return
        if (attempt > 40) {
            pendingOpenSession = null
            return
        }
        webView.evaluateJavascript(
            "typeof window.__hermesMV?.openSession === 'function' && window.__hermesMV.openSession(${JSONObject.quote(sid)}) ? 'ok' : 'no'",
        ) { result ->
            if (result == "\"ok\"") {
                pendingOpenSession = null
            } else {
                webView.postDelayed({ maybeOpenPendingSession(attempt + 1) }, 500L)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        HermesNotifier.backgrounded = false
        HermesNotifier.cancelAll()
        maybeOpenPendingSession()
    }

    override fun onPause() {
        HermesNotifier.backgrounded = true
        super.onPause()
    }

    private fun log(msg: String) {
        if (!BuildConfig.DEBUG) return
        Log.d(TAG, msg)
        synchronized(recentLogLock) {
            recentLogLines.addLast("${java.time.LocalTime.now().withNano(0)} $msg")
            while (recentLogLines.size > 250) recentLogLines.removeFirst()
        }
        if (!DEBUG_OVERLAY) return
        runOnUiThread {
            val cur = debugLabel.text.toString()
            val lines = cur.lines().takeLast(12).joinToString("\n")
            debugLabel.text = if (lines.isEmpty()) msg else "$lines\n$msg"
            debugLabel.visibility = android.view.View.VISIBLE
        }
    }

    internal fun recentLogs(): List<String> = synchronized(recentLogLock) {
        recentLogLines.toList()
    }

    private fun isAppAssetOrigin(uri: Uri): Boolean =
        uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(APP_ASSET_HOST, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443)

    private fun isAppIndex(uri: Uri): Boolean =
        isAppAssetOrigin(uri) && uri.path == "/assets/www/index.html" && uri.query == null

    /** Only the top-level, app-owned HTML response receives the per-process bridge capability. */
    private fun bridgeBootstrapScript(): String {
        val key = JSONObject.quote(bridgeCapability)
        return """<script>
            (() => {
              if (window !== window.top) return;
              const capability = $key;
              const bind = (raw, methods) => Object.freeze(Object.fromEntries(
                methods.map(name => [name, (...args) => raw[name](capability, ...args)])));
              Object.defineProperty(window, '__hermesMobile', { value: bind(window.__hermesMobileRaw, [
                'getRecentLogs', 'revealLogs', 'secureToken', 'login', 'loginAsync',
                'clearSession', 'hasSessionFor', 'clearSessionFor', 'setNotifyEnabled',
                'setNotifySessions', 'setNotifyPreviewEnabled', 'saveFileBase64', 'nativeFetch', 'nativeFetchAsync',
                'openExternal', 'saveImage'
              ]), configurable: false, writable: false });
              Object.defineProperty(window, '__hermesWsNative', { value: bind(window.__hermesWsNativeRaw, [
                'nativeWsConnect', 'nativeWsSend', 'nativeWsClose'
              ]), configurable: false, writable: false });
            })();
            </script>""".trimIndent()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mediaPlaybackRequiresUserGesture = false
        settings.setTextZoom(100)
        // The mobile layout is sized for the device viewport. Allowing WebView
        // pinch zoom makes its CSS geometry drift from the fixed mobile chrome.
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.javaScriptCanOpenWindowsAutomatically = false

        webView.setBackgroundColor(Color.parseColor("#0d1117"))

        // 关闭 WebView 原生的边缘 stretch/glow 效果：列表滚到边界的橡皮筋回弹
        // 由它产生，CSS 的 overscroll-behavior 管不到这一层。
        webView.overScrollMode = android.view.View.OVER_SCROLL_NEVER

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(webView, true)
        cm.flush()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                if (request.isForMainFrame && isAppIndex(request.url)) {
                    val html = assets.open("www/index.html").bufferedReader(Charsets.UTF_8).use { it.readText() }
                    val protectedHtml = html.replaceFirst("<head>", "<head>${bridgeBootstrapScript()}")
                    return WebResourceResponse(
                        "text/html", "UTF-8",
                        ByteArrayInputStream(protectedHtml.toByteArray(Charsets.UTF_8))
                    )
                }
                val resp = assetLoader.shouldInterceptRequest(request.url)
                if (resp == null) {
                    val url = request.url.toString()
                    // 只对 app 域内的失败记录日志
                    if (url.contains(APP_ASSET_HOST)) {
                        log("资源未命中: ${request.url.path}")
                    }
                }
                return resp
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val uri = request.url
                return if (isAppAssetOrigin(uri)) {
                    false
                } else {
                    if (request.isForMainFrame && (uri.scheme == "https" || uri.scheme == "http")) {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                        } catch (_: Exception) {
                            log("无法打开外部链接")
                        }
                    }
                    true
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: android.webkit.WebResourceError
            ) {
                if (request.isForMainFrame) {
                    log("主框架加载错误: ${error.errorCode} ${error.description} @ ${request.url}")
                }
                super.onReceivedError(view, request, error)
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                log("页面加载完成: $url")
                // Keep the branded splash over the brief React boot gap. Hiding
                // immediately at onPageFinished exposed a black/empty WebView
                // while the module graph and recovery UI were still mounting.
                waitForFirstPaint(view)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                val level = when (consoleMessage.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> "ERROR"
                    ConsoleMessage.MessageLevel.WARNING -> "WARN"
                    else -> "INFO"
                }
                log("[$level] ${consoleMessage.message()} (${consoleMessage.sourceId()}:${consoleMessage.lineNumber()})")
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                val permissionRequest = request ?: return
                val audioResource = PermissionRequest.RESOURCE_AUDIO_CAPTURE
                log("WebView permission requested: ${permissionRequest.resources?.joinToString()}")
                // 只允许用户触发的麦克风采集；摄像头等未支持资源不授权。
                if (!isAppAssetOrigin(permissionRequest.origin) ||
                    permissionRequest.resources?.contentEquals(arrayOf(audioResource)) != true
                ) {
                    permissionRequest.deny()
                    return
                }
                runOnUiThread {
                    if (androidx.core.content.ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            android.Manifest.permission.RECORD_AUDIO
                        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                    ) {
                        log("Granting WebView microphone capture")
                        permissionRequest.grant(arrayOf(audioResource))
                    } else if (pendingAudioPermissionRequest != null) {
                        permissionRequest.deny()
                    } else {
                        pendingAudioPermissionRequest = permissionRequest
                        androidx.core.app.ActivityCompat.requestPermissions(
                            this@MainActivity,
                            arrayOf(android.Manifest.permission.RECORD_AUDIO),
                            audioPermissionRequestCode
                        )
                    }
                }
            }

            // 启用 window.prompt（登录用），避免用原生 Dialog 阻塞 JS 桥线程
            override fun onJsPrompt(
                view: WebView?,
                url: String?,
                message: String?,
                defaultValue: String?,
                result: android.webkit.JsPromptResult?
            ): Boolean {
                if (url == null || !isAppAssetOrigin(Uri.parse(url))) {
                    result?.cancel()
                    return true
                }
                // 用原生 AlertDialog 显示 prompt
                val builder = android.app.AlertDialog.Builder(this@MainActivity)
                builder.setTitle(message ?: "")
                val input = android.widget.EditText(this@MainActivity).apply {
                    setText(defaultValue ?: "")
                    if (message?.contains("password", true) == true) {
                        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                    }
                }
                builder.setView(input)
                builder.setPositiveButton("OK") { _, _ ->
                    result?.confirm(input.text.toString())
                }
                builder.setNegativeButton("Cancel") { _, _ ->
                    result?.cancel()
                }
                builder.setOnCancelListener {
                    result?.cancel()
                }
                builder.show()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                // 取消上一次未完成的选择，避免把 Uri 回调交给错误的页面请求。
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                var intent: Intent? = null
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    intent = fileChooserParams.createIntent()
                }
                if (intent == null) {
                    intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP &&
                    fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                ) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), FILE_CHOOSER_REQUEST)
                } catch (_: Exception) {
                    filePathCallback.onReceiveValue(null)
                    return false
                }
                return true
            }
        }
    }

    @Deprecated("WebView microphone access uses the Android runtime permission dialog")
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != audioPermissionRequestCode) return
        val request = pendingAudioPermissionRequest
        pendingAudioPermissionRequest = null
        if (request == null) return
        if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            log("Android microphone permission granted; granting WebView capture")
            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            log("Android microphone permission denied")
            request.deny()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val uris: Array<Uri>? = if (resultCode == RESULT_OK && data != null) {
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            } else {
                null
            }
            filePathCallback?.onReceiveValue(uris)
            filePathCallback = null
        }
    }

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private fun beginStartupWatch(message: String) {
        val splash = findViewById<android.view.View>(R.id.splash)
        val status = findViewById<TextView>(R.id.splash_status)
        val retry = findViewById<Button>(R.id.splash_retry)
        val generation = ++startupWatchGeneration
        status.text = message
        retry.visibility = android.view.View.GONE
        splash.postDelayed({
            if (generation == startupWatchGeneration && splash.visibility == android.view.View.VISIBLE) {
                status.text = "正在准备界面资源…"
            }
        }, 8000L)
        splash.postDelayed({
            if (generation == startupWatchGeneration && splash.visibility == android.view.View.VISIBLE) {
                status.text = "正在恢复会话并连接网关…"
            }
        }, 18000L)
        splash.postDelayed({
            if (generation == startupWatchGeneration && splash.visibility == android.view.View.VISIBLE) {
                status.text = "启动时间较长。请检查网络，或重新加载。"
                retry.visibility = android.view.View.VISIBLE
            }
        }, 30000L)
    }

    private fun hideSplash() {
        runOnUiThread {
            val splash = findViewById<android.view.View>(R.id.splash)
            splash?.animate()
                ?.alpha(0f)
                ?.setDuration(350)
                ?.withEndAction { splash.visibility = android.view.View.GONE }
                ?.start()
        }
    }

    private fun waitForFirstPaint(view: WebView, attempt: Int = 0) {
        if (attempt >= 180) {
            hideSplash()
            return
        }
        view.evaluateJavascript(
            // 移动视图（独立自渲染层）或 renderer chrome / 恢复卡 / 登录层任一出现即认为可交互
            "Boolean(document.querySelector('[data-hermes-mobile-view], .hermes-mobile-topbar, [data-boot-failure-card], [data-hermes-login-overlay], input[type=password]'))",
        ) { result ->
            if (result == "true") {
                hideSplash()
            } else {
                view.postDelayed({ waitForFirstPaint(view, attempt + 1) }, 100L)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        webView.evaluateJavascript("Boolean(window.__hermesAndroidBack?.())") { handled ->
            if (handled == "true") return@evaluateJavascript
            if (webView.canGoBack()) webView.goBack() else finish()
        }
    }

    override fun onDestroy() {
        bridge.close()
        webView.destroy()
        super.onDestroy()
    }
}
