// Hermes Desktop → Web 远程网关桥
// ---------------------------------------------------------------------------
// 复刻 Electron preload 暴露的 `window.hermesDesktop` 的核心契约，让官方
// Desktop renderer 可以在纯浏览器 / Android WebView 里运行，直连任意可配置
// 的远程 hermes gateway（不绑定后端）。
//
// 该文件会被构建进 renderer 产物（在 renderer 的入口模块之前执行），
// 覆盖其原本对 Electron `contextBridge` 的依赖。
//
// 依赖的外部对象（由 Android WebView 壳或浏览器环境提供）：
//   window.__hermesMobile  —— Android WebView 的 native 桥（可选）
//     { secureToken:{get,set,del}, saveFile, selectFile, openExternal, ... }
//   localStorage / IndexedDB —— 连接注册表持久化
//
// 协议（来自官方源码，已核实）：
//   REST: fetch(baseUrl+path, { method, headers: {X-Hermes-Session-Token|Authorization} })
//   WS:   {ws|wss}://host{prefix}/api/ws?token=|ticket=<enc>
// ---------------------------------------------------------------------------

/* global window, document, navigator, localStorage, fetch, AbortController, URL */

const DB_KEY = 'hermes:mobile:registry'
const DB_KEY_META = 'hermes:mobile:meta'

// 调试日志开关：true 时输出桥层内部日志（开发调试用），false 时静默（正式版）。
// 日志仍会进 logcat（console.log），但不污染用户界面。
const BRIDGE_DEBUG = false

function bridgeLog(...args) {
  if (BRIDGE_DEBUG) console.log('[hermes-bridge]', ...args)
}

function bridgeWarn(...args) {
  console.warn('[hermes-bridge]', ...args)
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function makeId() {
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 标准化 baseUrl：去掉末尾斜杠、hash、search。 */
function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    const u = new URL(value)
    u.hash = ''
    u.search = ''
    u.pathname = u.pathname.replace(/\/+$/, '')
    return u.toString().replace(/\/+$/, '')
  } catch {
    return value.replace(/\/+$/, '')
  }
}

/** buildGatewayWsUrl —— 与官方 connection-config.ts 一致。 */
function buildGatewayWsUrl(baseUrl, token) {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return `${wsScheme}://${parsed.host}${prefix}/api/ws?token=${encodeURIComponent(token)}`
}

function buildGatewayWsUrlWithTicket(baseUrl, ticket) {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return `${wsScheme}://${parsed.host}${prefix}/api/ws?ticket=${encodeURIComponent(ticket)}`
}

// Android must keep secrets in the native Keystore bridge. Browser-only previews
// can use localStorage, but an Android bridge failure must never store plaintext.
// 原生桥是扁平的 JSBridge 方法：__hermesMobile.secureToken(method, key, value)
// 返回 "ok" / 明文值 / ""（未找到）；也兼容可选的对象嵌套形式 {get,set,del}。

function mobileSecureCall(method, key, value) {
  const m = window.__hermesMobile
  if (m) {
    // 扁平 JSBridge 形式
    if (typeof m.secureToken === 'function') {
      try {
        return m.secureToken(method, key, value ?? '')
      } catch {
        return null
      }
    }
    // 对象嵌套形式（若未来实现）
    if (typeof m.secureToken === 'object' && m.secureToken !== null) {
      try {
        const fn = m.secureToken[method]
        if (typeof fn === 'function') return fn(key, value)
      } catch {
        return null
      }
    }
  }
  return null
}

function mobileSessionMatches(remoteUrl) {
  const mobile = window.__hermesMobile
  if (typeof mobile?.hasSessionFor === 'function') {
    try { return Boolean(mobile.hasSessionFor(remoteUrl)) } catch { return false }
  }
  const savedOrigin = mobileSecureCall('get', 'session_cookie_origin', null)
  if (!savedOrigin || !remoteUrl) return false
  try {
    return new URL(savedOrigin).origin === new URL(remoteUrl).origin
  } catch {
    return false
  }
}

async function secureGet(key) {
  const v = mobileSecureCall('get', key, null)
  if (typeof v === 'string' && v && !v.startsWith('error:')) return v
  if (window.__hermesMobileRaw || /\bAndroid\b/i.test(navigator.userAgent)) {
    if (v === null || (typeof v === 'string' && v.startsWith('error:'))) return null
    // Upgrade plaintext secrets written by older versions before using them.
    try {
      const legacy = localStorage.getItem(`hermes:secret:${key}`)
      if (!legacy) return null
      if (mobileSecureCall('set', key, legacy) !== 'ok') return null
      localStorage.removeItem(`hermes:secret:${key}`)
      return legacy
    } catch { return null }
  }
  try {
    return localStorage.getItem(`hermes:secret:${key}`)
  } catch {
    return null
  }
}

async function secureSet(key, value) {
  const r = mobileSecureCall('set', key, value)
  if (r === 'ok') {
    try { localStorage.removeItem(`hermes:secret:${key}`) } catch {}
    return
  }
  if (window.__hermesMobileRaw || /\bAndroid\b/i.test(navigator.userAgent)) {
    throw new Error('Android secure storage unavailable')
  }
  try {
    if (value == null) localStorage.removeItem(`hermes:secret:${key}`)
    else localStorage.setItem(`hermes:secret:${key}`, value)
  } catch {
    /* ignore */
  }
}

async function secureDel(key) {
  const r = mobileSecureCall('del', key, null)
  try { localStorage.removeItem(`hermes:secret:${key}`) } catch {}
  if ((window.__hermesMobileRaw || /\bAndroid\b/i.test(navigator.userAgent)) && r !== 'ok') {
    throw new Error('Android secure storage unavailable')
  }
}

// ── 连接注册表（多连接，持久化）────────────────────────────────────────────
// 对齐 Electron connections v2 registry: { version, primary, launchMode, lastUsed, connections[] }
// token 是 secret，用 secureStore 单独存，不放进明文 registry。

function loadRegistry() {
  try {
    const raw = localStorage.getItem(DB_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return { version: 2, primary: 'local', launchMode: 'primary', lastUsed: null, connections: [] }
}

function persistRegistry(reg) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(reg))
  } catch {
    /* ignore */
  }
}

let registry = loadRegistry()

function ensureLocalConnection() {
  if (!registry.connections.some(c => c.id === 'local')) {
    // local 仅作为占位：移动端没有本地 backend，语义上表示「未配置远程」。
    registry.connections.unshift({
      id: 'local',
      kind: 'local',
      label: 'This device',
      tokenSet: false,
      tokenPreview: null,
      url: ''
    })
    persistRegistry(registry)
  }
}

// token 存于 secureStore，key = connection id；registry 里只存 tokenPreview / tokenSet
async function tokenFor(id) {
  return secureGet(`token:${id}`)
}

function registryPublicView() {
  return {
    version: registry.version || 2,
    primary: registry.primary || 'local',
    launchMode: registry.launchMode || 'primary',
    lastUsed: registry.lastUsed ?? null,
    secureTokenStorage: true,
    connections: registry.connections.map(c => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      url: c.url,
      authMode: c.authMode,
      org: c.org,
      host: c.host,
      user: c.user,
      port: c.port ?? null,
      keyPath: c.keyPath,
      remoteHermesPath: c.remoteHermesPath,
      remoteProfile: c.remoteProfile,
      tokenSet: Boolean(c.tokenSet),
      tokenPreview: c.tokenPreview ?? null,
      headerNames: c.headerNames ?? [],
      installId: c.installId
    }))
  }
}

function activeConnectionId() {
  ensureLocalConnection()
  if (registry.launchMode === 'last-used' && registry.lastUsed) return registry.lastUsed
  return registry.primary || 'local'
}

