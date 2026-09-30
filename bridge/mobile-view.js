// Hermes Android — 独立移动应用（单界面全功能）
// ---------------------------------------------------------------------------
// 设计目标：所有窗口尺寸始终使用本层自渲染的单一移动客户端。
// 底层 renderer 只提供网关桥与认证/恢复能力，不暴露为可切换的桌面界面。
//
// 数据面：
//   - RPC：/api/ws JSON-RPC（通道层移植自 apps/shared，含心跳/seq 重放）。
//     会话列表/收发/停止/中断走 RPC；`approval`/`clarify`/`sudo`/`secret`
//     服务端请求渲染为聊天内卡片并按 ServerRequestMap 契约应答（响应帧）。
//   - REST：dashboard HTTP API（/api/sessions、/api/skills、/api/tools/toolsets、
//     /api/mcp/servers、/api/cron/jobs、/api/config、/api/model/options、
//     /api/profiles、/api/files/upload …），走 window.hermesDesktop.api()
//     （原生 fetch 无 CORS，自动带会话 Cookie），scoped 路径显式附 profile。
//   - 附件：图片 image.attach_bytes(base64)，文本/其他 /api/files/upload 后
//     以服务器路径内联进 prompt（与参考实现同语义）。
//
// API fields follow the pinned Hermes renderer and Gateway contracts.
// ---------------------------------------------------------------------------

/* global window, document, localStorage, WebSocket, FileReader, Image */

