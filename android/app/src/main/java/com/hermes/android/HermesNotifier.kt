package com.hermes.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * 后台消息通知。
 *
 * 所有网关 WS 帧都流经原生层（NativeWebSocketBridge.onMessage，OkHttp 线程），
 * App 切后台后原生连接仍然活着，因此帧过滤与通知发送都放在这里做，
 * 不依赖 WebView 的 JS（后台时 JS 定时器会被挂起）。
 *
 * JS 侧职责（mobile-view.js）：
 *  - setNotifyEnabled：同步「更多」页的后台通知开关。
 *  - setNotifySessions：同步 runtime session id → {title, stored} 映射，
 *    用于通知标题与点按后跳回对应会话。
 *
 * 只在 App 处于后台且开关打开时才解析帧；前台路径只有两个布尔检查，
 * 不给高频流式帧增加额外开销。
 */
object HermesNotifier {

    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_REQUESTS = "requests"
    const val EXTRA_OPEN_SESSION = "open_session"

    @Volatile
    var enabled = true

    @Volatile
    var backgrounded = false

    @Volatile
    var appContext: Context? = null

    // runtime session id → (title, storedSessionId)
    private val sessionMeta = ConcurrentHashMap<String, Pair<String, String>>()

    private val requestMethods = setOf("approval", "clarify", "sudo", "secret")

    fun init(context: Context) {
        appContext = context.applicationContext
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val messages = NotificationChannel(
            CHANNEL_MESSAGES, "新回复", NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "切出应用后收到的 Agent 回复" }
        val requests = NotificationChannel(
            CHANNEL_REQUESTS, "需要处理", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "执行确认、提问、密码请求等需要你处理的服务端请求" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(messages)
            nm.createNotificationChannel(requests)
        }
    }

    /** JS 同步会话元数据：'{"<runtimeSid>":{"title":"…","stored":"…"}}'。 */
    @Synchronized
    fun setSessions(json: String) {
        sessionMeta.clear()
        try {
            val obj = JSONObject(json)
            for (key in obj.keys()) {
                val v = obj.optJSONObject(key) ?: continue
                sessionMeta[key] = Pair(v.optString("title", ""), v.optString("stored", ""))
            }
        } catch (_: Exception) {
            // 忽略畸形 JSON；下次 JS 同步会覆盖
        }
    }

    /** OkHttp 线程调用：前台直接返回；后台先做字符串嗅探，命中才解析 JSON。 */
    fun onFrame(frame: String) {
        if (!enabled || !backgrounded) return
        val looksRelevant = frame.contains("\"message.complete\"") ||
            frame.contains("approval.request") ||
            frame.contains("clarify.request") ||
            frame.contains("\"method\":\"approval\"") ||
            frame.contains("\"method\":\"clarify\"") ||
            frame.contains("\"method\":\"sudo\"") ||
            frame.contains("\"method\":\"secret\"")
        if (!looksRelevant) return
        try {
            val json = JSONObject(frame)
            val method = json.optString("method", "")
            if (json.has("id") && method in requestMethods) {
                // 服务端请求帧：{"id":..,"method":"approval","params":{..}}
                notifyRequest(method, json.optJSONObject("params") ?: JSONObject(), "")
                return
            }
            if (method != "event") return
            val params = json.optJSONObject("params") ?: return
            when (val type = params.optString("type", "")) {
                "message.complete" -> notifyMessage(params)
                "approval.request" -> notifyRequest("approval", params.optJSONObject("payload") ?: JSONObject(), "")
                "clarify.request" -> notifyRequest("clarify", params.optJSONObject("payload") ?: JSONObject(), "")
            }
        } catch (_: Exception) {
            // 畸形帧忽略
        }
    }

    private fun notifyMessage(params: JSONObject) {
        val payload = params.optJSONObject("payload") ?: return
        val text = payload.optString("text", "").trim()
        if (text.isEmpty() || payload.optString("status", "complete") == "error") return
        val sid = params.optString("session_id", "")
        val meta = sessionMeta[sid]
        val title = meta?.first?.takeIf { it.isNotBlank() } ?: "Hermes"
        val preview = text
            .replace(Regex("```[\\s\\S]*?```"), " [代码] ")
            .replace(Regex("[#*`>\\[\\]]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
        post(
            channel = CHANNEL_MESSAGES,
            id = sid.hashCode(),
            title = title,
            text = clamp(preview, 160),
            storedSid = meta?.second ?: ""
        )
    }

    private fun notifyRequest(method: String, params: JSONObject, fallback: String) {
        val what = when (method) {
            "approval" -> "执行确认"
            "clarify" -> "需要你的回答"
            "sudo" -> "需要管理员密码"
            else -> "需要提供信息"
        }
        val detail = params.optString("command", "")
            .ifEmpty { params.optString("description", "") }
            .ifEmpty { params.optString("question", "") }
            .ifEmpty { params.optString("prompt", "") }
            .ifEmpty { fallback }
        val requestId = params.optString("request_id", "")
        val sid = params.optString("session_id", "")
        val title = sessionMeta[sid]?.first?.takeIf { it.isNotBlank() }
        val key = requestId.ifEmpty { detail }
        post(
            channel = CHANNEL_REQUESTS,
            id = (key.ifEmpty { method }).hashCode() + 31,
            title = "${what}${title?.let { " · $it" } ?: ""}",
            text = clamp(detail, 120).ifEmpty { "请在应用内处理" },
            storedSid = sessionMeta[sid]?.second ?: ""
        )
    }

    private fun post(channel: String, id: Int, title: String, text: String, storedSid: String) {
        val context = appContext ?: return
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(EXTRA_OPEN_SESSION, storedSid)
        }
        val pending = PendingIntent.getActivity(
            context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.hermes_logo)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(id, notification)
        } catch (_: Exception) {
            // 通知失败不影响消息流
        }
    }

    fun cancelAll() {
        val context = appContext ?: return
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancelAll()
    }

    private fun clamp(s: String, n: Int): String {
        val t = s.trim()
        return if (t.length > n) t.take(n) + "…" else t
    }
}