function activeConnection() {
  const id = activeConnectionId()
  const exact = registry.connections.find(c => c.id === id)
  if (exact) return exact
  // primary/last-used 可能悬空（注册表迁移/重生成 id 后未同步）：回落到第一个
  // 有 URL 的远程连接，而不是 local 占位（url 为空 → 一切请求 Invalid URL，
  // status stays disconnected and the login layer cannot be reached.
  const usable = registry.connections.find(c => c.kind === 'remote' && String(c.url || '').trim())
  return usable || registry.connections.find(c => c.id === 'local') || null
}

// ── REST API（对 hermes:api 的复刻）────────────────────────────────────────
//
// 关键：Android WebView 页面跑在虚拟域名 `appassets.androidplatform.net` 下，
// 直接用浏览器 `fetch()` 请求远程 gateway 会被 CORS 拦截。Electron Desktop
// 走主进程 Node HTTP（无 CORS），所以这里也必须绕开浏览器 CORS：
//   优先用原生桥 `window.__hermesMobile.nativeFetch(url, opts)`（Kotlin 发请求，无 CORS），
//   回退到浏览器 `fetch()`（仅用于桌面浏览器调试，远程会 CORS 失败）。

const NO_NATIVE = '__hermes_no_native_fetch__'
let nativeFetchRequestId = 0
const nativeFetchPending = new Map()
let nativeLoginRequestId = 0
const nativeLoginPending = new Map()

if (typeof window !== 'undefined' && !window.__hermesMobileFetchResolve) {
  window.__hermesMobileFetchResolve = (id, payload) => {
    const pending = nativeFetchPending.get(id)
    if (!pending) return
    nativeFetchPending.delete(id)
    try { pending.resolve(JSON.parse(payload)) } catch (error) { pending.reject(error) }
  }
}

if (typeof window !== 'undefined' && !window.__hermesMobileLoginResolve) {
  window.__hermesMobileLoginResolve = (id, payload) => {
    const pending = nativeLoginPending.get(id)
    if (!pending) return
    nativeLoginPending.delete(id)
    try { pending.resolve(JSON.parse(payload)) } catch (error) { pending.reject(error) }
  }
}

async function doFetch(url, opts = {}) {
  const m = window.__hermesMobile
  const usingAsyncNative = Boolean(m && typeof m.nativeFetchAsync === 'function')
  const usingNative = Boolean(m && typeof m.nativeFetch === 'function')
  bridgeLog('doFetch:', opts.method || 'GET', url, usingNative ? '(native)' : '(browser fetch)')
  const payload = JSON.stringify({
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body || null,
    cookieScope: opts.cookieScope || null
  })
  if (usingAsyncNative) {
    const requestId = ++nativeFetchRequestId
    const result = await new Promise((resolve, reject) => {
      nativeFetchPending.set(requestId, { resolve, reject })
      try { m.nativeFetchAsync(url, payload, requestId) } catch (error) {
        nativeFetchPending.delete(requestId); reject(error)
      }
    })
    if (result && result !== NO_NATIVE) {
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      return { status: parsed.status, text: typeof parsed.body === 'string' ? parsed.body : '', ok: parsed.status >= 200 && parsed.status < 300, error: parsed.error || null }
    }
  }
  if (usingNative) {
    const result = await m.nativeFetch(
      url,
      payload
    )
    // 原生返回 { status, body, error } JSON 字符串
    if (result && result !== NO_NATIVE) {
      bridgeLog('nativeFetch 原始返回:', typeof result === 'string' ? result.slice(0, 120) : JSON.stringify(result))
      const parsed = typeof result === 'string' ? JSON.parse(result) : result
      return {
        status: parsed.status,
        text: typeof parsed.body === 'string' ? parsed.body : '',
        ok: parsed.status >= 200 && parsed.status < 300,
        error: parsed.error || null
      }
    }
  }
  // 回退：浏览器 fetch（受 CORS 约束）
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body || undefined,
    credentials: 'include'
  })
  return { status: res.status, text: await res.text(), ok: res.ok, error: null }
}

// ── 请求缓存（减少重复网络请求，加速启动）───────────────────────────────────
// GET 请求在缓存期内直接返回缓存，不重复发网络请求。
// 缓存键：method + path + body + connectionId（不同连接不共享缓存）
const apiCache = new Map() // key → { data, timestamp }
const CACHE_TTL_MS = 5000 // 5 秒内存缓存

// 持久缓存（localStorage）：下次打开时先读缓存，后台更新
const PERSIST_CACHE_KEY = 'hermes:api:cache'
const PERSIST_CACHE_TTL_MS = 60000 // 60 秒持久缓存

function cacheKey(request, conn) {
  return `${request?.method || 'GET'}:${request?.path}:${conn?.id}:${JSON.stringify(request?.body ?? {})}`
}

function getCached(request, conn) {
  const key = cacheKey(request, conn)
  const cached = apiCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    apiCache.delete(key)
    return null
  }
  return cached.data
}

function getPersistCache(request, conn) {
  try {
    const key = cacheKey(request, conn)
    const raw = localStorage.getItem(PERSIST_CACHE_KEY)
    if (!raw) return null
    const all = JSON.parse(raw)
    const cached = all[key]
    if (!cached) return null
    if (Date.now() - cached.timestamp > PERSIST_CACHE_TTL_MS) {
      delete all[key]
      localStorage.setItem(PERSIST_CACHE_KEY, JSON.stringify(all))
      return null
    }
    return cached.data
  } catch {
    return null
  }
}

