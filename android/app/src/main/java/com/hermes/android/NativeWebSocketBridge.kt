package com.hermes.android

import android.webkit.JavascriptInterface
import android.webkit.WebView
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * 原生 WebSocket 桥。绕过 WebView JS WebSocket 的 Origin 检查问题：
 * Hermes 网关的 WS 要求 Origin 匹配绑定域名，而 WebView 的 JS WebSocket 会发
 * `Origin: appassets.androidplatform.net` 导致 origin_mismatch 被拒。
 * OkHttp 的原生 WS 不发浏览器 Origin（或可控制），等价还原 Electron/Node 行为。
 *
 * 消息流：
 *   JS → nativeWsConnect(url) 建立连接，返回 sessionId
 *   JS → nativeWsSend(sessionId, data) 发消息
 *   原生收到消息 → evaluateJavascript("window.__hermesWs.onMessage(<id>, encodeURIComponent(data))")
 *   原生 close/error → evaluateJavascript("window.__hermesWs.onClose(<id>, code, reason)")
 */
class NativeWebSocketBridge(private val webView: WebView) {

    companion object {
        const val TAG = "NativeWsBridge"
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // 不超时，长连接
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private val sockets = java.util.concurrent.ConcurrentHashMap<Int, WebSocket>()
    private var nextId = 0

    private fun postJs(js: String) {
        webView.post {
            // 注意：evaluateJavascript 传入纯 JS 代码，不需要 "javascript:" 前缀
            // （那是 loadUrl 的 scheme）。带前缀会导致代码无法执行，WS 事件回调失效。
            webView.evaluateJavascript(js, null)
        }
    }

    /** JS 调：建立 WS 连接，返回 sessionId（整数）。 */
    @JavascriptInterface
    fun nativeWsConnect(url: String): Int {
        val id = synchronized(this) { ++nextId }
        // OAuth tickets and token credentials can live in the query string.
        android.util.Log.d(TAG, "nativeWsConnect id=$id url=${url.substringBefore('?')}")
        val request = Request.Builder().url(url).build()
        val ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                android.util.Log.d(TAG, "onOpen id=$id code=${response.code}")
                postJs("window.__hermesWs && window.__hermesWs.onOpen($id);")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // Avoid a logcat write for every streamed event in release builds;
                // high-frequency agent output can otherwise add noticeable jank.
                if (BuildConfig.DEBUG) {
                    android.util.Log.d(TAG, "onMessage id=$id len=${text.length}")
                }
                // 后台通知：帧过滤/发送在原生层完成（前台时是两次布尔检查的开销）
                HermesNotifier.onFrame(text)
                // 用 encodeURIComponent 安全传递，避免引号/换行破坏 JS
                postJs("window.__hermesWs && window.__hermesWs.onMessage($id, encodeURIComponent(${jsonQuote(text)}));")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                android.util.Log.d(TAG, "onClosing id=$id code=$code reason=$reason")
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                android.util.Log.d(TAG, "onClosed id=$id code=$code reason=$reason")
                sockets.remove(id)
                postJs("window.__hermesWs && window.__hermesWs.onClose($id, $code, ${jsonQuote(reason)});")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                android.util.Log.d(TAG, "onFailure id=$id err=${t.message} respCode=${response?.code}")
                sockets.remove(id)
                val msg = t.message ?: "ws error"
                postJs("window.__hermesWs && window.__hermesWs.onError($id, ${jsonQuote(msg)});")
            }
        })
        sockets[id] = ws
        return id
    }

    /** JS 调：发文本消息。 */
    @JavascriptInterface
    fun nativeWsSend(id: Int, data: String): Boolean {
        val ws = sockets[id] ?: return false
        return ws.send(data)
    }

    /** JS 调：关闭连接。 */
    @JavascriptInterface
    fun nativeWsClose(id: Int) {
        sockets.remove(id)?.close(1000, "client close")
    }

    /** 把字符串安全地包成 JS 单引号字符串字面量。 */
    private fun jsonQuote(s: String): String {
        val escaped = s
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        return "'$escaped'"
    }
}