(() => {
  if (typeof window === 'undefined' || !window.hermesDesktop) return
  if (window.__hermesMobileViewInstalled) return
  window.__hermesMobileViewInstalled = true

  const desktop = window.hermesDesktop
  const VIEW_KEY = 'hermes:mv:last-session'
  const DRAFT_KEY = 'hermes:mv:draft'
  const PROFILE_KEY = 'hermes:mv:profile'

  const MV_VERSION = '1.0.2'

  // 统一线性图标（Feather 风格）：stroke 跟随 currentColor，深浅主题自动适配
  const svgIcon = (paths, size = 22) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  const ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="9" x2="9" y2="9.01"/><line x1="13" y1="9" x2="13" y2="9.01"/><line x1="17" y1="9" x2="17" y2="9.01"/>',
    sessions: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    tasks: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    skills: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    more: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    files: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="13" x2="15" y2="13"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    back: '<polyline points="15 18 9 12 15 6"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
  }

  // ── 小工具 ──────────────────────────────────────────────────────────

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  const richText = source => {
    const raw = String(source ?? '')
    const parts = raw.split(/```(?:[\w-]*)\n?/)
    let html = ''
    for (let i = 0; i < parts.length; i++) {
      const seg = esc(parts[i])
      if (i % 2 === 1) {
        html += `<pre><code>${seg.replace(/\n$/, '')}</code></pre>`
      } else {
        html += seg
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(https?:\/\/[^\s<)"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      }
    }
    return html
  }

  const relTime = ts => {
    if (!ts) return ''
    let t = typeof ts === 'number' ? ts : Number(ts)
    if (!Number.isFinite(t) || t <= 0) {
      // ISO 字符串（cron next_run_at 等）
      const parsed = Date.parse(String(ts)) / 1000
      if (!Number.isFinite(parsed) || parsed <= 0) return ''
      t = parsed
    }
    let sec = Date.now() / 1000 - t
    if (Math.abs(sec) < 90) return sec <= 0 ? '即将' : '刚刚'
    const suffix = sec < 0 ? '后' : '前'
    sec = Math.abs(sec)
    if (sec < 3600) return `${Math.floor(sec / 60)} 分钟${suffix}`
    if (sec < 86400) return `${Math.floor(sec / 3600)} 小时${suffix}`
    if (sec < 172800) return suffix === '后' ? '明天' : '昨天'
    if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} 天${suffix}`
    const d = new Date(t * 1000)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }

  const clampText = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n)}…` : t
  }

  const draftKey = () => `${DRAFT_KEY}:${connId}`
  const readDraft = sid => {
    try { return JSON.parse(localStorage.getItem(`${draftKey()}:${sid}`) || 'null') } catch { return null }
  }
  const writeDraft = (sid, text) => {
    try {
      if (text) localStorage.setItem(`${draftKey()}:${sid}`, JSON.stringify(text))
      else localStorage.removeItem(`${draftKey()}:${sid}`)
    } catch { /* ignore */ }
  }

  const toast = (text, level = 'info', ttlMs = 3600) => {
    if (!ui?.toastHolder) return
    const item = el('div', 'hmv-toast', text)
    item.dataset.level = level
    ui.toastHolder.append(item)
    setTimeout(() => item.remove(), ttlMs)
  }

  // 两段确认按钮（WebView 无 confirm）：首次点变确认文案，3s 未点复位
  const armConfirm = (button, confirmText, onConfirm) => {
    button.addEventListener('click', () => {
      if (button.dataset.armed !== '1') {
        button.dataset.armed = '1'
        button.textContent = confirmText
        setTimeout(() => {
          if (button.dataset.armed === '1') {
            button.dataset.armed = '0'
            button.textContent = button.dataset.label || ''
          }
        }, 3000)
        return
      }
      onConfirm()
    })
    return button
  }

  // 简易输入对话框（替代 window.prompt / confirm）
  const promptDialog = (title, fields, onSubmit) => {
    const overlay = el('div', 'hmv-dialog-overlay')
    const form = el('form', 'hmv-dialog')
    form.append(el('h3', null, title))
    const inputs = []
    for (const f of fields) {
      const label = el('label', 'hmv-dialog-label', f.label)
      let input
      if (f.options) {
        input = el('select', 'hmv-dialog-input')
        for (const opt of f.options) {
          const o = el('option', null, opt.label)
          o.value = opt.value
          input.append(o)
        }
        if (f.value !== undefined) input.value = f.value
      } else {
        input = el('input', 'hmv-dialog-input')
        input.type = f.type || 'text'
        if (f.placeholder) input.placeholder = f.placeholder
        if (f.value !== undefined) input.value = f.value
      }
      if (f.name) input.dataset.field = f.name
      inputs.push({ field: f, input })
      form.append(label, input)
    }
    const err = el('div', 'hmv-dialog-error')
    const row = el('div', 'hmv-dialog-row')
    const cancel = el('button', 'hmv-dialog-btn', '取消')
    cancel.type = 'button'
    const ok = el('button', 'hmv-dialog-btn hmv-dialog-ok', '确定')
    ok.type = 'submit'
    row.append(cancel, ok)
    form.append(err, row)
    overlay.append(form)
    document.body.append(overlay)
    const close = () => overlay.remove()
    cancel.addEventListener('click', close)
    overlay.addEventListener('click', e => { if (e.target === overlay) close() })
    form.addEventListener('submit', e => {
      e.preventDefault()
      const values = {}
      for (const { field, input } of inputs) values[field.name || field.label] = input.value
      onSubmit(values, close, msg => { err.textContent = msg })
    })
    inputs[0]?.input.focus()
  }

  // 底部操作单
  const actionSheet = (title, actions) => {
    ui.sheet.replaceChildren()
    if (title) {
      const head = el('button', null, title)
      head.disabled = true
      head.style.opacity = '.6'
      ui.sheet.append(head)
    }
    for (const a of actions) {
      const btn = el('button', null, a.label)
      if (a.danger) btn.dataset.danger = 'true'
      if (a.confirm) {
        btn.dataset.label = a.label
        armConfirm(btn, a.confirm, () => { closeSheet(); a.onTap() })
      } else {
        btn.addEventListener('click', () => { closeSheet(); a.onTap() })
      }
      ui.sheet.append(btn)
    }
    const cancel = el('button', null, '取消')
    cancel.addEventListener('click', closeSheet)
    ui.sheet.append(cancel)
    ui.sheet.hidden = false
    ui.scrim.hidden = false
    requestAnimationFrame(() => ui.scrim.setAttribute('data-open', 'true'))
  }
  const closeSheet = () => {
    ui.sheet.hidden = true
    ui.scrim.removeAttribute('data-open')
    ui.scrim.hidden = true
  }

  const longPress = (target, handler) => {
    let timer = null
    let fired = false
    target.addEventListener('touchstart', () => {
      fired = false
      timer = setTimeout(() => { fired = true; handler() }, 550)
    }, { passive: true })
    const clear = () => { clearTimeout(timer) }
    target.addEventListener('touchend', clear, { passive: true })
    target.addEventListener('touchmove', clear, { passive: true })
    target.addEventListener('touchcancel', clear, { passive: true })
    target.addEventListener('contextmenu', event => { if (fired) event.preventDefault() })
  }

  // ── JSON-RPC 通道（移植自 apps/shared json-rpc-channel.ts）──────────
  // 服务端请求交付给 handler 链；无人处理时保持沉默（不回 -32601），
  // 避免底层 renderer 的 WebSocket 与移动界面重复应答。审批/澄清/密码由本层应答。

  const REQUEST_TIMEOUT_MS = 120000
  const HEARTBEAT_INTERVAL_MS = 15000
  const HEARTBEAT_DEADLINE_MS = 45000

  class JsonRpcChannel {
    constructor() {
      this.nextId = 0
      this.pending = new Map()
      this.transport = null
      this.heartbeatTimer = null
      this.heartbeatSeq = 0
      this.outstandingPings = new Set()
      this.lastLivenessAt = 0
      this.onEvent = null
      this.onServerRequest = null
      this.onHeartbeatFailure = null
    }

    get connected() { return this.transport !== null }

    attach(transport) {
      this.stopHeartbeat()
      this.transport = transport
      this.lastLivenessAt = Date.now()
    }

    detach(error) {
      this.stopHeartbeat()
      this.transport = null
      for (const [id, call] of this.pending) {
        if (call.timer) clearTimeout(call.timer)
        this.pending.delete(id)
        call.reject(error)
      }
    }

    request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      const transport = this.transport
      if (!transport) return Promise.reject(new Error('gateway not connected'))
      const id = `mv${++this.nextId}`
      return new Promise((resolve, reject) => {
        let timer
        const call = {
          resolve: value => { clearTimeout(timer); this.pending.delete(id); resolve(value) },
          reject: err => { clearTimeout(timer); this.pending.delete(id); reject(err) }
        }
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (this.pending.delete(id)) reject(new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s: ${method}`))
          }, timeoutMs)
        }
        this.pending.set(id, call)
        try {
          transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        } catch (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }

    handleFrame(text, sourceTransport = this.transport) {
      let frame
      try { frame = JSON.parse(text) } catch { return }
      if (!frame || typeof frame !== 'object') return
      this.lastLivenessAt = Date.now()
      if (typeof frame.id === 'string' && typeof frame.method === 'string' && frame.method !== 'event') {
        if (this.onServerRequest) {
          this.onServerRequest({
            id: frame.id,
            method: frame.method,
            params: (frame.params && typeof frame.params === 'object') ? frame.params : {},
            respond: result => this.sendFrame({ jsonrpc: '2.0', id: frame.id, result }, sourceTransport),
            fail: (code, message) => this.sendFrame({ jsonrpc: '2.0', id: frame.id, error: { code, message } }, sourceTransport)
          })
        }
        return
      }
      if (frame.id !== undefined && frame.id !== null) {
        if (typeof frame.id === 'string' && this.outstandingPings.delete(frame.id)) {
          this.lastLivenessAt = Date.now()
          return
        }
        const call = this.pending.get(frame.id)
        if (call) {
          if (frame.error) call.reject(new Error(frame.error.message || `RPC error ${frame.error.code ?? ''}`))
          else call.resolve(frame.result)
        }
        return
      }
      if (frame.method === 'event' && frame.params && typeof frame.params.type === 'string') {
        if (this.onEvent) this.onEvent(frame.params)
      }
    }

    sendFrame(obj, transport = this.transport) {
      if (!transport || this.transport !== transport) return false
      try {
        transport.send(JSON.stringify(obj))
        return true
      } catch { return false }
    }

    startHeartbeat() {
      this.stopHeartbeat()
      this.lastLivenessAt = Date.now()
      const transport = this.transport
      if (!transport) return
      this.heartbeatTimer = setInterval(() => {
        if (this.transport !== transport) return
        if (Date.now() - this.lastLivenessAt >= HEARTBEAT_DEADLINE_MS) {
          this.stopHeartbeat()
          if (this.onHeartbeatFailure) this.onHeartbeatFailure(new Error('heartbeat timeout'))
          return
        }
        const id = `mv-heartbeat-${++this.heartbeatSeq}`
        this.outstandingPings.add(id)
        if (this.outstandingPings.size > 8) this.outstandingPings.delete(this.outstandingPings.values().next().value)
        try {
          transport.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'gateway.ping', params: {} }))
        } catch {
          this.stopHeartbeat()
          if (this.onHeartbeatFailure) this.onHeartbeatFailure(new Error('heartbeat send failed'))
        }
      }, HEARTBEAT_INTERVAL_MS)
    }

    stopHeartbeat() {
      this.outstandingPings.clear()
      if (this.heartbeatTimer !== null) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
    }
  }

  // ── 网关客户端（移植自 apps/shared json-rpc-gateway.ts）─────────────

  class GatewayClient {
    constructor() {
      this.channel = new JsonRpcChannel()
      this.state = 'idle'
      this.socket = null
      this.stateHandlers = new Set()
      this.lastSeenSeq = new Map()
      this.replayEpoch = null
      this.replayGeneration = 0
      this.replayHold = null
      this.connectTimeoutMs = 15000
      this.channel.onEvent = event => this.handleEvent(event)
      this.channel.onHeartbeatFailure = () => this.invalidate('heartbeat timeout')
    }

    onState(handler) {
      this.stateHandlers.add(handler)
      handler(this.state)
      return () => this.stateHandlers.delete(handler)
    }

    setState(state) {
      if (this.state === state) return
      this.state = state
      for (const handler of this.stateHandlers) handler(state)
    }

    request(method, params, timeoutMs) {
      return this.channel.request(method, params, timeoutMs)
    }

    connect(wsUrl) {
      if (this.socket && this.socket.readyState === 1) return Promise.resolve()
      this.setState('connecting')
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl)
        this.socket = socket
        this.channel.stopHeartbeat()
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          if (this.socket === socket) {
            try { socket.close() } catch { /* ignore */ }
            this.socket = null
            this.setState('error')
          }
          reject(new Error(`no WebSocket open within ${this.connectTimeoutMs} ms`))
        }, this.connectTimeoutMs)

        socket.addEventListener('open', () => {
          if (settled || this.socket !== socket) return
          settled = true
          clearTimeout(timer)
          const transport = { send: text => socket.send(text) }
          this.channel.attach(transport)
          socket.addEventListener('message', event => {
            if (this.socket !== socket) return
            const text = typeof event.data === 'string' ? event.data : null
            if (text !== null) this.channel.handleFrame(text, transport)
          })
          this.fetchReplay()
          this.setState('open')
          resolve()
        })
        socket.addEventListener('error', () => {
          if (settled || this.socket !== socket) return
          settled = true
          clearTimeout(timer)
          this.socket = null
          this.setState('error')
          reject(new Error('WebSocket error before open'))
        })
        socket.addEventListener('close', event => {
          if (this.socket !== socket) return
          if (!settled) {
            settled = true
            clearTimeout(timer)
            this.socket = null
            this.setState('error')
            reject(new Error(`WebSocket closed during handshake: code ${event.code}`))
            return
          }
          this.dropSocket('WebSocket closed')
        })
      })
    }

    dropSocket(message) {
      this.cancelReplay(false)
      this.socket = null
      this.channel.detach(new Error(message))
      this.setState('closed')
    }

    invalidate(message = 'invalidated') {
      const socket = this.socket
      if (!socket) return
      this.dropSocket(message)
      try { socket.close() } catch { /* ignore */ }
    }

    handleEvent(event) {
      if (event.type === 'gateway.ready') {
        if (event.payload?.heartbeat === true) this.channel.startHeartbeat()
        const epoch = event.payload?.replay_epoch
        if (typeof epoch === 'string' && epoch) this.adoptEpoch(epoch)
      }
      const sid = event.session_id
      const seq = event.seq
      if (this.replayHold && sid && typeof seq === 'number' && this.replayHold.has(sid)) {
        this.replayHold.get(sid).events.push(event)
        return
      }
      this.recordSeq(event)
      this.dispatch(event)
    }

    recordSeq(event) {
      const sid = event.session_id
      const seq = event.seq
      if (!sid || typeof seq !== 'number' || !Number.isFinite(seq)) return
      const prev = this.lastSeenSeq.get(sid) ?? 0
      if (seq > prev) this.lastSeenSeq.set(sid, seq)
    }

    dispatchIfNewer(event) {
      const sid = event.session_id
      const seq = event.seq
      if (sid && typeof seq === 'number' && Number.isFinite(seq)) {
        const prev = this.lastSeenSeq.get(sid) ?? 0
        if (seq <= prev) return
        this.lastSeenSeq.set(sid, seq)
      }
      this.dispatch(event)
    }

    dispatch(event) {
      if (eventHandlers[event.type]) {
        for (const handler of eventHandlers[event.type]) {
          try { handler(event) } catch (error) { console.error('[mobile-view] handler error', event.type, error) }
        }
      }
    }

    adoptEpoch(epoch) {
      if (this.replayEpoch === epoch) return
      const changed = this.replayEpoch !== null
      this.replayEpoch = epoch
      if (changed) {
        this.lastSeenSeq.clear()
        const hold = this.cancelReplay(true)
        for (const replay of hold?.values() ?? []) {
          for (const event of replay.events) this.dispatchIfNewer({ ...event, replayed: true })
        }
        if (eventHandlers.epochChanged) eventHandlers.epochChanged()
      }
    }

    fetchReplay() {
      if (this.replayHold || this.lastSeenSeq.size === 0) return
      const generation = ++this.replayGeneration
      const hold = new Map()
      for (const sid of this.lastSeenSeq.keys()) hold.set(sid, { events: [] })
      this.replayHold = hold
      for (const [sid, lastSeen] of [...this.lastSeenSeq]) {
        this.request('session.events.since', { session_id: sid, last_seen: lastSeen }, 10000)
          .then(result => {
            if (generation !== this.replayGeneration) return
            const epoch = result?.epoch
            if (typeof epoch === 'string' && epoch && this.replayEpoch && epoch !== this.replayEpoch) {
              this.adoptEpoch(epoch)
              return
            }
            if (typeof epoch === 'string' && epoch && !this.replayEpoch) this.replayEpoch = epoch
            for (const event of result?.events ?? []) {
              if (generation !== this.replayGeneration) return
              if (event?.type) this.dispatchIfNewer({ ...event, replayed: true })
            }
          })
          .catch(() => { /* 重放尽力而为 */ })
          .finally(() => {
            if (generation !== this.replayGeneration) return
            const entry = this.replayHold?.get(sid)
            if (!entry) return
            while (this.replayGeneration === generation && entry.events.length) {
              this.dispatchIfNewer({ ...entry.events.shift(), replayed: true })
            }
            this.replayHold?.delete(sid)
            if (this.replayHold?.size === 0) this.replayHold = null
          })
      }
    }

    cancelReplay(readsMayProceed) {
      const hold = this.replayHold
      this.replayGeneration += 1
      this.replayHold = null
      void readsMayProceed
      return hold
    }
  }

  // ── 全局状态 ────────────────────────────────────────────────────────

  const eventHandlers = {}
  const client = new GatewayClient()
  let connId = 'default'

  const store = {
    connection: 'idle',
    profileName: (() => { try { return localStorage.getItem(PROFILE_KEY) || '' } catch { return '' } })(),
    profileAuto: (() => { try { return !localStorage.getItem(PROFILE_KEY) } catch { return true } })(),
    sessions: [],
    currentId: null,
    entries: new Map(),
    reconnectAttempt: 0,
    connectError: '',
    activeTab: 'chat',
    pendingRequests: new Map()
  }

  const newEntry = storedId => ({
    storedId,
    runtimeId: null,
    title: '',
    model: '',
    items: [],
    draft: '',
    attachments: [],
    turnActive: false,
    queued: false,
    statusText: '',
    usage: null,
    scrollPin: true,
    structureVersion: 0,
    dirty: false,
    refs: { streamBubble: null, thinkingBody: null, toolCards: new Map() }
  })

  const entryFor = storedId => {
    if (!store.entries.has(storedId)) store.entries.set(storedId, newEntry(storedId))
    return store.entries.get(storedId)
  }
  const currentEntry = () => (store.currentId ? store.entries.get(store.currentId) || null : null)
  const entryByRuntime = runtimeId => {
    for (const entry of store.entries.values()) {
      if (entry.runtimeId === runtimeId) return entry
    }
    return null
  }

  const onEvent = (type, fn) => {
    (eventHandlers[type] = eventHandlers[type] || []).push(fn)
  }
  const onEpochChanged = fn => { eventHandlers.epochChanged = fn }

  // ── 数据访问：RPC + REST ────────────────────────────────────────────

  const rpc = (method, params, timeoutMs) => client.request(method, params, timeoutMs)

  // 网关的「当前 profile」是服务端全局态；App 侧选择以 PROFILE_KEY /
  // /api/profiles/active 为准，显式随 RPC/REST 携带。
  const withProfile = params => {
    if (!store.profileName) return params
    return { profile: store.profileName, ...params }
  }

  // REST 走 desktop.api（原生 fetch，带 Cookie）。GET 有 5s 缓存，
  // 变更后读最新数据用 bust:true 加时间戳绕过。
  const rest = async (method, path, body, opts = {}) => {
    let finalPath = path
    let finalBody = body
    if (opts.bust) finalPath += (path.includes('?') ? '&' : '?') + `_=${Date.now()}`
    if (shouldScopeRest(path)) {
      finalPath = appendProfileQuery(finalPath)
      if (finalBody && typeof finalBody === 'object' && !finalBody.profile && !opts.noBodyProfile) {
        finalBody = { profile: store.profileName || undefined, ...finalBody }
      }
    }
    const payload = { path: finalPath, method }
    if (finalBody !== undefined && finalBody !== null) payload.body = finalBody
    return await desktop.api(payload)
  }

  const shouldScopeRest = path => {
    const clean = String(path || '').split('?')[0].replace(/\/+$/, '')
    if (!clean.startsWith('/api/')) return false
    if (clean === '/api/status' || clean === '/api/profiles' || clean === '/api/health') return false
    if (clean.startsWith('/api/auth/')) return false
    if (clean === '/api/ws') return false
    // 定时任务列表在本网关版本上按 profile 过滤会得到空集（任务为服务器全局），不做作用域
    if (clean.startsWith('/api/cron')) return false
    return true
  }
  const appendProfileQuery = path => {
    if (!store.profileName || /[?&]profile=/.test(path)) return path
    return `${path}${path.includes('?') ? '&' : '?'}profile=${encodeURIComponent(store.profileName)}`
  }

  // 原生桥能力（window.__hermesMobile，Android WebView 注入；桌面/浏览器无此层）
  const NATIVE_SETTINGS_KEY = 'mv.notify.background'
  const NATIVE_PREVIEW_KEY = 'mv.notify.preview'
  const native = () => window.__hermesMobile || null
  let notifyEnabled = (() => {
    try { return localStorage.getItem(NATIVE_SETTINGS_KEY) !== '0' } catch { return true }
  })()
  const setNotifyEnabled = on => {
    const next = Boolean(on)
    notifyEnabled = next
    try { localStorage.setItem(NATIVE_SETTINGS_KEY, next ? '1' : '0') } catch { /* ignore */ }
    native()?.setNotifyEnabled?.(next)
    if (!next) native()?.setNotifySessions?.('{}')
    else syncNotifyContext()
  }
  let notifyPreviewEnabled = (() => {
    try { return localStorage.getItem(NATIVE_PREVIEW_KEY) === '1' } catch { return false }
  })()
  const setNotifyPreviewEnabled = on => {
    notifyPreviewEnabled = Boolean(on)
    try { localStorage.setItem(NATIVE_PREVIEW_KEY, notifyPreviewEnabled ? '1' : '0') } catch { /* ignore */ }
    native()?.setNotifyPreviewEnabled?.(notifyPreviewEnabled)
  }
  // 通知元数据同步：原生层按 runtime session id 找标题/跳转目标。
  // 全量 JSON 很小（每会话约 100 字节），全量推送免做差量。
  const syncNotifyContext = () => {
    const bridge = native()
    if (!bridge?.setNotifySessions) return
    bridge.setNotifyEnabled?.(notifyEnabled)
    if (!notifyEnabled) return
    const map = {}
    for (const [storedId, entry] of store.entries) {
      if (entry.runtimeId) {
        map[entry.runtimeId] = {
          title: entry.title || store.sessions.find(r => r.id === storedId)?.title || 'Hermes',
          stored: storedId
        }
      }
    }
    try { bridge.setNotifySessions(JSON.stringify(map)) } catch { /* ignore */ }
  }

  const refreshProfile = async () => {
    if (!store.profileAuto) { updateHeaderTitle(); return }
    try {
      const result = await desktop.api({ path: '/api/profiles/active' })
      store.profileName = result?.current || result?.active || ''
    } catch { /* 保留旧值 */ }
    updateHeaderTitle()
  }
  const setProfile = name => {
    store.profileName = name || ''
    store.profileAuto = !name
    try {
      if (name) localStorage.setItem(PROFILE_KEY, name)
      else localStorage.removeItem(PROFILE_KEY)
    } catch { /* ignore */ }
    updateHeaderTitle()
  }

  const refreshConnections = async () => {
    try {
      const registry = await desktop.connections.list()
      connId = registry?.lastUsed || registry?.primary || 'default'
    } catch { connId = 'default' }
  }

  const refreshSessions = async () => {
    try {
      const result = await rpc('session.list', withProfile({}))
      const rows = Array.isArray(result?.sessions) ? result.sessions : []
      rows.sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
      store.sessions = rows
      window.__hermesMVPages?.onSessionsUpdated?.(rows)
      syncNotifyContext()
      const current = currentEntry()
      if (current) {
        const row = rows.find(r => r.id === current.storedId)
        if (row) {
          current.title = row.title || current.title
          updateHeaderTitle()
        }
      }
    } catch (error) {
      console.warn('[mobile-view] session.list failed:', error?.message)
    }
  }

  // ── 会话操作 ────────────────────────────────────────────────────────

  const openSession = async storedId => {
    const entry = entryFor(storedId)
    store.currentId = storedId
    if (!ui.searchBar?.hidden) {
      ui.searchBar.hidden = true
      closeChatSearch()
    }
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ conn: connId, sid: storedId })) } catch { /* ignore */ }
    entry.scrollPin = true
    entry.draft = readDraft(storedId) ?? entry.draft ?? ''
    entry._loading = !entry.items.length
    navigate('chat')
    renderStream(entry)
    updateHeaderTitle()
    ui.input.value = entry.draft || ''
    autoGrowInput()
    renderAttachmentChips(entry)
    try {
      statusOverride = '正在加载会话…'
      updateStatusRow()
      const result = await rpc('session.resume', withProfile({ session_id: storedId }))
      if (store.currentId !== storedId) return
      entry._loading = false
      applyResume(entry, result)
    } catch (error) {
      entry._loading = false
      console.warn('[mobile-view] resume failed:', error?.message)
      if (store.currentId === storedId) toast(`会话加载失败：${clampText(error?.message, 80)}`, 'error')
    } finally {
      statusOverride = ''
      if (store.currentId === storedId) updateStatusRow()
    }
  }

  const applyResume = (entry, result) => {
    entry.runtimeId = result?.session_id || entry.runtimeId
    const pendingRequestItems = entry.items.filter(item =>
      item.kind === 'request' && store.pendingRequests.get(item.requestId)?.status === 'pending'
    )
    entry.items = projectHistory(result?.messages ?? [])
    entry.model = result?.info?.model || entry.model
    entry.turnActive = Boolean(result?.running || result?.inflight)
    entry.queued = Boolean(result?.queued)
    entry.statusText = entry.turnActive ? '回复进行中…' : ''
    if (result?.info?.usage) entry.usage = result.info.usage
    if (result?.inflight?.assistant) {
      entry.items.push({ kind: 'msg', role: 'assistant', text: result.inflight.assistant, streaming: true })
    }
    if (result?.queued?.user) {
      entry.items.push({ kind: 'msg', role: 'user', text: result.queued.user, queued: true })
    }
    entry.items.push(...pendingRequestItems)
    // 搜索打开时，对新加载的历史重新标记命中
    if (searchStore.q && searchStore.q.length >= 2) {
      const q = searchStore.q.toLowerCase()
      for (const item of entry.items) {
        if (item.kind === 'msg' && typeof item.text === 'string' && item.text.toLowerCase().includes(q)) {
          item._search = searchStore.q
        }
      }
    }
    entry.structureVersion++
    markDirty(entry, true)
    updateHeaderTitle()
    updateStatusRow()
    syncNotifyContext()
  }

  const projectHistory = rows => {
    const items = []
    for (const row of rows ?? []) {
      const kind = row?.display_kind
      if (kind === 'hidden') continue
      const role = String(row?.role || '')
      const text = typeof row?.text === 'string' ? row.text : ''
      if (role === 'user') {
        if (!text.trim()) continue
        items.push({ kind: 'msg', role: 'user', text, done: true })
      } else if (role === 'assistant') {
        if (typeof row?.reasoning === 'string' && row.reasoning.trim()) {
          items.push({ kind: 'thinking', text: row.reasoning, collapsed: true })
        }
        if (text.trim()) items.push({ kind: 'msg', role: 'assistant', text, done: true })
      } else if (role === 'tool') {
        const label = row?.labels?.[0]?.text || row?.name || '工具调用'
        const detail = row?.context || (row?.args ? JSON.stringify(row.args, null, 1) : '')
        items.push({
          kind: 'tool',
          toolId: row?.tool_call_id || `hist-${items.length}`,
          name: row?.name || label,
          label,
          state: 'done',
          detail: clampText(detail, 1200)
        })
      }
    }
    return items
  }

  const createSession = async () => {
    try {
      statusOverride = '正在新建会话…'
      updateStatusRow()
      const result = await rpc('session.create', withProfile({ source: 'android-mobile-view' }))
      const storedId = result?.stored_session_id || result?.session_id
      if (!storedId) throw new Error('no session id')
      const entry = entryFor(storedId)
      entry.runtimeId = result.session_id
      entry.model = result?.info?.model || ''
      entry.title = '新会话'
      entry.items = []
      entry.turnActive = false
      entry.queued = false
      entry.structureVersion++
      if (!store.sessions.some(r => r.id === storedId)) {
        store.sessions.unshift({ id: storedId, title: '新会话', preview: '', started_at: Date.now() / 1000, message_count: 0 })
        window.__hermesMVPages?.onSessionsUpdated?.(store.sessions)
      }
      await openSession(storedId)
    } catch (error) {
      toast(`新建会话失败：${clampText(error?.message, 80)}`, 'error')
    } finally {
      statusOverride = ''
      updateStatusRow()
    }
  }

  const deleteSession = async storedId => {
    try {
      try {
        await rest('DELETE', `/api/sessions/${encodeURIComponent(storedId)}`)
      } catch {
        // REST 删除失败（可能为活跃会话）：先 RPC close 再重试
        const entry = store.entries.get(storedId)
        const sid = entry?.runtimeId || storedId
        await rpc('session.close', withProfile({ session_id: sid })).catch(() => {})
        if (entry) entry.runtimeId = null
        await rpc('session.delete', withProfile({ session_id: storedId }))
      }
      store.sessions = store.sessions.filter(r => r.id !== storedId)
      store.entries.delete(storedId)
      if (store.currentId === storedId) {
        store.currentId = null
        renderStream(null)
        updateHeaderTitle()
        const next = store.sessions[0]
        if (next) await openSession(next.id)
      }
      await refreshSessions()
      toast('会话已删除', 'success')
    } catch (error) {
      toast(`删除失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  // ── 发送 / 停止 / 附件 ──────────────────────────────────────────────

  const appendAttachmentsToPrompt = (prompt, attachments) => {
    const docs = attachments.filter(a => !a.isImage)
    if (!docs.length) return prompt
    let out = prompt
    for (const att of docs) {
      out += `\n\n--- 附件：${att.name} ---\n`
      if (att.textContent != null) {
        out += att.textContent
      } else if (att.remotePath) {
        out += `服务器文件路径：${JSON.stringify(att.remotePath)}\n该附件已保存在服务器上，请使用文件工具读取后处理。`
      }
      out += '\n--- 附件结束 ---'
    }
    return out
  }

  const sendMessage = async () => {
    const entry = currentEntry()
    const text = ui.input.value.trim()
    if (!entry) {
      if (text || ui.input.value) toast('请先选择或新建会话', 'warn')
      return
    }
    if (!text && !entry.attachments.length) return
    if (store.connection !== 'open') {
      toast('网关未连接，消息暂未发送', 'warn')
      return
    }
    ui.input.value = ''
    autoGrowInput()
    entry.draft = ''
    writeDraft(entry.storedId, '')
    const attachments = entry.attachments.splice(0)
    renderAttachmentChips(entry)
    const restoreDraftAndAttachments = () => {
      entry.attachments.unshift(...attachments)
      if (store.currentId === entry.storedId) {
        if (!ui.input.value) ui.input.value = text
        entry.draft = ui.input.value
        autoGrowInput()
        renderAttachmentChips(entry)
      } else {
        entry.draft = text
      }
      writeDraft(entry.storedId, entry.draft)
    }

    if (!entry.runtimeId) {
      try {
        const created = await rpc('session.create', withProfile({ source: 'android-mobile-view' }))
        entry.runtimeId = created?.session_id
        if (!entry.runtimeId) throw new Error('no session id')
        syncNotifyContext()
      } catch (error) {
        restoreDraftAndAttachments()
        toast(`发送失败：${clampText(error?.message, 80)}`, 'error')
        return
      }
    }

    let promptText = text
    try {
      for (const att of attachments) {
        if (att.isImage && att.dataUrl && !att.uploaded) {
          await rpc('image.attach_bytes', withProfile({
            session_id: entry.runtimeId,
            content_base64: att.dataUrl,
            filename: att.name
          }), 60000)
          att.uploaded = true
        }
      }
      promptText = appendAttachmentsToPrompt(text, attachments)
    } catch (error) {
      toast(`附件上传失败：${clampText(error?.message, 80)}`, 'error')
      restoreDraftAndAttachments()
      return
    }

    const queued = entry.turnActive
    // 已随消息发出的图片（缩略图回显）；历史消息无法恢复图片数据，仅本次发送内存保留
    const sentImages = attachments.filter(a => a.isImage && a.dataUrl)
      .map(a => ({ name: a.name, thumb: a.thumb || a.dataUrl }))
    entry.items.push({ kind: 'msg', role: 'user', text: promptText, pending: true, images: sentImages })
    entry.structureVersion++
    markDirty(entry, true)
    try {
      const result = await rpc('prompt.submit', withProfile({
        session_id: entry.runtimeId,
        text: promptText,
        ...(queued ? { queued: true } : {})
      }), 60000)
      const last = [...entry.items].reverse().find(item => item.kind === 'msg' && item.role === 'user' && item.pending)
      if (last) {
        last.pending = false
        if (result?.status === 'queued') last.queued = true
        entry.structureVersion++
        markDirty(entry, false)
      }
      if (result?.status === 'streaming') {
        entry.turnActive = true
        updateStatusRow()
      }
    } catch (error) {
      const last = [...entry.items].reverse().find(item => item.kind === 'msg' && item.role === 'user' && item.pending)
      const message = clampText(error?.message, 120)
      if (last) {
        last.pending = false
        last.error = message
        last.retryText = text
        entry.structureVersion++
        markDirty(entry, false)
      }
      toast(`发送失败：${clampText(error?.message, 80)}，将自动重试`, 'error')
      // 自动补发：附件在此之前已上传到服务器，重发文本即可。
      // 2.5s 后检查连接，断网则挂起等连接恢复（scheduleConnectionRetry 轮询）。
      if (entry.runtimeId) {
        clearTimeout(entry._retryTimer)
        entry._retryTimer = setTimeout(() => {
          if (store.connection !== 'open') { scheduleConnectionRetry(entry); return }
          const failed = [...entry.items].reverse()
            .find(item => item.kind === 'msg' && item.role === 'user' && item.error && item.retryText)
          if (failed) void resendFailed(entry, failed)
        }, 2500)
      }
    }
  }

  // 重发一条失败的气泡（点按失败气泡或自动补发共用）
  const resendFailed = async (entry, item) => {
    if (store.connection !== 'open') {
      toast('网关未连接，稍后自动重试', 'warn')
      scheduleConnectionRetry(entry)
      return
    }
    item.error = ''
    item.pending = true
    item.retryText = ''
    entry.structureVersion++
    markDirty(entry, false)
    const text = item.text
    try {
      const result = await rpc('prompt.submit', withProfile({
        session_id: entry.runtimeId,
        text
      }), 60000)
      item.pending = false
      if (result?.status === 'queued') item.queued = true
      entry.structureVersion++
      markDirty(entry, false)
      if (result?.status === 'streaming') {
        entry.turnActive = true
        updateStatusRow()
      }
      toast('已重新发送', 'success', 1500)
    } catch (error) {
      item.pending = false
      item.error = clampText(error?.message, 120)
      item.retryText = text
      entry.structureVersion++
      markDirty(entry, false)
      toast(`重发失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  // 断网期间失败气泡等待连接恢复后自动补发
  const scheduleConnectionRetry = entry => {
    clearTimeout(entry._retryTimer)
    entry._retryTimer = setTimeout(() => {
      if (store.connection !== 'open') { scheduleConnectionRetry(entry); return }
      const failed = [...entry.items].reverse()
        .find(item => item.kind === 'msg' && item.role === 'user' && item.error && item.retryText)
      if (failed) void resendFailed(entry, failed)
    }, 5000)
  }

  const interruptSession = async () => {
    const entry = currentEntry()
    if (!entry?.runtimeId) return
    try {
      await rpc('session.interrupt', withProfile({ session_id: entry.runtimeId }))
      toast('已请求停止', 'info', 2200)
    } catch (error) {
      toast(`停止失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  const fileToDataUrl = file => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error || new Error('读取失败'))
    r.readAsDataURL(file)
  })

  // 图片缩略图：canvas 降采样到最长边 320px，JPEG 0.72；解码失败退回原图
  const makeImageThumb = dataUrl => new Promise(resolve => {
    try {
      const img = new Image()
      img.onload = () => {
        try {
          const scale = Math.min(1, 320 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
          const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
          const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          canvas.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.72))
        } catch { resolve(dataUrl) }
      }
      img.onerror = () => resolve(dataUrl)
      img.src = dataUrl
    } catch { resolve(dataUrl) }
  })

  const pickAttachments = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', async () => {
      const entry = currentEntry()
      input.remove()
      if (!entry) return
      for (const file of Array.from(input.files || [])) {
        if (file.size > 20 * 1024 * 1024) {
          toast(`${file.name} 超过 20MB，已跳过`, 'warn')
          continue
        }
        const isImage = /^image\//.test(file.type || '')
        try {
          const att = { name: file.name, size: file.size, isImage }
          if (isImage) {
            att.dataUrl = await fileToDataUrl(file)
            att.thumb = await makeImageThumb(att.dataUrl)
          } else if (file.size <= 512 * 1024) {
            // 小文件尝试按文本内联；失败则上传服务器
            try {
              const dataUrl = await fileToDataUrl(file)
              att.textContent = decodeURIComponent(escape(atob(String(dataUrl).split(',')[1] || '')))
            } catch {
              const upload = await rest('POST', '/api/files/upload', {
                path: `/mobile/${file.name}`,
                data_url: await fileToDataUrl(file),
                overwrite: false
              })
              att.remotePath = upload?.path || `/mobile/${file.name}`
            }
          } else {
            const upload = await rest('POST', '/api/files/upload', {
              path: `/mobile/${file.name}`,
              data_url: await fileToDataUrl(file),
              overwrite: false
            })
            att.remotePath = upload?.path || `/mobile/${file.name}`
          }
          entry.attachments.push(att)
          renderAttachmentChips(entry)
        } catch (error) {
          toast(`附件处理失败：${clampText(error?.message, 80)}`, 'error')
        }
      }
    })
    input.click()
  }

  const renderAttachmentChips = entry => {
    if (!entry || entry.storedId !== store.currentId) return
    const holder = ui.attachRow
    holder.replaceChildren()
    if (!entry?.attachments.length) { holder.hidden = true; return }
    holder.hidden = false
    for (const att of entry.attachments) {
      const chip = el('span', 'hmv-attach-chip', `${att.isImage ? '🖼' : '📄'} ${clampText(att.name, 14)}`)
      const remove = el('button', 'hmv-attach-remove', '×')
      remove.type = 'button'
      remove.setAttribute('aria-label', `移除附件 ${att.name}`)
      remove.addEventListener('click', () => {
        const idx = entry.attachments.indexOf(att)
        if (idx >= 0) entry.attachments.splice(idx, 1)
        renderAttachmentChips(entry)
      })
      chip.append(remove)
      holder.append(chip)
    }
  }

  // ── 服务端请求卡片（approval / clarify / sudo / secret）─────────────

  const REQUEST_LABELS = {
    once: '允许一次',
    session: '本会话允许',
    always: '总是允许',
    deny: '拒绝',
    yes: '允许',
    no: '拒绝'
  }

  const makeRequestCard = req => {
    const card = el('div', 'hmv-card hmv-request-card')
    card.dataset.reqState = 'pending'
    const head = el('div', 'hmv-card-head')
    const icon = el('span', 'hmv-card-icon', req.method === 'approval' ? '🛡' : req.method === 'clarify' ? '❓' : '🔑')
    const label = el('span', 'hmv-card-label',
      req.method === 'approval' ? '执行确认' : req.method === 'clarify' ? '需要你的回答' : req.method === 'sudo' ? '需要管理员密码' : '需要提供信息')
    const state = el('span', 'hmv-card-state')
    state.dataset.state = 'running'
    state.textContent = '等待处理'
    head.append(icon, label, state)
    card.append(head)

    const body = el('div', 'hmv-request-body')
    const params = req.params || {}
    if (params.command) body.append(el('div', 'hmv-request-cmd', clampText(params.command, 400)))
    else if (params.description) body.append(el('div', 'hmv-request-cmd', clampText(params.description, 300)))
    else if (params.question) body.append(el('div', 'hmv-request-cmd', clampText(params.question, 300)))
    else if (params.prompt || params.env_var) body.append(el('div', 'hmv-request-cmd', clampText(params.prompt || params.env_var, 200)))
    card.append(body)

    const actions = el('div', 'hmv-request-actions')
    card.append(actions)
    const settle = (text, ok) => {
      card.dataset.reqState = ok ? 'done' : 'expired'
      state.dataset.state = ok ? 'done' : 'error'
      state.textContent = text
      actions.replaceChildren()
    }
    const submitResponse = async (button, result, successText) => {
      if (button.disabled) return
      actions.querySelectorAll('button').forEach(b => { b.disabled = true })
      state.dataset.state = 'running'
      state.textContent = '正在提交…'
      try {
        await req.respond(result)
        settle(successText, true)
      } catch (error) {
        actions.querySelectorAll('button').forEach(b => { b.disabled = false })
        state.dataset.state = 'error'
        state.textContent = '应答失败，可重试'
        toast(`应答失败：${clampText(error?.message, 60)}`, 'error')
      }
    }

    const addChoiceButtons = choices => {
      for (const c of choices) {
        const btn = el('button', 'hmv-request-btn', REQUEST_LABELS[c] || c)
        btn.type = 'button'
        if (/deny|no/i.test(c)) btn.dataset.danger = 'true'
        btn.addEventListener('click', () => void submitResponse(btn, { choice: c }, REQUEST_LABELS[c] || c))
        actions.append(btn)
      }
    }

    if (req.method === 'approval') {
      const raw = Array.isArray(params.choices) && params.choices.length ? params.choices : ['once', 'deny']
      const choices = raw.map(c => (typeof c === 'string' ? c : c?.id || c?.value)).filter(Boolean)
      addChoiceButtons(choices)
    } else if (req.method === 'clarify') {
      const multi = Boolean(params.multi_select)
      const questions = Array.isArray(params.questions) && params.questions.length
        ? params.questions
        : [{ qid: 'q0', question: params.question || '', choices: params.choices, multi_select: params.multi_select }]
      const selected = new Map()
      for (const q of questions) {
        if (q.question) body.append(el('div', 'hmv-request-cmd', clampText(q.question, 300)))
        const qChoices = Array.isArray(q.choices) ? q.choices : null
        if (qChoices?.length) {
          const group = el('div', 'hmv-request-choices')
          for (const choice of qChoices) {
            const label = el('label', 'hmv-request-choice')
            const input = el('input')
            input.type = multi ? 'checkbox' : 'radio'
            input.name = `${req.id}-${q.qid}`
            input.value = choice
            input.addEventListener('change', () => {
              if (multi) {
                const list = selected.get(q.qid) || []
                if (input.checked) list.push(choice)
                else list.splice(list.indexOf(choice), 1)
                selected.set(q.qid, list)
              } else {
                selected.set(q.qid, [choice])
              }
            })
            label.append(input, el('span', null, choice))
            group.append(label)
          }
          body.append(group)
        } else {
          const input = el('input', 'hmv-request-input')
          input.placeholder = '输入回答（留空跳过）'
          input.dataset.qid = q.qid
          body.append(input)
        }
      }
      const sendBtn = el('button', 'hmv-request-btn hmv-request-primary', '提交回答')
      sendBtn.type = 'button'
      sendBtn.addEventListener('click', () => {
        let result
        if (questions.length === 1 && !questions[0].choices?.length) {
          const input = body.querySelector('.hmv-request-input')
          result = { answer: input?.value ?? '' }
        } else {
          const answers = {}
          for (const q of questions) {
            if (selected.has(q.qid)) answers[q.qid] = selected.get(q.qid).join(', ')
            else {
              const input = body.querySelector(`.hmv-request-input[data-qid="${q.qid}"]`)
              if (input?.value) answers[q.qid] = input.value
            }
          }
          result = Object.keys(answers).length ? { answers } : { answer: '' }
        }
        void submitResponse(sendBtn, result, '已回答')
      })
      actions.append(sendBtn)
    } else if (req.method === 'sudo' || req.method === 'secret') {
      const input = el('input', 'hmv-request-input')
      input.type = 'password'
      input.placeholder = req.method === 'sudo' ? 'sudo 密码' : (params.env_var || '值')
      body.append(input)
      const skip = el('button', 'hmv-request-btn', '跳过')
      skip.type = 'button'
      skip.addEventListener('click', () => void submitResponse(skip, { value: '' }, '已跳过'))
      const sendBtn = el('button', 'hmv-request-btn hmv-request-primary', '提交')
      sendBtn.type = 'button'
      sendBtn.addEventListener('click', () => {
        void submitResponse(sendBtn, { value: input.value }, '已提交').then(() => {
          if (card.dataset.reqState === 'done') input.value = ''
        })
      })
      actions.append(skip, sendBtn)
    }

    return { card, settle }
  }

  const markRequestAnswered = record => {
    record.status = 'answered'
    record.answering = false
    store.pendingRequests.delete(record.id)
    updateBadges()
    window.__hermesMVPages?.onRequestsUpdated?.()
  }

  const respondPendingRequest = async (record, result) => {
    if (!record || record.status !== 'pending') throw new Error('该请求已处理或已过期')
    if (record.answering) throw new Error('请求正在提交')
    if (typeof record.respond !== 'function') throw new Error('当前网关不支持直接应答此请求')
    record.answering = true
    try {
      const sent = await record.respond(result)
      if (sent === false) throw new Error('网关连接已断开，应答未发送')
      markRequestAnswered(record)
      return sent
    } catch (error) {
      record.answering = false
      throw error
    }
  }

  const handleServerRequest = req => {
    const known = ['approval', 'clarify', 'sudo', 'secret']
    if (!known.includes(req.method)) return // 未支持的请求保持沉默（不回 -32601）
    const params = req.params || {}
    const sid = params.session_id || ''
    const entry = sid ? entryByRuntime(sid) : null
    const record = {
      id: req.id,
      method: req.method,
      params,
      status: 'pending',
      sessionId: entry?.storedId || sid || null,
      createdAt: Date.now(),
      respond: typeof req.respond === 'function' ? req.respond : null,
      fail: typeof req.fail === 'function' ? req.fail : null,
      answering: false
    }
    store.pendingRequests.set(req.id, record)
    updateBadges()

    if (entry && entry.storedId === store.currentId) {
      entry.items.push({ kind: 'request', requestId: req.id })
      entry.structureVersion++
      markDirty(entry, true)
    } else {
      toast(req.method === 'approval' ? '有新的执行确认，去「任务」处理' : '收到新的提问，去「任务」处理', 'warn', 6000)
    }
    window.__hermesMVPages?.onRequestsUpdated?.()

  }

  // ── 事件处理 ────────────────────────────────────────────────────────

  const ensureStreamBubble = entry => {
    let bubble = [...entry.items].reverse().find(item => item.kind === 'msg' && item.role === 'assistant' && !item.done)
    if (!bubble) {
      bubble = { kind: 'msg', role: 'assistant', text: '', streaming: true }
      entry.items.push(bubble)
      entry.structureVersion++
      markDirty(entry, false)
    } else if (!bubble.text && entry.items[entry.items.length - 1] !== bubble) {
      const idx = entry.items.indexOf(bubble)
      entry.items.splice(idx, 1)
      entry.items.push(bubble)
      entry.structureVersion++
      markDirty(entry, false)
    }
    return bubble
  }

  const ensureThinkingCard = entry => {
    let card = [...entry.items].reverse().find(item => item.kind === 'thinking' && item.pending)
    if (!card) {
      card = { kind: 'thinking', text: '', pending: true, collapsed: true }
      entry.items.push(card)
      entry.structureVersion++
      markDirty(entry, false)
    }
    return card
  }

  const finishTurn = (entry, payload) => {
    entry.turnActive = false
    entry.queued = false
    const bubble = [...entry.items].reverse().find(item => item.kind === 'msg' && item.role === 'assistant' && !item.done)
    if (bubble) {
      bubble.streaming = false
      bubble.done = true
      if (typeof payload?.text === 'string' && payload.text) bubble.text = payload.text
      if (payload?.status === 'error' || payload?.error) {
        bubble.state = 'error'
        if (payload?.error) bubble.text = bubble.text ? `${bubble.text}\n\n⚠ ${payload.error}` : `⚠ ${payload.error}`
      }
      if (!bubble.text && !bubble.state) {
        const idx = entry.items.indexOf(bubble)
        if (idx >= 0) entry.items.splice(idx, 1)
      }
    }
    const thinking = [...entry.items].reverse().find(item => item.kind === 'thinking' && item.pending)
    if (thinking) {
      thinking.pending = false
      if (typeof payload?.reasoning === 'string' && payload.reasoning) thinking.text = payload.reasoning
    }
    entry.statusText = ''
    if (payload?.usage) entry.usage = payload.usage
    entry.structureVersion++
    markDirty(entry, true)
    if (entry.storedId === store.currentId) updateStatusRow()
  }

  const registerEventHandlers = () => {
    onEvent('message.start', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry) return
      entry.turnActive = true
      entry.statusText = ''
      if (entry.storedId === store.currentId) {
        ensureStreamBubble(entry)
        updateStatusRow()
      }
    })

    onEvent('message.delta', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry || entry.storedId !== store.currentId) return
      const bubble = ensureStreamBubble(entry)
      bubble.text += String(event.payload?.text ?? '')
      if (entry.refs.streamBubble && entry.refs.streamBubble.isConnected) {
        entry.refs.streamBubble.innerHTML = richText(bubble.text)
        scrollPinIfNear(entry)
      } else {
        markDirty(entry, false)
      }
    })

    onEvent('message.interim', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry || entry.storedId !== store.currentId) return
      const bubble = ensureStreamBubble(entry)
      bubble.text = String(event.payload?.text ?? '')
      if (entry.refs.streamBubble && entry.refs.streamBubble.isConnected) {
        entry.refs.streamBubble.innerHTML = richText(bubble.text)
      } else {
        markDirty(entry, false)
      }
    })

    onEvent('message.complete', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry) return
      finishTurn(entry, event.payload)
    })

    onEvent('reasoning.delta', onThinkingDelta)
    onEvent('thinking.delta', onThinkingDelta)

    onEvent('reasoning.available', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry || entry.storedId !== store.currentId) return
      const card = ensureThinkingCard(entry)
      card.text = String(event.payload?.text ?? '')
      if (entry.refs.thinkingBody?.isConnected) entry.refs.thinkingBody.textContent = card.text
    })

    onEvent('tool.start', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry || entry.storedId !== store.currentId) return
      const payload = event.payload ?? {}
      const label = payload.labels?.[0]?.text || payload.name || '工具调用'
      entry.items.push({
        kind: 'tool',
        toolId: payload.tool_id,
        name: payload.name || label,
        label,
        state: 'running',
        detail: clampText(payload.preview || payload.args_text || (payload.args ? JSON.stringify(payload.args, null, 1) : ''), 1200)
      })
      entry.structureVersion++
      markDirty(entry, false)
    })

    onEvent('tool.complete', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry || entry.storedId !== store.currentId) return
      const payload = event.payload ?? {}
      const card = [...entry.items].reverse().find(item => item.kind === 'tool' && item.toolId === payload.tool_id)
      if (card) {
        card.state = payload.error ? 'error' : 'done'
        if (payload.duration_s != null) card.durationS = payload.duration_s
        const detail = payload.summary || payload.result_text || payload.inline_diff || ''
        if (detail) card.detail = clampText(detail, 1600)
        entry.structureVersion++
        markDirty(entry, false)
      }
    })

    onEvent('status.update', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry || entry.storedId !== store.currentId) return
      entry.statusText = clampText(event.payload?.text ?? '', 60)
      updateStatusRow()
    })

    onEvent('session.usage', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry) return
      entry.usage = event.payload?.usage || entry.usage
      if (entry.storedId === store.currentId) updateStatusRow()
    })

    // 会话级模型/运行态变化由网关以 session.info 推送（模型切换、deferred 切换落地、
    // 网关侧改配）。没有这条监听时胶囊会一直显示旧模型名。
    onEvent('session.info', event => {
      const entry = entryByRuntime(event.session_id)
      if (!entry) return
      const info = event.payload || {}
      if (info.model) entry.model = info.model
      if (typeof info.running === 'boolean') entry.turnActive = info.running
      if (entry.storedId === store.currentId) {
        updateHeaderTitle()
        updateStatusRow()
      }
    })

    onEvent('session.title', event => {
      void refreshSessions()
      const entry = entryByRuntime(event.session_id)
      if (entry && event.payload?.title) {
        entry.title = event.payload.title
        if (entry.storedId === store.currentId) updateHeaderTitle()
      }
    })

    onEvent('sessions.changed', () => {
      clearTimeout(refreshSessions._timer)
      refreshSessions._timer = setTimeout(refreshSessions, 600)
    })

    onEvent('error', event => {
      const entry = event.session_id ? entryByRuntime(event.session_id) : null
      if (entry && entry.storedId === store.currentId) {
        entry.statusText = ''
        finishTurn(entry, { status: 'error', error: event.payload?.message })
      } else {
        toast(event.payload?.message || '网关返回错误', 'error')
      }
    })

    onEvent('notification.show', event => {
      const payload = event.payload ?? {}
      toast(payload.text || '', payload.level === 'success' ? 'success' : payload.level === 'error' ? 'error' : payload.level === 'warn' ? 'warn' : 'info', payload.ttl_ms || 4000)
    })

    onEvent('notice', event => {
      if (event.payload?.message) toast(event.payload.message, 'info')
    })

    // 兼容部分网关把审批/澄清发成事件而非服务端请求
    const eventRequest = (event, method) => {
      const payload = event.payload ?? {}
      if (!payload.request_id) return
      handleServerRequest({
        id: String(payload.request_id),
        method,
        params: { ...payload, session_id: payload.session_id || event.session_id },
        respond: result => rpc(
          method === 'approval' ? 'approval.respond' : 'clarify.respond',
          withProfile(method === 'approval'
            ? { session_id: payload.session_id || event.session_id, choice: result.choice, ...(payload.request_id ? { request_id: payload.request_id } : {}) }
            : { request_id: payload.request_id, ...(result.answers ? { answers: result.answers } : { answer: result.answer ?? '' }) })
        ),
        fail: () => {}
      })
    }
    onEvent('approval.request', event => eventRequest(event, 'approval'))
    onEvent('clarify.request', event => eventRequest(event, 'clarify'))
    const expire = event => {
      const rid = event.payload?.request_id || event.payload?.id
      if (!rid) return
      const id = String(rid)
      const record = store.pendingRequests.get(id)
      if (!record) return
      store.pendingRequests.delete(id)
      const entry = record.sessionId
        ? store.entries.get(record.sessionId) || entryByRuntime(record.sessionId)
        : null
      if (entry) {
        const before = entry.items.length
        entry.items = entry.items.filter(item => item.kind !== 'request' || String(item.requestId) !== id)
        if (entry.items.length !== before) {
          entry.structureVersion++
          markDirty(entry)
        }
      }
      updateBadges()
      window.__hermesMVPages?.onRequestsUpdated?.()
    }
    onEvent('approval.expire', expire)
    onEvent('approval.expired', expire)
    onEvent('clarify.expire', expire)
    onEvent('clarify.expired', expire)

    onEpochChanged(() => {
      const entry = currentEntry()
      if (entry) {
        rpc('session.resume', withProfile({ session_id: entry.storedId }))
          .then(result => { if (store.currentId === entry.storedId) applyResume(entry, result) })
          .catch(() => {})
      }
    })
  }

  const onThinkingDelta = event => {
    const entry = entryByRuntime(event.session_id)
    if (!entry || entry.storedId !== store.currentId) return
    const card = ensureThinkingCard(entry)
    card.text += String(event.payload?.text ?? '')
    if (entry.refs.thinkingBody?.isConnected) {
      entry.refs.thinkingBody.textContent = card.text
      entry.refs.thinkingBody.scrollTop = entry.refs.thinkingBody.scrollHeight
    } else {
      markDirty(entry, false)
    }
  }

  // ── 渲染：消息流 ────────────────────────────────────────────────────

  let ui = null
  let statusOverride = ''
  let renderScheduled = false

  const markDirty = entry => {
    entry.dirty = true
    if (renderScheduled) return
    renderScheduled = true
    requestAnimationFrame(() => {
      renderScheduled = false
      const current = currentEntry()
      if (current?.dirty) renderStream(current)
    })
  }

  const scrollPinIfNear = entry => {
    const stream = ui.stream
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140
    if (nearBottom || entry.scrollPin) stream.scrollTop = stream.scrollHeight
  }

  const renderStream = entry => {
    if (entry) entry.dirty = false
    const stream = ui.stream
    const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140
    stream.replaceChildren()
    if (entry) {
      entry.refs.streamBubble = null
      entry.refs.thinkingBody = null
      entry.refs.toolCards.clear()
    }

    if (!entry) {
      const empty = el('div', 'hmv-empty')
      const icon = el('div', null, '✳')
      icon.style.cssText = 'font-size:34px;margin-bottom:10px;color:var(--hm-accent-strong)'
      empty.append(icon, el('strong', null, 'Hermes 移动工作台'), el('p', null, '点右上角 ＋ 新建会话，或去「会话」页选择历史。'))
      stream.append(empty)
      return
    }
    if (!entry.items.length && entry._loading) {
      stream.append(el('div', 'hmv-loading', '正在加载会话…'))
      return
    }
    if (!entry.items.length) {
      const empty = el('div', 'hmv-empty')
      empty.append(el('strong', null, '还没有消息'), el('p', null, '在下方输入第一条消息吧。'))
      stream.append(empty)
      return
    }
    for (const item of entry.items) stream.append(renderItem(entry, item))
    if (atBottom || entry.scrollPin) stream.scrollTop = stream.scrollHeight
  }

  const renderItem = (entry, item) => {
    if (item.kind === 'msg') {
      const wrap = el('div', 'hmv-msg')
      wrap.dataset.role = item.role
      const bubble = el('div', 'hmv-bubble')
      bubble.innerHTML = richText(item.text)
      longPress(wrap, () => {
        const actions = [{ label: '复制文本', onTap: async () => {
          try { await window.hermesDesktop.writeClipboard(item.text || ''); toast('已复制', 'success', 1500) } catch { toast('复制失败', 'error') }
        } }]
        if (item.role === 'user' && !item.pending) {
          actions.push({ label: '重新发送', onTap: () => {
            ui.input.value = item.text || ''
            ui.input.dispatchEvent(new Event('input', { bubbles: true }))
            void sendMessage()
          } })
        }
        if (item.role === 'user' && item.error && entry.runtimeId) {
          actions.push({ label: '重发失败消息', onTap: () => void resendFailed(entry, item) })
        }
        actionSheet(clampText(item.text, 40), actions)
      })
      // 失败气泡：点按直接重发
      if (item.error && entry.runtimeId) {
        bubble.classList.add('hmv-bubble-failed')
        bubble.title = '点按重发'
        bubble.addEventListener('click', () => void resendFailed(entry, item), { once: true })
      }
      if (item.pending) bubble.dataset.pending = 'true'
      if (item.state === 'error') bubble.dataset.state = 'error'
      // 搜索命中：标记供跳转定位 + 文本高亮
      if (item._search && searchStore.q) {
        wrap.setAttribute('data-search-hit', '')
        highlightMatches(bubble, searchStore.q)
      }
      if (item.streaming) {
        entry.refs.streamBubble = bubble
        bubble.dataset.streaming = 'true'
      }
      wrap.append(bubble)
      // 发出的图片缩略图条
      if (item.images?.length) {
        const strip = el('div', 'hmv-msg-images')
        for (const img of item.images) {
          const thumb = el('img', 'hmv-msg-thumb')
          thumb.src = img.thumb || img.dataUrl || ''
          thumb.alt = img.name || '图片'
          thumb.loading = 'lazy'
          thumb.addEventListener('click', () => openImageOverlay(img.thumb || img.dataUrl || '', img.name))
          strip.append(thumb)
        }
        wrap.append(strip)
      }
      if (item.queued) wrap.append(el('div', 'hmv-chip', '已排队，等待上一轮结束'))
      if (item.error) wrap.append(el('div', 'hmv-chip', `发送失败，点按气泡重发 · ${item.error}`))
      return wrap
    }

    if (item.kind === 'tool' || item.kind === 'thinking') {
      const isTool = item.kind === 'tool'
      const card = el('div', 'hmv-card')
      const head = el('button', 'hmv-card-head')
      head.type = 'button'
      const icon = el('span', 'hmv-card-icon', isTool ? '🛠' : '💭')
      const label = el('span', 'hmv-card-label', isTool ? item.label : '思考')
      const state = el('span', 'hmv-card-state')
      head.append(icon, label, state)
      const body = el('div', 'hmv-card-body')
      card.append(head, body)
      if (isTool) {
        state.dataset.state = item.state
        state.textContent = item.state === 'running' ? '执行中…' : item.state === 'error' ? '失败' : item.durationS != null ? `完成 · ${Number(item.durationS).toFixed(1)}s` : '完成'
      } else {
        state.dataset.state = item.pending ? 'running' : 'done'
        state.textContent = item.pending ? '思考中…' : '完成'
      }
      body.textContent = item.text || item.detail || ''
      head.addEventListener('click', () => {
        if (card.hasAttribute('data-open')) card.removeAttribute('data-open')
        else card.setAttribute('data-open', 'true')
      })
      if (item.collapsed === false) card.setAttribute('data-open', 'true')
      if (isTool && item.toolId) entry.refs.toolCards.set(item.toolId, { card, body })
      if (!isTool) entry.refs.thinkingBody = body
      return card
    }

    if (item.kind === 'request') {
      const record = store.pendingRequests.get(item.requestId)
      if (!record) return document.createComment('resolved request')
      const built = makeRequestCard({
        id: record.id,
        method: record.method,
        params: record.params,
        respond: result => respondPendingRequest(record, result),
        fail: (code, message) => record.fail?.(code, message)
      })
      return built.card
    }

    return document.createComment('unknown item')
  }

  // ── 聊天内搜索 / 图片浮层 ───────────────────────────────────────────

  const searchStore = { q: '', hits: [], idx: -1, seq: 0 }
  const SEARCH_DEBOUNCE_MS = 240

  const escReg = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // 在元素的文本节点里把命中词包上 <mark>（搜索高亮用；不影响已有标签结构）
  const highlightMatches = (rootEl, query) => {
    if (!query) return
    const pattern = new RegExp(escReg(query), 'gi')
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
    const targets = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue && pattern.test(node.nodeValue)) targets.push(node)
      pattern.lastIndex = 0
    }
    for (const node of targets) {
      const frag = document.createDocumentFragment()
      let rest = node.nodeValue
      let m
      pattern.lastIndex = 0
      while ((m = pattern.exec(rest))) {
        if (m.index > 0) frag.append(document.createTextNode(rest.slice(0, m.index)))
        const mark = document.createElement('mark')
        mark.className = 'hmv-search-mark'
        mark.textContent = m[0]
        frag.append(mark)
        rest = rest.slice(m.index + m[0].length)
        pattern.lastIndex = 0
      }
      if (rest) frag.append(document.createTextNode(rest))
      node.parentNode?.replaceChild(frag, node)
    }
  }

  const runChatSearch = async rawQuery => {
    const seq = ++searchStore.seq
    const query = String(rawQuery || '').trim()
    searchStore.q = query
    searchStore.hits = []
    searchStore.idx = -1
    if (query.length < 2) {
      renderStream(currentEntry())
      updateSearchSummary()
      return
    }
    const localEntry = currentEntry()
    if (localEntry) {
      // 会话内命中的消息渲染高亮
      for (const item of localEntry.items) {
        if (item.kind === 'msg' && typeof item.text === 'string' &&
          item.text.toLowerCase().includes(query.toLowerCase())) {
          searchStore.hits.push({ item })
          item._search = query
        } else if (item._search) delete item._search
      }
    }
    // 本地命中立即渲染与定位：远端全文检索在慢网关上可能 15s+，不能拖住会话内反馈
    renderStream(currentEntry())
    updateSearchSummary()
    if (searchStore.hits.length) jumpToHit(0, true)
    // 跨会话全文搜索（/api/sessions/search），失败/慢速只影响「其他会话」入口
    let remote = []
    try {
      const result = await rest('GET', `/api/sessions/search?q=${encodeURIComponent(query)}&limit=20`)
      remote = (result?.results ?? []).filter(r => r.snippet)
    } catch { /* 全文搜索不可用时只显示会话内命中 */ }
    if (seq !== searchStore.seq) return // 已有更新的输入，丢弃旧结果
    searchStore.remote = remote
    updateSearchSummary()
  }

  const jumpToHit = (idx, instant) => {
    if (!searchStore.hits.length) return
    searchStore.idx = ((idx % searchStore.hits.length) + searchStore.hits.length) % searchStore.hits.length
    // 取第 N 个命中节点（querySelector 只会拿第一条，↑/↓ 就不动了）
    const nodes = ui.stream.querySelectorAll('[data-search-hit]')
    const node = nodes[searchStore.idx] || nodes[0]
    if (node) {
      nodes.forEach(n => n.classList.remove('hmv-search-current'))
      node.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' })
      void node.offsetWidth
      node.classList.add('hmv-search-current')
    }
    updateSearchSummary()
  }

  const updateSearchSummary = () => {
    const holder = ui.searchSummary
    if (!holder) return
    const local = searchStore.hits.length
    const remote = searchStore.remote?.length || 0
    if (!searchStore.q || searchStore.q.length < 2) {
      holder.hidden = true
      holder.replaceChildren()
      return
    }
    holder.hidden = false
    holder.replaceChildren()
    if (local) {
      const prev = el('button', 'hmv-search-nav', '↑')
      prev.type = 'button'
      prev.addEventListener('click', () => jumpToHit(searchStore.idx - 1))
      const next = el('button', 'hmv-search-nav', '↓')
      next.type = 'button'
      next.addEventListener('click', () => jumpToHit(searchStore.idx + 1))
      holder.append(el('span', 'hmv-search-count', `${searchStore.idx + 1}/${local}`), prev, next)
    } else {
      holder.append(el('span', 'hmv-search-count', '本会话无命中'))
    }
    if (remote) {
      const more = el('button', 'hmv-search-more', `其他会话 ${remote} 条 ›`)
      more.type = 'button'
      more.addEventListener('click', () => window.__hermesMVPages?.openContentSearch?.(searchStore.q, searchStore.remote || []))
      holder.append(more)
    }
  }

  const closeChatSearch = () => {
    searchStore.seq++
    searchStore.q = ''
    searchStore.hits = []
    searchStore.remote = []
    const entry = currentEntry()
    if (entry) for (const item of entry.items) { if (item._search) delete item._search }
    ui.searchBar.hidden = true
    updateSearchSummary()
    renderStream(entry)
  }

  // 图片全屏浮层（缩略图点开看大图）
  const openImageOverlay = (src, name) => {
    if (!src) return
    const overlay = el('div', 'hmv-img-overlay')
    const img = el('img')
    img.src = src
    img.alt = name || '图片'
    const label = el('div', 'hmv-img-overlay-name', clampText(name || '', 40))
    overlay.append(img, label)
    overlay.addEventListener('click', () => overlay.remove())
    document.body.append(overlay)
  }

  // ── 页面壳：tab / 路由 / 导航 ───────────────────────────────────────

  const pageRegistry = new Map()
  const registerPage = (id, def) => pageRegistry.set(id, def)

  const NAV_ITEMS = [
    ['chat', 'chat', '聊天'],
    ['sessions', 'list', '会话'],
    ['files', 'files', '文件'],
    ['tasks', 'tasks', '任务'],
    ['skills', 'skills', '技能'],
    ['more', 'more', '更多']
  ]

  const navStack = [] // 二级页面栈（文件/产物/命令中心等）

  const showPage = (id, opts = {}) => {
    for (const section of ui.pagesEl.querySelectorAll('.hmv-page')) {
      section.hidden = section.dataset.page !== id
    }
    for (const [tabId, btn] of Object.entries(ui.navButtons)) {
      btn.classList.toggle('active', !navStack.length && tabId === id)
    }
    const def = pageRegistry.get(id)
    ui.titleStrong.textContent = def?.title || 'Hermes'
    ui.titleSmall.textContent = ''
    ui.backBtn.hidden = navStack.length === 0
    ui.newBtn.hidden = id !== 'chat'
    def?.onShow?.(opts)
    updateBadges()
  }

  const navigate = (id, opts = {}) => {
    if (!pageRegistry.has(id)) return
    const prev = store.activeTab
    if (prev !== id) pageRegistry.get(prev)?.onHide?.()
    navStack.length = 0
    store.activeTab = id
    showPage(id, opts)
  }

  const pushPage = (id, opts = {}) => {
    if (!pageRegistry.has(id)) return
    if (store.activeTab !== id) pageRegistry.get(store.activeTab)?.onHide?.()
    if (navStack[navStack.length - 1] !== store.activeTab) navStack.push(store.activeTab)
    store.activeTab = id
    showPage(id, opts)
  }

  const popPage = () => {
    const back = navStack.pop()
    const target = back || 'chat'
    pageRegistry.get(store.activeTab)?.onHide?.()
    store.activeTab = target
    showPage(target)
  }

  const updateBadges = () => {
    const pending = [...store.pendingRequests.values()].filter(r => r.status === 'pending').length
    const btn = ui.navButtons?.tasks
    if (!btn) return
    let badge = btn.querySelector('.hmv-nav-badge')
    if (pending > 0) {
      if (!badge) {
        badge = el('span', 'hmv-nav-badge')
        btn.append(badge)
      }
      badge.textContent = String(pending)
    } else badge?.remove()
  }

  // ── 头部 / 状态行 ───────────────────────────────────────────────────

  const updateHeaderTitle = () => {
    if (store.activeTab !== 'chat') return
    const entry = currentEntry()
    const row = store.sessions.find(r => r.id === store.currentId)
    ui.titleStrong.textContent = entry?.title || row?.title || (store.currentId ? '会话' : '聊天')
    const bits = []
    if (entry?.turnActive) bits.push(entry.statusText || '回复进行中…')
    else if (entry?.queued) bits.push('有排队的消息')
    else if (store.profileName) bits.push(store.profileName)
    ui.titleSmall.textContent = bits.join(' · ')
    // 会话模型胶囊（点击切换）
    if (ui.modelPill) {
      ui.modelPill.hidden = !entry
      ui.modelPill.innerHTML = `<span class="hmv-model-pill-icon">${svgIcon(ICONS.cpu, 13)}</span><span>${esc(entry?.model || '选择模型')}</span><span class="hmv-model-pill-caret">▾</span>`
    }
  }

  const updateStatusRow = () => {
    const entry = currentEntry()
    const holder = ui.statusRow
    holder.replaceChildren()
    const dot = el('span', 'hmv-status-dot')
    dot.dataset.state = store.connection
    let label = {
      idle: '未连接',
      connecting: '正在连接网关…',
      open: store.profileName ? `已连接 · ${store.profileName}` : '已连接',
      closed: '连接已断开',
      error: '连接失败'
    }[store.connection]
    if (statusOverride) label = statusOverride
    else if (entry?.turnActive && entry.statusText) label = `${label} · ${entry.statusText}`
    const text = el('span', 'hmv-status-main', label)
    holder.append(dot, text)
    if (/No remote gateway configured/i.test(store.connectError || '')) {
      const settings = el('button', null, '去添加网关')
      settings.type = 'button'
      settings.addEventListener('click', () => navigate('more'))
      holder.append(settings)
    } else if (store.connection === 'error' || store.connection === 'closed') {
      const retry = el('button', null, '重试')
      retry.type = 'button'
      retry.addEventListener('click', () => { connectLoop() })
      holder.append(retry)
    }
    const usage = entry?.usage
    if (usage && (usage.context_percent != null || (usage.context_used != null && usage.context_max))) {
      const pct = usage.context_percent != null
        ? Number(usage.context_percent)
        : Math.round(100 * usage.context_used / Math.max(1, usage.context_max))
      if (Number.isFinite(pct) && pct >= 0) holder.append(el('span', 'hmv-ctx', `上下文 ${Math.min(100, Math.round(pct))}%`))
    }
    updateSendButton()
    updateHeaderTitle()
  }

  const updateSendButton = () => {
    const entry = currentEntry()
    const stop = entry?.turnActive
    ui.send.dataset.mode = stop ? 'stop' : 'send'
    ui.send.innerHTML = svgIcon(stop ? ICONS.stop : ICONS.send, 19)
    ui.send.setAttribute('aria-label', stop ? '停止生成' : '发送')
  }

  // ── UI 构建 ─────────────────────────────────────────────────────────

  const autoGrowInput = () => {
    const input = ui.input
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`
  }

  const buildUi = () => {
    const root = el('div')
    root.setAttribute('data-hermes-mobile-view', '')
    root.setAttribute('role', 'application')
    root.setAttribute('aria-label', 'Hermes 移动应用')

    const top = el('header', 'hmv-top')
    const backBtn = el('button', 'hmv-icon')
    backBtn.type = 'button'
    backBtn.hidden = true
    backBtn.setAttribute('aria-label', '返回')
    backBtn.innerHTML = svgIcon(ICONS.back, 20)
    backBtn.addEventListener('click', popPage)
    const titleWrap = el('div', 'hmv-top-title')
    const titleStrong = el('strong', null, 'Hermes')
    const titleSmall = el('small', null, '')
    titleWrap.append(titleStrong, titleSmall)
    const newBtn = el('button', 'hmv-icon')
    newBtn.type = 'button'
    newBtn.setAttribute('aria-label', '新建会话')
    newBtn.innerHTML = svgIcon(ICONS.plus, 20)
    const searchBtn = el('button', 'hmv-icon')
    searchBtn.type = 'button'
    searchBtn.setAttribute('aria-label', '搜索聊天记录')
    searchBtn.innerHTML = svgIcon(ICONS.search, 19)
    top.append(backBtn, titleWrap, searchBtn, newBtn)

    const status = el('div', 'hmv-status')

    const pagesEl = el('div', 'hmv-pages')

    const makePage = id => {
      const section = el('section', 'hmv-page')
      section.dataset.page = id
      section.hidden = id !== 'chat'
      pagesEl.append(section)
      return section
    }

    // 聊天页（核心）
    const chatPage = makePage('chat')
    const stream = el('main', 'hmv-stream')
    stream.setAttribute('aria-label', '消息流')
    // 聊天内搜索栏（顶栏搜索按钮展开）+ 命中摘要条
    const searchBar = el('div', 'hmv-search-bar')
    searchBar.hidden = true
    const searchInput = el('input', 'hmv-search-input')
    searchInput.type = 'search'
    searchInput.placeholder = '搜索本会话与全部会话内容…'
    searchInput.setAttribute('enterkeyhint', 'search')
    searchInput.setAttribute('autocomplete', 'off')
    const searchClose = el('button', 'hmv-icon')
    searchClose.type = 'button'
    searchClose.setAttribute('aria-label', '关闭搜索')
    searchClose.innerHTML = svgIcon(ICONS.x, 18)
    searchBar.append(searchInput, searchClose)
    const searchSummary = el('div', 'hmv-search-summary')
    searchSummary.hidden = true
    const composer = el('footer', 'hmv-composer')
    const modelPill = el('button', 'hmv-model-pill')
    modelPill.type = 'button'
    modelPill.hidden = true
    modelPill.setAttribute('aria-label', '切换本会话模型')
    modelPill.addEventListener('click', () => window.__hermesMVPages?.openModelPicker?.())
    const attachRow = el('div', 'hmv-attach-row')
    attachRow.hidden = true
    const composerRow = el('div', 'hmv-composer-row')
    const attachBtn = el('button', 'hmv-icon hmv-attach-btn')
    attachBtn.type = 'button'
    attachBtn.setAttribute('aria-label', '添加附件')
    attachBtn.innerHTML = svgIcon(ICONS.plus, 18)
    const input = el('textarea', 'hmv-input')
    input.rows = 1
    input.placeholder = '输入消息…'
    input.setAttribute('enterkeyhint', 'send')
    input.setAttribute('autocomplete', 'off')
    const send = el('button', 'hmv-send')
    send.type = 'button'
    send.setAttribute('aria-label', '发送')
    send.innerHTML = svgIcon(ICONS.send, 19)
    composerRow.append(attachBtn, input, send)
    composer.append(attachRow, composerRow)
    composer.append(modelPill)
    chatPage.append(stream, searchBar, searchSummary, composer)

    // 其余页面 section（内容由 pages 文件填充）
    const sections = { chat: chatPage }
    for (const id of ['sessions', 'files', 'tasks', 'skills', 'more', 'artifacts', 'commands', 'messaging', 'agents', 'content-search']) {
      sections[id] = makePage(id)
    }

    // 底部导航
    const nav = el('nav', 'hmv-nav')
    nav.setAttribute('aria-label', '主导航')
    const navButtons = {}
    for (const [id, icon, label] of NAV_ITEMS) {
      const btn = el('button', 'hmv-nav-item')
      btn.type = 'button'
      btn.dataset.nav = id
      btn.innerHTML = `<span class="hmv-nav-icon">${svgIcon(ICONS[icon])}</span><small>${label}</small>`
      btn.addEventListener('click', () => navigate(id))
      nav.append(btn)
      navButtons[id] = btn
    }

    const sheet = el('div', 'hmv-sheet')
    sheet.hidden = true
    const scrim = el('div', 'hmv-scrim')
    scrim.hidden = true
    const toastHolder = el('div', 'hmv-toast-holder')

    root.append(top, status, pagesEl, nav, scrim, sheet, toastHolder)
    document.body.append(root)

    ui = { root, statusRow: status, pagesEl, sections, stream, composer, attachRow, modelPill, input, send, attachBtn, backBtn, titleStrong, titleSmall, newBtn, nav, navButtons, scrim, sheet, toastHolder, searchBar, searchInput, searchClose, searchSummary, searchBtn }

    newBtn.addEventListener('click', () => void createSession())
    attachBtn.addEventListener('click', pickAttachments)
    searchBtn.addEventListener('click', () => {
      ui.searchBar.hidden = !ui.searchBar.hidden
      if (!ui.searchBar.hidden) {
        ui.searchInput.focus()
      } else {
        closeChatSearch()
      }
    })
    searchClose.addEventListener('click', () => {
      ui.searchBar.hidden = true
      closeChatSearch()
    })
    let searchTimer = null
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void runChatSearch(searchInput.value), SEARCH_DEBOUNCE_MS)
    })
    searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        if (searchStore.hits.length) jumpToHit(searchStore.idx + 1)
      }
    })
    send.addEventListener('click', () => {
      if (ui.send.dataset.mode === 'stop') void interruptSession()
      else void sendMessage()
    })
    input.addEventListener('input', () => {
      autoGrowInput()
      const entry = currentEntry()
      if (entry) {
        entry.draft = input.value
        writeDraft(entry.storedId, input.value)
      }
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && window.innerWidth > 500) {
        event.preventDefault()
        void sendMessage()
      }
    })
    stream.addEventListener('scroll', () => {
      const entry = currentEntry()
      if (entry) entry.scrollPin = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 140
    }, { passive: true })
    scrim.addEventListener('click', closeSheet)
  }

  // ── Android 返回键 ──────────────────────────────────────────────────

  const installBackHandler = () => {
    const previous = window.__hermesAndroidBack
    window.__hermesAndroidBack = () => {
      if (!ui?.root?.isConnected) return previous ? previous() : false
      // 登录层优先于本视图的一切导航：先收键盘，再取消登录。
      // 此前登录层开着按返回键会把视图切到聊天 tab（登录层毫无反应）。
      const loginOverlay = document.querySelector('[data-hermes-login-overlay]')
      if (loginOverlay) {
        const activeEl = document.activeElement
        if (activeEl && activeEl !== document.body && activeEl.matches?.('input, textarea')) {
          activeEl.blur()
          return true
        }
        loginOverlay.querySelector('[data-cancel]')?.click()
        return true
      }
      if (!ui.sheet.hidden) { closeSheet(); return true }
      if (document.querySelector('.hmv-dialog-overlay')) {
        document.querySelector('.hmv-dialog-overlay').remove()
        return true
      }
      if (document.querySelector('.hmv-img-overlay')) {
        document.querySelector('.hmv-img-overlay').remove()
        return true
      }
      if (!ui.searchBar.hidden) {
        closeChatSearch()
        return true
      }
      if (navStack.length) {
        popPage()
        return true
      }
      if (store.activeTab !== 'chat') {
        navigate('chat')
        return true
      }
      const active = document.activeElement
      if (active && active !== document.body && active.matches?.('input, textarea')) {
        active.blur()
        return true
      }
      return false
    }
  }

  // ── 连接管理 ────────────────────────────────────────────────────────

  let reconnectTimer = null

  const setConnection = state => {
    store.connection = state
    updateStatusRow()
  }

  const connectOnce = async () => {
    setConnection('connecting')
    try {
      const wsUrl = await desktop.getGatewayWsUrl()
      await client.connect(wsUrl)
      store.reconnectAttempt = 0
      store.connectError = ''
      setConnection('open')
      await refreshProfile()
      await refreshSessions()
      if (!store.currentId) {
        let lastSid = null
        try {
          const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
          if (saved?.conn === connId) lastSid = saved.sid
        } catch { /* ignore */ }
        const target = store.sessions.find(row => row.id === lastSid) || store.sessions[0]
        if (target) void openSession(target.id)
        else renderStream(null)
      }
      window.__hermesMVPages?.onConnected?.()
      return true
    } catch (error) {
      console.warn('[mobile-view] connect failed:', error?.message)
      store.connectError = String(error?.message || error)
      setConnection('error')
      return false
    }
  }

  const connectLoop = () => {
    clearTimeout(reconnectTimer)
    void (async () => {
      const ok = await connectOnce()
      if (ok) return
      store.reconnectAttempt += 1
      const delay = Math.min(30000, 1500 * 2 ** Math.min(store.reconnectAttempt, 5))
      reconnectTimer = setTimeout(connectLoop, delay)
    })()
  }

  client.onState(state => {
    if (state === 'closed') {
      setConnection('closed')
      connectLoop()
    }
  })
  client.channel.onServerRequest = handleServerRequest

  // ── 对外 API（pages 文件使用）───────────────────────────────────────

  window.__hermesMV = {
    version: MV_VERSION,
    el, esc, richText, relTime, clampText, toast,
    promptDialog, actionSheet, closeSheet, armConfirm, longPress,
    store, entryFor, currentEntry, entryByRuntime,
    rpc, rest, withProfile, refreshProfile, setProfile,
    refreshSessions, openSession, createSession, deleteSession,
    renderAttachmentChips,
    registerPage, navigate, pushPage, popPage, updateBadges, updateStatusRow, updateHeaderTitle,
    respondPendingRequest,
    openImageOverlay, resendFailed,
    notifyEnabled: () => notifyEnabled,
    setNotifyEnabled,
    notifyPreviewEnabled: () => notifyPreviewEnabled,
    setNotifyPreviewEnabled,
    get ui() { return ui }
  }

  // ── 启动 ────────────────────────────────────────────────────────────

  const start = () => {
    buildUi()
    registerEventHandlers()
    installBackHandler()
    registerPage('chat', { title: '聊天' })
    if (!pageRegistry.has('files')) registerPage('files', { title: '文件' })
    updateStatusRow()
    renderStream(null)
    navigate('chat')
    // 应用持久化的后台通知开关到原生层
    native()?.setNotifyEnabled?.(notifyEnabled)
    native()?.setNotifyPreviewEnabled?.(notifyPreviewEnabled)
    void (async () => {
      await refreshConnections()
      connectLoop()
    })()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