function setCache(request, conn, data) {
  const key = cacheKey(request, conn)
  apiCache.set(key, { data, timestamp: Date.now() })
  // 限制缓存大小，避免内存泄漏
  if (apiCache.size > 200) {
    const oldest = [...apiCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
    apiCache.delete(oldest[0])
  }
  // 持久缓存关键端点
  const persistEndpoints = ['/api/profiles/sessions', '/api/config', '/api/profiles', '/api/status', '/api/model/info']
  if (persistEndpoints.some(p => request?.path?.startsWith(p))) {
    try {
      const raw = localStorage.getItem(PERSIST_CACHE_KEY) || '{}'
      const all = JSON.parse(raw)
      all[key] = { data, timestamp: Date.now() }
      localStorage.setItem(PERSIST_CACHE_KEY, JSON.stringify(all))
    } catch {
      // ignore
    }
  }
}

// 后台异步刷新缓存（不阻塞主流程）
async function refreshCache(request, conn) {
  if (!conn?.url) return
  const baseUrl = normalizeBaseUrl(conn?.url || normalizeBaseUrl(window.location.origin))
  const path = request?.path || '/'
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`

  const token = conn?.authMode === 'token' || !conn?.authMode ? await tokenFor(conn.id) : null
  const headers = { ...(conn?.headers || {}) }

  let body
  if (request?.body !== undefined && request?.body !== null) {
    body = JSON.stringify(request.body)
    headers['Content-Type'] = 'application/json'
  }

  if (conn?.authMode === 'oauth') {
    if (token) headers['Authorization'] = `Bearer ${token}`
  } else if (token) {
    headers['X-Hermes-Session-Token'] = token
  }

  try {
    const r = await doFetch(url, {
      method: request?.method || 'GET',
      headers,
      body,
      cookieScope: baseUrl
    })
    if (r.ok && r.text) {
      let result
      try {
        result = JSON.parse(r.text)
      } catch {
        result = r.text
      }
      setCache(request, conn, result)
    }
  } catch {
    // 后台刷新失败不影响主流程
  }
}

async function apiRequest(request) {
  const conn = activeConnection()
  if (!conn?.url) throw new Error('No remote gateway configured. Open Settings → Connections to add one.')

  // GET 请求：先查内存缓存，再查持久缓存
  if ((request?.method || 'GET') === 'GET' && !request?.upload) {
    const cached = getCached(request, conn)
    if (cached !== null) return cached
    const persistCached = getPersistCache(request, conn)
    if (persistCached !== null) {
      // 命中持久缓存：立即返回，同时后台刷新
      setCache(request, conn, persistCached)
      // 后台异步刷新（不等待）
      void refreshCache(request, conn)
      return persistCached
    }
  }

  const baseUrl = normalizeBaseUrl(conn?.url || normalizeBaseUrl(window.location.origin))
  const path = request?.path || '/'
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`

  const token = conn?.authMode === 'token' || !conn?.authMode ? await tokenFor(conn.id) : null
  const headers = { ...(conn?.headers || {}) }

  let body

  if (request?.upload) {
    // 原生桥不支持 multipart 时，这里降级（移动端附件上传后续处理）
    body = null
  } else if (request?.body !== undefined && request?.body !== null) {
    body = JSON.stringify(request.body)
    headers['Content-Type'] = 'application/json'
  }

  if (conn?.authMode === 'oauth') {
    if (token) headers['Authorization'] = `Bearer ${token}`
  } else if (token) {
    headers['X-Hermes-Session-Token'] = token
  }

  const r = await doFetch(url, {
    method: request?.method || 'GET',
    headers,
    body,
    cookieScope: baseUrl
  })

  if (r.error) {
    throw new Error(r.error)
  }
  if (!r.ok) {
    throw new Error(`${r.status}: ${r.text || 'error'}`)
  }
  if (!r.text) return null

  let result
  try {
    result = JSON.parse(r.text)
  } catch {
    result = r.text
  }

  // 缓存 GET 请求结果
  if ((request?.method || 'GET') === 'GET' && !request?.upload) {
    setCache(request, conn, result)
  }

  return result
}

// ── 连接解析（getConnection / getConnectionFor / getGatewayWsUrl）────────────

async function resolveConnection(profile, conn = activeConnection()) {

  // 移动端没有「本地 backend」：当激活连接是 local（占位）或没有任何
  // 带有效 url 的连接时，抛错让 renderer 走到 boot-failure 引导界面
  // （用户从中进入 Settings → Connections 添加远程连接）。
  const remoteUrl = normalizeBaseUrl(conn?.url || '')
  if (!remoteUrl || conn?.kind === 'local') {
    const err = new Error('No remote gateway configured. Open Settings → Connections to add one.')
    err.needsOauthLogin = false
    err.retryable = false
    throw err
  }

  const baseUrl = remoteUrl
  const token = (await tokenFor(conn.id)) || ''
  const authMode = conn?.authMode || 'token'
  bridgeLog('resolveConnection: conn.id=', conn?.id, 'authMode=', authMode, 'mode=', conn?.kind === 'local' ? 'local' : 'remote')
  // oauth 模式下 wsUrl 需要单次 ticket（连接前 mint），这里给占位；
  // renderer 会通过 resolveGatewayWsUrl → getGatewayWsUrl 拿新鲜 ticket。
  const wsUrl =
    authMode === 'oauth'
      ? buildGatewayWsUrlWithTicket(baseUrl, '')
      : buildGatewayWsUrl(baseUrl, token)

  return {
    baseUrl,
    isFullscreen: true,
    mode: conn?.kind === 'local' ? 'local' : 'remote',
    authMode,
    remoteHost: conn?.url ? new URL(baseUrl).host : undefined,
    remoteIdentity: conn?.label,
    remoteKind: conn?.kind === 'ssh' ? 'ssh' : conn?.kind === 'cloud' ? 'cloud' : 'url',
    nativeOverlayWidth: 0,
    source: conn?.kind === 'local' ? 'local' : 'settings',
    token,
    wsUrl,
    logs: [],
    profile: profile ?? null,
    connectionId: conn?.id,
    windowButtonPosition: null
  }
}

async function getConnection(profile) {
  return resolveConnection(profile)
}

async function getConnectionFor(payload) {
  const connectionId =
    payload && typeof payload === 'object' ? payload.connectionId : String(payload || '')
  if (connectionId && connectionId !== 'local') {
    const conn = registry.connections.find(c => c.id === connectionId)
    if (!conn) return resolveConnection(null)
    return resolveConnection(payload?.profile ?? null, conn)
  }
  return resolveConnection(payload?.profile ?? null)
}

async function getGatewayWsUrl(profile) {
  const conn = activeConnection()
  const baseUrl = normalizeBaseUrl(conn?.url || '')
  const authMode = conn?.authMode || 'token'

  // 空地址（local 占位/悬空连接）给出明确错误而非 URL 构造异常；
  // 移动视图对该文案渲染「去添加网关」直达入口。
  if (!baseUrl) throw new Error('No remote gateway configured')

  if (authMode === 'oauth') {
    // 门控模式：mint 单次 ws-ticket（需已登录的 session cookie，由原生层管理）
    bridgeLog('getGatewayWsUrl: authMode=oauth, minting ticket...')
    const ticket = await mintWsTicket(baseUrl)
    bridgeLog('getGatewayWsUrl: 拿到 ticket，长度', ticket.length)
    return buildGatewayWsUrlWithTicket(baseUrl, ticket)
  }

  bridgeLog('getGatewayWsUrl: authMode=', authMode, 'token 模式')
  const token = (await tokenFor(conn.id)) || ''
  return buildGatewayWsUrl(baseUrl, token)
}

async function getGatewayWsUrlFor(payload) {
  return getGatewayWsUrl(payload?.profile ?? null)
}

// OAuth/门控模式：通过已认证的 session cookie 调 /api/auth/ws-ticket 拿单次 ticket。
// 401/session_expired 时自动弹出登录层，登录成功后原地重试一次 mint，
// 避免用户被扔到 boot-failure 恢复页手动折腾。
async function mintWsTicket(baseUrl) {
  bridgeLog('mintWsTicket: POST', baseUrl + '/api/auth/ws-ticket')
  let r = await doFetch(`${baseUrl}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cookieScope: baseUrl
  })
  bridgeLog('mintWsTicket 结果:', JSON.stringify({ status: r.status, error: r.error, body: (r.text || '').slice(0, 80) }))
  if (r.status === 401) {
    // session 过期/失效：自动重登（用户刚取消过则先冷静 15 秒，不反复弹层）
    if (Date.now() - (lastLoginCancelAtByUrl.get(baseUrl) || 0) < 15000) {
      throw new Error('mint ws-ticket failed: HTTP 401 (登录已取消，稍后自动重试)')
    }
    bridgeLog('mintWsTicket: 401 session expired → 自动弹登录层')
    try {
      const loginResult = await oauthLoginConnectionConfig(baseUrl)
      if (loginResult?.connected) {
        bridgeLog('mintWsTicket: 重登成功，重试 mint')
        r = await doFetch(`${baseUrl}/api/auth/ws-ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cookieScope: baseUrl
        })
        bridgeLog('mintWsTicket 重试结果: status=', r.status)
      } else {
        bridgeLog('mintWsTicket: 用户取消登录')
      }
    } catch (e) {
      bridgeLog('mintWsTicket: 自动登录流程异常', String(e?.message || e))
    }
  }
  if (r.error) throw new Error(`mint ws-ticket failed: ${r.error}`)
  if (!r.ok) throw new Error(`mint ws-ticket failed: HTTP ${r.status}: ${r.text}`)
  const data = JSON.parse(r.text || '{}')
  let ticket = data?.ticket
  // 服务端返回的 ticket 值可能被双引号包裹（形如 "\"xxx\""），原因是 ticket 内含
  // 特殊字符。去掉首尾的双引号字符（不是 JSON 的引号，是值里的字面引号）。
  if (typeof ticket === 'string') {
    ticket = ticket.replace(/^"+|"+$/g, '')
  }
  if (!ticket || typeof ticket !== 'string') {
    throw new Error('Gateway did not return a WS ticket.')
  }
  bridgeLog('mint 最终 ticket 长度', ticket.length)
  return ticket
}

// ── connections registry API ────────────────────────────────────────────────

async function connectionsSave(payload) {
  ensureLocalConnection()
  const isEdit = Boolean(payload?.id)
  const id = payload?.id || makeId()

  const existing = registry.connections.find(c => c.id === id)
  const base = existing || {}

  const next = {
    ...base,
    id,
    kind: payload?.kind || 'remote',
    label: payload?.label || 'Connection',
    url: payload?.url !== undefined ? payload?.url : base.url,
    authMode: payload?.authMode || base.authMode || 'token',
    host: payload?.host !== undefined ? payload?.host : base.host,
    user: payload?.user !== undefined ? payload?.user : base.user,
    port: payload?.port !== undefined ? payload?.port : base.port,
    keyPath: payload?.keyPath !== undefined ? payload?.keyPath : base.keyPath,
    remoteHermesPath:
      payload?.remoteHermesPath !== undefined ? payload?.remoteHermesPath : base.remoteHermesPath,
    remoteProfile: payload?.remoteProfile !== undefined ? payload?.remoteProfile : base.remoteProfile,
    org: payload?.org !== undefined ? payload?.org : base.org
  }

  // token：明文存进 secureStore
  if (payload?.token !== undefined && payload?.token !== null) {
    await secureSet(`token:${id}`, payload.token)
    next.tokenSet = true
    next.tokenPreview = maskToken(payload.token)
  } else if (payload?.allowPlainTextToken === false) {
    // 省略即保留旧的
  }

  // headers：name → value(或 null 保留旧的)
  if (payload?.headers && typeof payload.headers === 'object') {
    let headerMap = { ...(base.headers || {}) }
    for (const [name, val] of Object.entries(payload.headers)) {
      if (val === null) continue // 保留旧值
      headerMap[name] = val
    }
    next.headers = headerMap
    next.headerNames = Object.keys(headerMap)
  }

  if (isEdit) {
    registry.connections = registry.connections.map(c => (c.id === id ? next : c))
  } else {
    registry.connections.push(next)
    // 第一个有 url 的远程连接自动成为 primary（否则 activeConnection 仍是 local 占位）
    if (next.kind !== 'local' && normalizeBaseUrl(next.url || '') && registry.primary === 'local') {
      registry.primary = next.id
      registry.lastUsed = next.id
    }
  }
  persistRegistry(registry)

  return { ok: true, connection: publicConnection(next), registry: registryPublicView() }
}

function publicConnection(c) {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    url: c.url,
    authMode: c.authMode,
    org: c.org,
    host: c.host,
    user: c.user,
    port: c.port ?? null,
    keyPath: c.keyPath,
    remoteHermesPath: c.remoteHermesPath,
    remoteProfile: c.remoteProfile,
    tokenSet: Boolean(c.tokenSet),
    tokenPreview: c.tokenPreview ?? null,
    headerNames: c.headerNames ?? [],
    installId: c.installId
  }
}

function maskToken(token) {
  const t = String(token || '')
  if (t.length <= 8) return `${t.slice(0, 2)}…`
  return `${t.slice(0, 4)}…${t.slice(-4)}`
}

async function connectionsRemove(id) {
  const removed = registry.connections.find(c => c.id === id)
  if (removed?.kind === 'remote' && removed.url) {
    let removedOrigin = ''
    try {
      const parsed = new URL(removed.url)
      if (parsed.protocol === 'https:') removedOrigin = parsed.origin
    } catch { /* Invalid URLs have no origin-scoped session to clear. */ }
    const originStillUsed = removedOrigin && registry.connections.some(c => {
      if (c.id === id || c.kind !== 'remote' || !c.url) return false
      try { return new URL(c.url).origin === removedOrigin } catch { return false }
    })
    if (removedOrigin && !originStillUsed && typeof window.__hermesMobile?.clearSessionFor === 'function') {
      window.__hermesMobile.clearSessionFor(removedOrigin)
    }
  }
  await secureDel(`token:${id}`)
  registry.connections = registry.connections.filter(c => c.id !== id)
  if (registry.primary === id) registry.primary = 'local'
  if (registry.lastUsed === id) registry.lastUsed = null
  persistRegistry(registry)
  return { ok: true, registry: registryPublicView() }
}

async function connectionsSetPrimary(id) {
  registry.primary = id
  persistRegistry(registry)
  return { ok: true, registry: registryPublicView() }
}

async function connectionsSetLaunchMode(mode) {
  registry.launchMode = mode
  persistRegistry(registry)
  return { ok: true, registry: registryPublicView() }
}

async function connectionsSetLastUsed(id) {
  registry.lastUsed = id
  persistRegistry(registry)
  return { ok: true, registry: registryPublicView() }
}

async function connectionsTest(id) {
  const conn = registry.connections.find(c => c.id === id)
  if (!conn) return { ok: false, error: 'Connection not found', reachable: false }
  const baseUrl = normalizeBaseUrl(conn.url || window.location.origin)
  try {
    const token = await tokenFor(id)
    const r = await doFetch(`${baseUrl}/api/status`, {
      method: 'GET',
      headers: {
        ...(conn.headers || {}),
        ...(token ? { 'X-Hermes-Session-Token': token } : {})
      },
      cookieScope: baseUrl
    })
    if (r.error) throw new Error(r.error)
    if (!r.ok) {
      return { ok: false, reachable: false, error: `HTTP ${r.status}` }
    }
    const data = JSON.parse(r.text || '{}')
    return {
      baseUrl,
      ok: true,
      reachable: true,
      version: data?.version ?? data?.hermes_version ?? null,
      host: new URL(baseUrl).host
    }
  } catch (e) {
    return { ok: false, reachable: false, error: String(e?.message || e) }
  }
}

// ── 图片 / 附件 ─────────────────────────────────────────────────────────────
// selectPaths 用 <input type=file>，把 File 转 data URL 存进 path→dataUrl 映射；
// readFileDataUrl(path) 从映射读取。用 File 的 name 作为稳定 key。

const fileMap = new Map() // path → dataUrl
let fileReadStatusTimer = null

function showFileReadStatus(message, dismissAfterMs = 0) {
  let status = document.querySelector('[data-hermes-mobile-file-read-status]')
  if (!status) {
    status = document.createElement('div')
    status.dataset.hermesMobileFileReadStatus = 'true'
    status.className = 'hermes-mobile-file-read-status'
    status.setAttribute('role', 'status')
    document.body.appendChild(status)
  }
  status.textContent = message
  if (fileReadStatusTimer) clearTimeout(fileReadStatusTimer)
  if (dismissAfterMs) fileReadStatusTimer = setTimeout(() => status.remove(), dismissAfterMs)
}

function formatMobileFileSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function selectPaths(options = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = Boolean(options.multiple)
    if (options.filters?.length) {
      const exts = options.filters.flatMap(f => f.extensions || []).map(e => `.${e}`)
      if (exts.length) input.accept = exts.join(',')
    }
    input.style.display = 'none'
    document.body.appendChild(input)

    input.addEventListener('change', async () => {
      const paths = []
      try {
        for (const file of Array.from(input.files || [])) {
          const key = `/mobile/${file.name}`
          const large = file.size >= 1024 * 1024
          if (large) showFileReadStatus(`正在读取 ${file.name}（${formatMobileFileSize(file.size)}）…`)
          const dataUrl = await fileToDataUrl(file, loaded => {
            if (large) showFileReadStatus(`正在读取 ${file.name}：${Math.round(loaded / file.size * 100)}%`)
          })
          fileMap.set(key, dataUrl)
          paths.push(key)
          if (large) showFileReadStatus(`已准备 ${formatMobileFileSize(file.size)} 文件，发送时请保持页面打开。`, 6500)
        }
        resolve(paths)
      } catch (error) {
        for (const path of paths) fileMap.delete(path)
        showFileReadStatus(`读取文件失败：${String(error?.message || '请重新选择')}`, 9000)
        resolve([])
      } finally {
        input.remove()
      }
    })

    // 取消
    const onCancel = () => {
      input.remove()
      resolve([])
    }
    input.addEventListener('cancel', onCancel)
    // input.click() 后不会触发 cancel 事件；用 window focus 兜底判断太脆弱，这里直接选完/超时无操作按 file input 标准即可。

    input.click()
  })
}

function fileToDataUrl(file, onProgress) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error || new Error('读取失败'))
    r.onprogress = event => {
      if (event.lengthComputable) onProgress?.(event.loaded)
    }
    r.readAsDataURL(file)
  })
}

document.addEventListener('click', event => {
  const button = event.target.closest?.('button[aria-label^="移除 "], button[aria-label^="Remove "]')
  const label = button?.getAttribute('aria-label') || ''
  const name = label.replace(/^(移除|Remove)\s+/, '')
  if (name) fileMap.delete(`/mobile/${name}`)
})

async function readFileDataUrl(filePath) {
  if (fileMap.has(filePath)) return fileMap.get(filePath)
  // 若是 data URL 直接返回
  if (typeof filePath === 'string' && filePath.startsWith('data:')) return filePath
  throw new Error(`File not found: ${filePath}`)
}

async function readFileDataUrlForAttach(filePath) {
  return readFileDataUrl(filePath)
}

async function readFileText(filePath) {
  const dataUrl = await readFileDataUrl(filePath)
  // data URL → text（只对文本有用）
  try {
    const b64 = dataUrl.split(',')[1]
    return { content: decodeURIComponent(escape(atob(b64))), truncated: false }
  } catch {
    return { content: '', truncated: true }
  }
}

// ── 其它轻量桥 ──────────────────────────────────────────────────────────────

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text))
    return true
  } catch {
    return false
  }
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

async function openExternal(url) {
  try {
    const m = window.__hermesMobile
    if (m && typeof m.openExternal === 'function') {
      await m.openExternal(url)
      return
    }
  } catch {
    /* ignore */
  }
  window.open(url, '_blank', 'noopener')
}

async function saveImageFromUrl(url) {
  const m = window.__hermesMobile
  if (m && typeof m.saveImage === 'function') {
    try {
      await m.saveImage(url)
      return
    } catch {
      /* ignore */
    }
  }
  // 回退：新标签打开
  window.open(url, '_blank')
}

async function saveGatewayFile(payload) {
  // 通过 data URL 映射读取并下载
  const dataUrl = fileMap.get(payload?.path)
  if (!dataUrl) return { canceled: true }
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = payload?.suggestedName || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  return { canceled: false }
}

async function notify(payload) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(payload?.title || 'Hermes', { body: payload?.body || '', silent: payload?.silent })
      return true
    }
    return false
  } catch {
    return false
  }
}

async function requestMicrophoneAccess() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true })
    return true
  } catch {
    return false
  }
}

// ── getConnectionConfig / save / apply / test（legacy 单连接兼容）──────────

async function getConnectionConfig(profile) {
  const conn = activeConnection()
  return {
    envOverride: false,
    mode: conn?.kind === 'local' ? 'local' : conn?.kind === 'cloud' ? 'cloud' : conn?.kind === 'ssh' ? 'ssh' : 'remote',
    profile: profile ?? null,
    remoteAuthMode: conn?.authMode || 'token',
      remoteOauthConnected: conn?.authMode === 'oauth' && mobileSessionMatches(conn?.url),
    remoteTokenPreview: conn?.tokenPreview ?? null,
    remoteTokenSet: Boolean(conn?.tokenSet),
    secureTokenStorage: true,
    remoteTokenPlainText: false,
    remoteUrl: conn?.url || '',
    cloudOrg: conn?.org || '',
    sshHost: conn?.host || '',
    sshUser: conn?.user || '',
    sshPort: conn?.port ?? null,
    sshKeyPath: conn?.keyPath || '',
    sshRemoteHermesPath: conn?.remoteHermesPath || '',
    sshRemoteProfile: conn?.remoteProfile || ''
  }
}

async function saveConnectionConfig(payload) {
  bridgeLog('saveConnectionConfig payload:', JSON.stringify({ mode: payload?.mode, remoteAuthMode: payload?.remoteAuthMode, remoteUrl: payload?.remoteUrl }))
  const firstRemoteConnection = registry.primary === 'local'
  const url = normalizeBaseUrl(payload?.remoteUrl || '')
  const kind =
    payload?.mode === 'ssh'
      ? 'ssh'
      : payload?.mode === 'cloud'
        ? 'cloud'
        : 'remote'

  // 找到一个已有的、匹配该 url 的连接（legacy 单连接语义），否则新建。
  const existing = registry.connections.find(
    c => c.kind !== 'local' && normalizeBaseUrl(c.url || '') === url && url
  )

  const id = existing?.id || makeId()
  const label = existing?.label || (url ? new URL(url).host : 'Remote')

  await connectionsSave({
    ...(existing ? { id } : {}),
    kind,
    label,
    url,
    authMode: payload?.remoteAuthMode,
    ...(payload?.remoteToken ? { token: payload.remoteToken } : {}),
    allowPlainTextToken: payload?.allowPlainTextToken
  })

  // 若当前 primary 仍是 local，切到这个新连接
  if (registry.primary === 'local') {
    registry.primary = id
    registry.lastUsed = id
    persistRegistry(registry)
  }

  // The desktop recovery overlay keeps its original boot failure after the
  // first remote is saved. Reload once so Android starts with the new gateway.
  if (firstRemoteConnection && document.querySelector('[data-boot-failure-overlay]')) {
    setTimeout(() => window.location.reload(), 500)
  }

  return getConnectionConfig(payload?.profile)
}

async function applyConnectionConfig(payload) {
  return saveConnectionConfig(payload)
}

async function testConnectionConfig(payload) {
  const baseUrl = normalizeBaseUrl(payload?.remoteUrl || '')
  if (!baseUrl) return { ok: false, reachable: false, error: 'No URL' }
  try {
    const r = await doFetch(`${baseUrl}/api/status`, {
      method: 'GET',
      headers: payload?.remoteToken ? { 'X-Hermes-Session-Token': payload.remoteToken } : {}
    })
    if (r.error) throw new Error(r.error)
    if (!r.ok) return { ok: false, reachable: false, error: `HTTP ${r.status}` }
    const data = JSON.parse(r.text || '{}')
    return { baseUrl, ok: true, reachable: true, version: data?.version ?? null, host: new URL(baseUrl).host }
  } catch (e) {
    return { ok: false, reachable: false, error: String(e?.message || e) }
  }
}

async function probeConnectionConfig(remoteUrl) {
  const baseUrl = normalizeBaseUrl(remoteUrl)
  if (!baseUrl) {
    return { baseUrl, reachable: false, authMode: 'unknown', providers: [], version: null, error: 'No URL' }
  }
  // 首次失败后延迟重试一次：移动网络/TLS 瞬时抖动很常见，
  // 避免一闪而过的不可达把用户卡在设置页（Test remote 禁用）。
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(res => setTimeout(res, 1500))
    try {
      const r = await doFetch(`${baseUrl}/api/status`, { method: 'GET', headers: {} })
      if (r.error) throw new Error(r.error)
      if (!r.ok) {
        // 5xx 值得重试；4xx（如认证拦截）不重试
        const retriable = r.status >= 500
        lastError = `HTTP ${r.status}`
        if (retriable && attempt === 0) continue
        return { baseUrl, reachable: false, authMode: 'unknown', providers: [], version: null, error: lastError }
      }
      const data = JSON.parse(r.text || '{}')

      // 认证方式判定（与 Electron connection-config 的 probe 一致）：
      //  - auth_providers 含 'basic' → 原生 PKCE/OAuth 流程（native_pkce）→ 'oauth'
      //  - 否则按 auth_required 判断 token/unknown
      const providers = Array.isArray(data.auth_providers) ? data.auth_providers : []
      const authMode = providers.includes('basic') ? 'oauth' : data.auth_required ? 'token' : 'unknown'

      return {
        baseUrl,
        reachable: true,
        authMode,
        providers: providers.map(p => ({ name: p, displayName: p, supportsPassword: p === 'basic' })),
        version: data.version ?? data.hermes_version ?? null,
        error: null
      }
    } catch (e) {
      lastError = String(e?.message || e)
    }
  }
  return {
    baseUrl,
    reachable: false,
    authMode: 'unknown',
    providers: [],
    version: null,
    error: lastError || 'probe failed'
  }
}

// 同一个 Gateway 的 renderer 与移动视图可能同时请求重登，复用同一 Promise，避免叠出两个登录框。
// 不同 Gateway 使用各自的流程，防止并发登录时把凭据提交到错误的地址。
const activeLoginFlows = new Map()
// 每个 Gateway 单独记录取消时间，避免一个连接的取消操作抑制另一个连接的登录。
const lastLoginCancelAtByUrl = new Map()

function oauthLoginConnectionConfig(remoteUrl) {
  const baseUrl = normalizeBaseUrl(remoteUrl)
  const active = activeLoginFlows.get(baseUrl)
  if (active) return active
  const flow = runOauthLoginConnectionConfig(baseUrl).finally(() => {
    if (activeLoginFlows.get(baseUrl) === flow) activeLoginFlows.delete(baseUrl)
  })
  activeLoginFlows.set(baseUrl, flow)
  return flow
}

async function runOauthLoginConnectionConfig(remoteUrl) {
  const baseUrl = normalizeBaseUrl(remoteUrl)
  if (!baseUrl) return { ok: false, baseUrl, connected: false }
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-hermes-login-overlay', '')
    // Explicitly allow pointer events because renderer dialogs and scroll locks
    // can set pointer-events:none on body.
    overlay.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;box-sizing:border-box;width:100%;height:var(--hermes-mobile-viewport-height,100dvh);display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.68);font-family:system-ui,sans-serif;pointer-events:auto'
    const card = document.createElement('form')
    card.style.cssText = 'box-sizing:border-box;width:min(460px,100%);max-height:calc(var(--hermes-mobile-viewport-height,100dvh) - 24px);display:flex;flex-direction:column;padding:20px;border:1px solid #334155;border-radius:16px;background:#111827;color:#e5e7eb;box-shadow:0 20px 60px #0008'
    const savedUser = (() => { try { return localStorage.getItem('hermes:login:username') || '' } catch { return '' } })()
    card.innerHTML = `<div data-login-fields style="min-height:0;overflow-y:auto;overscroll-behavior:contain"><h2 style="margin:0 0 8px;font-size:22px">Sign in to Hermes</h2><p style="margin:0 0 20px;color:#9ca3af;word-break:break-all">${baseUrl}</p><label style="display:block;margin:12px 0 6px">Username</label><input name="username" autocomplete="username" value="${savedUser.replace(/"/g, '&quot;')}" style="box-sizing:border-box;width:100%;padding:12px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:16px"><label style="display:block;margin:12px 0 6px">Password</label><div style="display:flex;gap:8px"><input name="password" type="password" autocomplete="current-password" style="box-sizing:border-box;flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#fff;font-size:16px"><button type="button" data-toggle style="padding:0 12px;border:1px solid #475569;border-radius:10px;background:#1e293b;color:#e5e7eb">Show</button></div><label style="display:flex;gap:8px;align-items:center;margin:14px 0;color:#cbd5e1;font-size:14px"><input name="remember" type="checkbox" ${savedUser ? 'checked' : ''}> Remember username on this device</label><div data-error style="min-height:22px;color:#f87171;font-size:14px"></div></div><div data-login-actions style="display:flex;flex-shrink:0;justify-content:flex-end;gap:10px;padding-top:12px;border-top:1px solid #334155"><button type="button" data-cancel style="padding:11px 16px;border:1px solid #475569;border-radius:10px;background:#1e293b;color:#e5e7eb">Cancel</button><button type="submit" data-submit style="padding:11px 18px;border:0;border-radius:10px;background:#4f86ff;color:#08111f;font-weight:700">Sign in</button></div>`
    overlay.appendChild(card); document.body.appendChild(overlay)
    const usernameInput = card.elements.namedItem('username')
    const passwordInput = card.elements.namedItem('password')
    const error = card.querySelector('[data-error]')
    const submit = card.querySelector('[data-submit]')
    const close = connected => {
      if (!connected) lastLoginCancelAtByUrl.set(baseUrl, Date.now())
      overlay.remove()
      resolve({ ok: connected, baseUrl, connected })
    }
    card.querySelector('[data-cancel]').addEventListener('click', () => close(false))
    card.querySelector('[data-toggle]').addEventListener('click', event => { passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password'; event.currentTarget.textContent = passwordInput.type === 'password' ? 'Show' : 'Hide' })
    card.addEventListener('submit', async event => {
      event.preventDefault(); const username = usernameInput.value.trim(); const password = passwordInput.value
      if (!username || !password) { error.textContent = 'Enter both username and password.'; return }
      submit.disabled = true; submit.textContent = 'Signing in…'; error.textContent = ''
      try {
        const mobile = window.__hermesMobile
        let result
        if (typeof mobile?.loginAsync === 'function') {
          result = await new Promise((resolve, reject) => {
            const requestId = ++nativeLoginRequestId
            nativeLoginPending.set(requestId, { resolve, reject })
            try { mobile.loginAsync(baseUrl, 'basic', username, password, requestId) }
            catch (cause) { nativeLoginPending.delete(requestId); reject(cause) }
          })
        } else if (typeof mobile?.login === 'function') {
          result = JSON.parse(mobile.login(baseUrl, 'basic', username, password))
        } else {
          const r = await doFetch(`${baseUrl}/auth/password-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username, password }) })
          result = { ok: r.ok, error: r.ok ? null : `Sign-in failed (HTTP ${r.status}): ${r.text || 'Unknown error'}` }
        }
        if (!result.ok) { error.textContent = result.error || 'Sign-in failed'; submit.disabled = false; submit.textContent = 'Sign in'; return }
        try { if (card.elements.namedItem('remember').checked) localStorage.setItem('hermes:login:username', username); else localStorage.removeItem('hermes:login:username') } catch {}
        close(true)
      } catch (e) { error.textContent = String(e?.message || e); submit.disabled = false; submit.textContent = 'Sign in' }
    })
  })
}

async function oauthLogoutConnectionConfig(remoteUrl) {
  const mobile = window.__hermesMobile
  // 未显式指定连接时（如上游设置页登出当前连接），只清当前远程连接的会话。
  // 不退回全量 clearSession：多 Gateway 下会把其它连接的登录态一并抹掉。
  let target = remoteUrl || ''
  if (!target) {
    const conn = activeConnection()
    const url = normalizeBaseUrl(conn?.url || '')
    if (conn?.kind !== 'local' && url) target = url
  }
  if (target && typeof mobile?.clearSessionFor === 'function') mobile.clearSessionFor(target)
  else if (typeof mobile?.clearSession === 'function') mobile.clearSession()
  else {
    mobileSecureCall('del', 'session_cookie_at', null)
    mobileSecureCall('del', 'session_cookie_provider', null)
    mobileSecureCall('del', 'session_cookie_origin', null)
  }
  return { ok: true }
}

// ── 组装 window.hermesDesktop ───────────────────────────────────────────────

// 事件订阅的通用 no-op 实现：返回一个 unsubscribe 函数。
// renderer 里这些 onXxx 可能被无保护直接调用（如 onPreviewFileChanged），
// 缺失会导致 TypeError 崩溃，所以必须提供。
const noopUnsubscribe = () => () => {}

// 兜底 Proxy：任何未显式实现的属性都返回安全默认值，从根上杜绝
// `undefined is not a function` / `undefined.xxx` 崩溃。
//
// 规则：
//   访问任意未定义属性 → 返回一个「安全函数」（可调用、返回 undefined）
//   或「安全对象」（任意深层访问都继续返回安全值）。
// 这样 renderer 里任何无保护的 `desktop.someMissingMethod(...)` 都不会崩。
// 关键：`then` 属性必须返回 undefined，否则 React/SWR 会把安全函数误判为
// Promise(thenable) 去 await，导致行为异常。

// 兜底：任何未显式实现的属性都返回一个「安全值」。
// 该安全值既是（可调用的）async 函数，又能被当对象访问任意属性（返回自身），
// 并正确返回 `then === undefined` 避免被误判为 Promise。
// 这样 renderer 里 `desktop.foo()` 和 `desktop.foo.bar.baz()` 都安全。
// 仅用于「缺失的顶层属性」，已存在的值原样返回，不干扰 React 渲染。

function makeSafeFn() {
  const fn = async () => undefined
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined
      if (prop === Symbol.toPrimitive) return () => '[object HermesDesktop]'
      if (prop === Symbol.iterator) return undefined
      if (prop === 'valueOf') return () => undefined
      if (prop === 'toString') return () => '[object HermesDesktop]'
      // 任意属性访问返回同一个安全值（可继续 .xxx 或 () 调用）
      return target
    },
    apply() {
      return Promise.resolve(undefined)
    },
    construct() {
      return makeSafeFn()
    }
  })
}

function buildBridge() {
  // 启动时确保 local 连接存在
  ensureLocalConnection()

  return {
    // 核心：连接解析 + RPC + WS URL
    getConnection,
    getConnectionFor,
    getGatewayWsUrl,
    getGatewayWsUrlFor,
    getAgentRoster: async () => {
      // 期望 DesktopAgentRoster：{ agents: [], sources: [{connectionId,label,kind,reachable}] }
      // 必须包含 agents 数组，否则 renderer 里 roster?.agents.filter(...) 崩
      // （fleet-rail.ts buildRestGroups → Cannot read properties of undefined (reading 'filter')）。
      const sources = registry.connections.map(c => ({
        connectionId: c.id,
        label: c.label,
        kind: c.kind,
        reachable: c.kind !== 'local'
      }))
      return { agents: [], sources }
    },
    getProfileRoutes: async profiles => {
      // 期望返回路由描述数组；无远程 route 时返回空（让调用方回退 local）。
      return []
    },
    api: apiRequest,
    revalidateConnection: async () => ({}),
    touchBackend: async () => ({}),
    setActiveConnectionRoute: async () => ({}),

    // 多连接注册表
    connections: {
      list: async () => registryPublicView(),
      save: connectionsSave,
      remove: connectionsRemove,
      setPrimary: connectionsSetPrimary,
      setLaunchMode: connectionsSetLaunchMode,
      setLastUsed: connectionsSetLastUsed,
      test: connectionsTest,
      updateManaged: async () => ({ ok: true, connection: null, registry: registryPublicView() }),
      updateAll: async () => ({ ok: true, results: [] }),
      onChanged: noopUnsubscribe
    },

    // legacy 连接配置
    getConnectionConfig,
    saveConnectionConfig,
    applyConnectionConfig,
    testConnectionConfig,
    probeConnectionConfig,
    oauthLoginConnectionConfig,
    oauthLogoutConnectionConfig,
    getSecretStorageEncryption: async () => ({ on: true }),
    setSecretStorageEncryption: async on => ({ on }),

    // profile
    profile: {
      get: async () => ({ profile: null }),
      remember: async name => ({ profile: name }),
      set: async name => ({ profile: name })
    },

    // 图片 / 附件
    selectPaths,
    readFileDataUrl,
    readFileDataUrlForAttach,
    readFileText,
    dataUrlReadMax: {
      get: async () => ({ defaultMaxMb: 10, maxBytes: 50 * 1024 * 1024, maxMb: 50 }),
      set: async () => ({ defaultMaxMb: 10, maxBytes: 50 * 1024 * 1024, maxMb: 50 })
    },
    saveImageFromUrl,
    saveGatewayFile,
    saveClipboardImage: async () => true,
    saveImageBuffer: async () => true,

    // 剪贴板 / 通知 / 外链
    writeClipboard,
    readClipboard,
    notify,
    openExternal,
    requestMicrophoneAccess,

    // ── 本地文件系统（移动端无本地 backend，全部空实现）────────────────────
    // 这些被 plugin-loader (runtime-loader.ts) 等启动路径直接调用，缺失会崩。
    readDir: async () => ({ entries: [] }),
    writeTextFile: async () => ({ ok: false }),
    trashPath: async () => ({ ok: false }),
    renamePath: async () => ({ ok: false }),
    watchPreviewFile: async () => ({ id: '' }),
    watchDirectory: async () => ({ id: '' }),
    stopPreviewFileWatch: async () => {},
    desktopPluginsRoot: async () => null,
    agentPluginsRoot: async () => null,
    readPluginSource: async () => ({ text: '', truncated: true }),
    installDesktopPlugin: async () => ({ ok: false, error: 'not supported' }),
    probePluginRepo: async () => ({ ok: false }),
    selectSavePath: async () => null,
    sanitizeWorkspaceCwd: async p => p,
    getPathForFile: () => '',

    // ── 事件订阅（onXxx → unsubscribe 函数）────────────────────────────────
    // 全部给 no-op，避免 undefined(...) 崩溃。
    onPreviewFileChanged: noopUnsubscribe,
    onBackendExit: noopUnsubscribe,
    onBootProgress: noopUnsubscribe,
    onBootstrapEvent: noopUnsubscribe,
    onWindowStateChanged: noopUnsubscribe,
    onPowerResume: noopUnsubscribe,
    onBatteryChanged: noopUnsubscribe,
    onConnectionApplied: noopUnsubscribe,
    onClosePreviewRequested: noopUnsubscribe,
    onFocusSession: noopUnsubscribe,
    onNotificationAction: noopUnsubscribe,
    onNotificationActivate: noopUnsubscribe,
    onContextMenuSpellcheck: noopUnsubscribe,
    onBrowserPopoutClosed: noopUnsubscribe,
    onDeepLink: noopUnsubscribe,
    onFoundInPage: noopUnsubscribe,
    onOpenFindBarRequested: noopUnsubscribe,
    onOpenFolderRequested: noopUnsubscribe,
    onOpenUpdatesRequested: noopUnsubscribe,
    onPreviewNav: noopUnsubscribe,

    // ── bootstrap / 状态（报告"已完成"）─────────────────────────────────────
    // DesktopBootProgress 要求完整字段。
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: 'ready',
      phase: 'ready',
      progress: 100,
      retryable: false,
      running: false,
      statusCode: null,
      timestamp: Date.now()
    }),
    // 注意：DesktopBootstrapState 要求完整字段，尤其 `log` 必须是数组，
    // 否则 DesktopInstallOverlay 里 `state.log.length` 会崩 (reading 'length')。
    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      setupChoice: null,
      unsupportedPlatform: null
    }),
    continueBootstrapLocal: async () => ({ ok: true }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: false }),
    getVersion: async () => ({ version: '0.0.0-mobile' }),
    getOnBattery: async () => false,

    // ── 窗口 / 原生（移动端无多窗口，空实现）────────────────────────────────
    openWindow: async () => {},
    openSessionWindow: async () => {},
    openSessionInTerminal: async () => {},
    openBrowserWindow: async () => {},
    openPreviewInBrowser: async () => {},
    openDir: async () => {},
    revealPath: async () => {},
    revealLogs: async () => {
      try { window.__hermesMobile?.revealLogs?.() } catch {}
    },
    getRecentLogs: async () => {
      try {
        const raw = window.__hermesMobile?.getRecentLogs?.()
        return Array.isArray(raw) ? raw : JSON.parse(raw || '[]')
      } catch { return [] }
    },
    setKeepAwake: async () => {},
    setTitleBarTheme: async () => {},
    setNativeTheme: async () => {},
    setTranslucency: async () => {},
    setActiveWork: async () => {},
    setDisableF12: async () => {},
    setPreviewShortcutActive: async () => {},
    signalDeepLinkReady: async () => {},
    claimAmbientCue: async () => true,
    reportRendererError: async () => {},
    resolveFavicon: async () => null,
    fetchLinkTitle: async () => null,
    reachPreviewUrl: async () => false,
    normalizePreviewTarget: async t => t,
    stopFindInPage: async () => {},
    contextMenuEdit: async () => {},
    contextMenuCopyImage: async () => {},
    contextMenuSpellcheck: async () => {},
    contextMenuGuestAddWord: async () => {},
    docsUrl: async () => '',
    installCommand: async () => '',
    gitRoot: async () => null,
    sshConfigHosts: async () => [],
    sshResolveHost: async () => null,

    // findInPage / git / terminal / themes / updates / zoom —— 空实现
    findInPage: { request: async () => {}, stop: async () => {} },
    updates: {
      check: async () => ({ supported: false, updateAvailable: false }),
      apply: async () => ({ ok: false, manual: true, command: '' }),
      getBranch: async () => ({ branch: 'main' }),
      setBranch: async () => ({ branch: 'main' }),
      onProgress: noopUnsubscribe
    },
    zoom: {
      get: async () => ({ level: 0, percent: 100 }),
      factor: () => 1,
      setPercent: () => {},
      onChanged: noopUnsubscribe
    },

    // 明确不支持 → 优雅降级（renderer 用 ?. 访问）
    glassSupported: false,
    translucencySupported: false,
    platform: 'android'
  }
}

// ── WebSocket 原生桥（绕过 Origin 校验）────────────────────────────────────
// Some gateways validate the WebSocket Origin against their configured host.
// WebView's JavaScript WebSocket sends
// `Origin: appassets.androidplatform.net`，导致 origin_mismatch 被拒。
// 因此对 gateway WS（/api/ws）走原生 OkHttp WebSocket（不发浏览器 Origin）。
//
// 实现：JS 侧实现 window.__hermesWs 事件接收器 + WebSocket 兼容适配器；
// 原生侧 NativeWebSocketBridge 通过 evaluateJavascript 推送事件。

function installNativeWebSocketBridge() {
  if (typeof window === 'undefined') return
  const native = window.__hermesWsNative
  bridgeLog('installNativeWebSocketBridge: __hermesWsNative =', native ? '存在' : '不存在', '| nativeWsConnect =', native && typeof native.nativeWsConnect)
  if (!native || typeof native.nativeWsConnect !== 'function') {
    bridgeLog('原生 WS 桥不可用，回退浏览器 WebSocket（会受 Origin 校验限制）')
    return
  }

  const NativeWebSocket = window.NativeWebSocket = window.NativeWebSocket || {}
  const emitMobileWsState = state => {
    window.__hermesMobileWsState = state
    window.dispatchEvent(new CustomEvent('hermes-mobile-ws-state', { detail: { state } }))
  }

  // 事件接收器：原生桥通过 evaluateJavascript 调这些方法
  window.__hermesWs = {
    onOpen(id) {
      const s = NativeWebSocket[id]
      if (s) {
        s.readyState = 1 // OPEN
        emitMobileWsState('open')
        s._emit('open', {})
      }
    },
    onMessage(id, encodedData) {
      const s = NativeWebSocket[id]
      if (s) {
        const data = decodeURIComponent(encodedData)
        s._emit('message', { data })
      }
    },
    onClose(id, code, reason) {
      const s = NativeWebSocket[id]
      if (s) {
        s.readyState = 3 // CLOSED
        emitMobileWsState('closed')
        s._emit('close', { code: code || 1006, reason: reason || '' })
        delete NativeWebSocket[id]
      }
    },
    onError(id, message) {
      const s = NativeWebSocket[id]
      if (s) {
        s.readyState = 3
        emitMobileWsState('error')
        s._emit('error', {})
        s._emit('close', { code: 1006, reason: message || '' })
        delete NativeWebSocket[id]
      }
    }
  }

  function NativeWsLike(url) {
    bridgeLog('NativeWsLike 构造，url=', url.split('?')[0])
    emitMobileWsState('connecting')
    this.url = url
    this.readyState = 0 // CONNECTING
    this._handlers = {}
    this._id = null
    const self = this
    // 建立原生连接
    try {
      this._id = native.nativeWsConnect(url)
      bridgeLog('nativeWsConnect 返回 id=', this._id)
      NativeWebSocket[this._id] = this
    } catch (e) {
      bridgeLog('nativeWsConnect 抛异常:', e?.message || e)
      // 连接失败 → 立即 error + close
      setTimeout(() => {
        self.readyState = 3
        emitMobileWsState('error')
        self._emit('error', {})
        self._emit('close', { code: 1006, reason: String(e?.message || e) })
      }, 0)
    }
  }

  NativeWsLike.prototype.addEventListener = function (type, handler) {
    if (!this._handlers[type]) this._handlers[type] = []
    this._handlers[type].push(handler)
  }
  NativeWsLike.prototype.removeEventListener = function (type, handler) {
    const list = this._handlers[type]
    if (list) {
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    }
  }
  NativeWsLike.prototype._emit = function (type, event) {
    // 补充 target，让 handler 兼容
    event.target = this
    for (const h of (this._handlers[type] || []).slice()) {
      try { h(event) } catch { /* ignore */ }
    }
  }
  NativeWsLike.prototype.send = function (data) {
    if (this._id != null) {
      native.nativeWsSend(this._id, String(data))
    }
  }
  NativeWsLike.prototype.close = function () {
    if (this._id != null) {
      native.nativeWsClose(this._id)
      this.readyState = 3
    }
  }

  // 保存浏览器原生 WebSocket，替换全局构造器
  const BrowserWebSocket = window.WebSocket

  function HermesWebSocket(url, protocols) {
    // 只对 gateway WS（/api/ws）走原生桥；其他用浏览器原生
    const isGatewayWs = typeof url === 'string' && /\/api\/ws($|\?)/.test(url)
    bridgeLog('new WebSocket 调用, isGatewayWs=', isGatewayWs, 'url=', typeof url === 'string' ? url.split('?')[0] : url)
    if (isGatewayWs) {
      return new NativeWsLike(url)
    }
    // 否则用浏览器原生 WebSocket（保持原行为）
    if (protocols !== undefined) {
      return new BrowserWebSocket(url, protocols)
    }
    return new BrowserWebSocket(url)
  }

  // 复制 WebSocket 的静态常量（OPEN/CLOSED/CONNECTING/CLOSING）
  HermesWebSocket.CONNECTING = 0
  HermesWebSocket.OPEN = 1
  HermesWebSocket.CLOSING = 2
  HermesWebSocket.CLOSED = 3
  HermesWebSocket.prototype = NativeWsLike.prototype

  window.WebSocket = HermesWebSocket
  bridgeLog('已安装原生 WebSocket 桥（gateway WS 走原生，绕 Origin 校验）')
}

// 挂载（不覆盖已存在的，例如真正的 Electron 环境）
if (typeof window !== 'undefined' && !window.hermesDesktop) {
  window.hermesDesktop = buildBridge()
  installNativeWebSocketBridge()
}
