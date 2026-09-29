// Keep the React shell inside the visible WebView when an Android keyboard
// changes only the visual viewport. adjustResize still handles devices where
// the layout viewport itself shrinks.
(() => {
  // The renderer currently calls URL.parse() in its skills/workspace panels,
  // but Android WebView versions shipped with supported devices may not yet
  // expose that newer static API. Match its null-on-invalid behavior.
  if (typeof URL.parse !== 'function') {
    URL.parse = (input, base) => {
      try { return new URL(input, base) } catch { return null }
    }
  }

  const viewport = window.visualViewport
  const root = document.documentElement
  const isConversationHash = hash => /^#\/\d{8}_\d{6}_[a-zA-Z0-9_-]+$/.test(hash || '')
  let lastConversationHash = isConversationHash(window.location.hash) ? window.location.hash : null
  const rememberConversationHash = () => {
    if (isConversationHash(window.location.hash)) lastConversationHash = window.location.hash
  }

  window.addEventListener('hashchange', () => {
    if (isConversationHash(window.location.hash)) lastConversationHash = window.location.hash
  })

  const dismissMobileKeyboard = () => {
    const active = document.activeElement
    if (active && active !== document.body && typeof active.blur === 'function') active.blur()
  }

  // Phase 1: replace fixed-delay races with polling that resolves as soon as
  // the target appears (or after a bounded timeout).
  const waitFor = (found, timeout = 800, step = 60) => new Promise(resolve => {
    const began = Date.now()
    const tick = () => {
      const value = found()
      if (value) return resolve(value)
      if (Date.now() - began >= timeout) return resolve(null)
      setTimeout(tick, step)
    }
    tick()
  })

  // Phase 1: chrome geometry has a single source — the real rendered heights
  // of the three bars are published as CSS variables (initial values live in
  // mobile-touch.css :root) and every fixed inset references them.
  let geometryRaf = 0
  const measureChromeGeometry = () => {
    for (const [name, selector] of [
      ['--hm-top', '.hermes-mobile-topbar'],
      ['--hm-quick', '.hermes-mobile-quickbar'],
      ['--hm-nav', '.hermes-mobile-bottom-nav']
    ]) {
      const bar = document.querySelector(selector)
      if (!bar) continue
      const height = Math.round(bar.getBoundingClientRect().height)
      if (height > 0) root.style.setProperty(name, `${height}px`)
    }
  }
  const scheduleGeometry = () => {
    cancelAnimationFrame(geometryRaf)
    geometryRaf = requestAnimationFrame(measureChromeGeometry)
  }

  // Phase 1: follow the renderer theme. The chrome used to be a hard-coded
  // dark slab inside light sessions; data-hm-theme switches the token set.
  const syncTheme = () => {
    const html = document.documentElement
    let light = null
    if (html.classList.contains('dark')) light = false
    else if (html.classList.contains('light')) light = true
    if (light === null) {
      const bg = getComputedStyle(document.body).backgroundColor
      const parts = bg.match(/\d+/g)
      if (parts && parts.length >= 3) {
        light = (0.2126 * +parts[0] + 0.7152 * +parts[1] + 0.0722 * +parts[2]) / 255 > 0.5
      }
    }
    if (light === true) root.dataset.hmTheme = 'light'
    else if (light === false) delete root.dataset.hmTheme
  }

  const syncViewport = () => {
    const height = Math.max(240, Math.round(viewport?.height ?? window.innerHeight))
    root.style.setProperty('--hermes-mobile-viewport-height', `${height}px`)
    const focusedTextInput = document.activeElement?.matches?.('input, textarea, [contenteditable="true"]')
    const keyboardVisible = focusedTextInput && (window.screen.height - height) > 120
    if (keyboardVisible) root.dataset.hermesMobileKeyboard = 'true'
    else delete root.dataset.hermesMobileKeyboard
  }

  const startupBeganAt = Date.now()
  let startupReady = false
  let startupNotice = null
  let startupTimer = null
  const stopStartupWatch = () => {
    if (startupTimer !== null) window.clearInterval(startupTimer)
    startupTimer = null
  }
  const updateStartupNotice = () => {
    // Terminal states stop the poll. The WS-state event listener below still
    // refreshes the notice on reconnects even after the interval is gone.
    if (window.innerWidth > 767 || startupReady) {
      stopStartupWatch()
      startupNotice?.remove()
      startupNotice = null
      return
    }
    const route = window.location.hash.slice(1).split('?')[0]
    // Cheap hash check first: the settings/profiles routes must not pay for
    // the heading scan below on every poll.
    if (/^\/(settings|profiles)(?:\/|$)/.test(route)) {
      startupNotice?.remove()
      startupNotice = null
      return
    }
    const recoveryVisible = Boolean(document.querySelector('[data-boot-failure-card]')) ||
      [...document.querySelectorAll('h1,h2,h3')]
        .some(heading => /Hermes (?:无法启动|couldn't start)/.test(heading.textContent || ''))
    if (recoveryVisible) {
      // The recovery card owns the screen and its retry reloads the page.
      stopStartupWatch()
      startupNotice?.remove()
      startupNotice = null
      return
    }
    const modelReady = document.querySelector('button[aria-label^="模型 ·"], button[aria-label^="Model ·"]')
    if (modelReady) {
      startupReady = true
      stopStartupWatch()
      startupNotice?.remove()
      startupNotice = null
      return
    }
    const elapsed = Date.now() - startupBeganAt
    if (elapsed < 5000 || !document.querySelector('.hermes-mobile-topbar')) return
    if (!startupNotice) {
      startupNotice = document.createElement('div')
      startupNotice.className = 'hermes-mobile-startup-notice'
      startupNotice.setAttribute('role', 'status')
      const message = document.createElement('span')
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = '重新加载'
      retry.addEventListener('click', () => window.location.reload())
      startupNotice.append(message, retry)
      document.body.append(startupNotice)
    }
    const state = window.__hermesMobileWsState
    startupNotice.querySelector('span').textContent = state === 'open'
      ? '网关已连接，正在恢复会话…'
      : state === 'error' || state === 'closed'
        ? '网关连接失败，正在重试…'
        : '正在连接网关…'
    startupNotice.querySelector('button').hidden = elapsed < 20000 && state !== 'error' && state !== 'closed'
  }

  const tuneComposer = () => {
    const input = document.querySelector('[data-slot="composer-rich-input"]')
    if (!input || input.getAttribute('enterkeyhint') === 'send') return
    input.setAttribute('enterkeyhint', 'send')
    input.setAttribute('inputmode', 'text')
  }

  const hideUnavailableRecoveryActions = () => {
    const card = document.querySelector('[data-boot-failure-card="recovery"]') ||
      [...document.querySelectorAll('button')]
        .find(button => /^(Use local gateway|使用本地网关)$/.test(button.textContent.trim()))
        ?.closest('div.relative.w-full')
    // The desktop recovery actions are unavailable on Android even when the
    // card wrapper selector above fails to match the current renderer layout.
    const buttonScope = card ?? document
    for (const button of buttonScope.querySelectorAll('button')) {
      if (/^(Repair install|Use local gateway|修复安装|使用本地网关)$/.test(button.textContent.trim())) {
        button.style.display = 'none'
      }
    }
    for (const paragraph of document.querySelectorAll('p')) {
      if (/Use local gateway to switch|switch to the local gateway|切换到本地网关/i.test(paragraph.textContent)) {
        paragraph.textContent = paragraph.textContent.replace(/\s*(?:,?\s*or\s+switch to the local gateway\.?|Use local gateway to switch|，?或切换到本地网关).*$/i, '')
      } else if (/^(Repair re-runs the installer|修复会重新运行安装)/.test(paragraph.textContent)) {
        paragraph.style.display = 'none'
      }
    }
  }

  const hideDesktopOnlyCues = () => {
    if (window.innerWidth > 1024) return
    // Process each element once; React keeps re-mounting these lists while
    // streaming, and the sentinel keeps the cost proportional to new nodes.
    for (const button of document.querySelectorAll('button:not([data-hm-cue])')) {
      button.dataset.hmCue = '1'
      const label = button.textContent.replace(/\s+/g, ' ').trim()
      if (/^(搜索|Search)\s*Ctrl\s*K$/i.test(label) && button.parentElement?.classList.contains('absolute')) {
        button.parentElement.style.display = 'none'
      }
    }
    for (const item of document.querySelectorAll('[role="menuitem"]:not([data-hm-cue])')) {
      item.dataset.hmCue = '1'
      if (/^(This device|此设备|本机|文件夹…|Folder…|Folder\.\.\.)$/.test(item.textContent.trim())) {
        item.style.display = 'none'
      }
    }
  }

  // Recent gateway versions include an image's server-side file path in the
  // user message text. Resolve only Hermes-generated image paths through the
  // authenticated gateway filesystem API, then render an in-chat thumbnail.
  const imageData = new Map()
  const imagePathPattern = /\[Image attached at:\s*(\/[^\]\r\n]*\/\.hermes\/images\/upload_[\w.-]+\.(?:png|jpe?g|webp|gif))\s*\]/i
  const addImagePreviews = () => {
    for (const text of document.querySelectorAll('[data-slot="aui_user-inline-text"]')) {
      const match = imagePathPattern.exec(text.textContent || '')
      if (!match) continue
      const host = text.closest('.human-message-with-todos-wrapper') || text.parentElement
      if (!host || host.querySelector(':scope > [data-hermes-image-preview]')) continue
      const path = match[1]
      const preview = document.createElement('div')
      preview.dataset.hermesImagePreview = 'true'
      preview.setAttribute('aria-live', 'polite')
      preview.textContent = '正在加载图片…'
      host.append(preview)
      void loadImagePreview(path, host, preview)
    }
  }

  const loadImagePreview = async (path, host, placeholder) => {
    try {
      let dataUrl = imageData.get(path)
      if (!dataUrl) {
        const result = await window.hermesDesktop?.api?.({
          path: `/api/fs/read-data-url?path=${encodeURIComponent(path)}`
        })
        dataUrl = typeof result === 'string' ? result : result?.dataUrl
        if (!dataUrl?.startsWith('data:image/')) throw new Error('图片数据不可用')
        imageData.set(path, dataUrl)
      }
      if (!host.isConnected) return
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.hermesImagePreview = 'true'
      button.className = 'hermes-mobile-image-thumb'
      button.setAttribute('aria-label', '打开图片并缩放')
      const image = document.createElement('img')
      image.src = dataUrl
      image.alt = '消息中的图片，点按查看并双指缩放'
      button.append(image)
      button.addEventListener('click', () => openImageViewer(dataUrl))
      const messageTexts = host.querySelectorAll('[data-slot="aui_directive-text"]')
      for (const messageText of messageTexts) {
        const walker = document.createTreeWalker(messageText, NodeFilter.SHOW_TEXT)
        const nodes = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        for (const node of nodes) {
          node.nodeValue = node.nodeValue.replace(imagePathPattern, '').replace(/\[screenshot\]/ig, '')
        }
      }
      if (placeholder.isConnected) placeholder.replaceWith(button)
    } catch (error) {
      if (placeholder) placeholder.textContent = '图片预览暂不可用'
    }
  }

  const openImageViewer = dataUrl => {
    if (document.querySelector('[data-hermes-image-viewer]')) return
    const overlay = document.createElement('div')
    overlay.dataset.hermesImageViewer = 'true'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', '图片查看器')
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'hermes-mobile-image-close'
    close.setAttribute('aria-label', '关闭图片')
    close.textContent = '×'
    const image = document.createElement('img')
    image.src = dataUrl
    image.alt = '图片，可双指缩放并拖动'
    overlay.append(image, close)
    const dismiss = () => overlay.remove()
    close.addEventListener('click', dismiss)
    overlay.addEventListener('click', event => { if (event.target === overlay) dismiss() })
    const keyHandler = event => { if (event.key === 'Escape') dismiss() }
    overlay.addEventListener('keydown', keyHandler)
    let touchStart = null
    let scale = 1
    let x = 0
    let y = 0
    const distance = touches => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    )
    const paint = () => { image.style.transform = `translate(${x}px, ${y}px) scale(${scale})` }
    image.addEventListener('touchstart', event => {
      if (event.touches.length === 2) touchStart = { distance: distance(event.touches), scale }
      else if (event.touches.length === 1 && scale > 1) touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY, offsetX: x, offsetY: y }
    }, { passive: true })
    image.addEventListener('touchmove', event => {
      if (event.touches.length === 2 && touchStart?.distance) {
        scale = Math.max(1, Math.min(5, touchStart.scale * distance(event.touches) / touchStart.distance))
        paint()
        event.preventDefault()
      } else if (event.touches.length === 1 && touchStart && touchStart.distance === undefined && scale > 1) {
        x = touchStart.offsetX + event.touches[0].clientX - touchStart.x
        y = touchStart.offsetY + event.touches[0].clientY - touchStart.y
        paint()
      }
    }, { passive: false })
    image.addEventListener('touchend', event => {
      if (!event.touches.length) touchStart = null
    }, { passive: true })
    document.body.append(overlay)
    close.focus()
  }

  // ── Phase 2: Session list empty / loading states ────────────────────────

  const SESSION_HINT_KEY = 'hermes-mobile-session-hint-seen'

  const renderSessionEmptyState = container => {
    if (container.querySelector('.hermes-mobile-session-empty')) return
    const el = document.createElement('div')
    el.className = 'hermes-mobile-session-empty'
    el.setAttribute('aria-label', '暂无会话')
    el.innerHTML = `
      <div class="hermes-mobile-session-empty-icon">▤</div>
      <p>还没有会话。<br>点击左上角新建一个吧。</p>
    `
    container.appendChild(el)
  }

  const renderSessionLoadingState = container => {
    if (container.querySelector('.hermes-mobile-session-loading')) return
    const el = document.createElement('div')
    el.className = 'hermes-mobile-session-loading'
    el.setAttribute('aria-label', '加载中')
    el.innerHTML = '<span></span><span></span><span></span>'
    container.appendChild(el)
  }

  const clearSessionOverlayStates = container => {
    container.querySelector('.hermes-mobile-session-empty')?.remove()
    container.querySelector('.hermes-mobile-session-loading')?.remove()
  }

  // Observe session list mutations to inject/clear overlay states.
  let sessionListObserver = null
  const watchSessionList = () => {
    const container = document.querySelector('[data-slot="sidebar-content"]')
    if (!container || sessionListObserver) return

    // Debounce to avoid flicker on rapid mutations.
    let debounceTimer = null
    const refresh = () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const rows = container.querySelectorAll(
          '[data-slot="row-button"], [data-sidebar="row"], [class*="session-row"]'
        )
        const isLoading = container.querySelector('[data-loading], [aria-busy="true"]')
        clearSessionOverlayStates(container)
        if (isLoading) {
          renderSessionLoadingState(container)
        } else if (rows.length === 0) {
          renderSessionEmptyState(container)
        }
      }, 300)
    }

    sessionListObserver = new MutationObserver(records => {
      if (records.some(r => r.addedNodes.length || r.removedNodes.length)) {
        refresh()
      }
    })
    sessionListObserver.observe(container, { childList: true, subtree: true })
    refresh()
  }

  // ── Phase 2: Long-press hint for context menu ──────────────────────────

  const showSessionLongPressHint = row => {
    if (sessionStorage.getItem(SESSION_HINT_KEY)) return
    sessionStorage.setItem(SESSION_HINT_KEY, '1')
    const existing = document.querySelector('.hermes-mobile-session-hint')
    if (existing) return
    const hint = document.createElement('div')
    hint.className = 'hermes-mobile-session-hint'
    hint.setAttribute('role', 'status')
    hint.innerHTML = '⏱ 长按行可呼出更多操作'
    document.body.appendChild(hint)
    // Auto-fade after 8s
    setTimeout(() => {
      hint.classList.add('fade-out')
      setTimeout(() => hint.remove(), 700)
    }, 8000)
  }

  // Bind long-press detection on session rows without interfering with tap.
  const bindSessionRowLongPress = () => {
    const container = document.querySelector('[data-slot="sidebar-content"]')
    if (!container || container.dataset.hmLongPressBound) return
    container.dataset.hmLongPressBound = '1'

    let pressTimer = null
    let didLongPress = false

    container.addEventListener('touchstart', event => {
      const row = event.target.closest?.('[data-slot="row-button"], [data-sidebar="row"], [class*="session-row"]')
      if (!row) return
      didLongPress = false
      pressTimer = setTimeout(() => {
        didLongPress = true
        showSessionLongPressHint(row)
        // Also trigger the native context menu on the row
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        row.dispatchEvent(event)
      }, 600)
    }, { passive: true })

    container.addEventListener('touchend', () => {
      clearTimeout(pressTimer)
    }, { passive: true })

    container.addEventListener('touchmove', () => {
      clearTimeout(pressTimer)
    }, { passive: true })

    container.addEventListener('touchcancel', () => {
      clearTimeout(pressTimer)
    }, { passive: true })
  }

  const tunePage = () => {
    syncTheme()
    tuneComposer()
    hideUnavailableRecoveryActions()
    hideDesktopOnlyCues()
    ensureAgentConfigSwitcher()
    ensureMobileNavigationShell()
    addImagePreviews()
    watchSessionList()
    bindSessionRowLongPress()
  }

  // Route-scoped tuning (settings geometry, strip swiping) only needs to run
  // when the route changes, not on every DOM mutation; the selectors involved
  // are the most expensive in the file.
  const tuneRoute = () => {
    tuneSettingsLayout()
    bindSettingsStrip()
  }

  // Profiles are first-class Hermes agent configurations. The desktop
  // renderer already owns switching semantics; this gives phone users a
  // readable entry point and delegates each selection to its existing
  // profile control instead of mutating profile state through a second API.
  let agentProfileName = 'default'
  let agentProfiles = []
  let agentProfileOverlay = null
  let agentProfileButton = null
  let agentProfileInitialized = false

  const loadAgentProfiles = async () => {
    const api = window.hermesDesktop?.api
    if (!api) return
    const [profileResult, activeResult] = await Promise.allSettled([
      api({ path: '/api/profiles', timeoutMs: 5000 }),
      api({ path: '/api/profiles/active', timeoutMs: 5000 })
    ])
    if (profileResult.status === 'fulfilled') {
      agentProfiles = Array.isArray(profileResult.value?.profiles) ? profileResult.value.profiles : []
    }
    if (!agentProfileInitialized && activeResult.status === 'fulfilled') {
      agentProfileName = activeResult.value?.current || activeResult.value?.active || agentProfileName
    }
    if (!agentProfiles.some(profile => profile.name === agentProfileName) && agentProfiles.length) {
      agentProfileName = agentProfiles.find(profile => profile.is_default)?.name || agentProfiles[0].name
    }
    agentProfileInitialized = true
    updateAgentProfileButton()
  }

  const updateAgentProfileButton = () => {
    if (!agentProfileButton) return
    agentProfileButton.textContent = `Agent · ${agentProfileName}`
    agentProfileButton.setAttribute('aria-label', `切换 Agent 配置，当前 ${agentProfileName}`)
  }

  const closeAgentProfilePicker = () => {
    agentProfileOverlay?.remove()
    agentProfileOverlay = null
    agentProfileButton?.focus({ preventScroll: true })
  }

  const openAgentProfilePicker = async () => {
    await loadAgentProfiles()
    if (agentProfileOverlay) return
    const overlay = document.createElement('div')
    overlay.className = 'hermes-mobile-agent-overlay'
    overlay.dataset.hermesAgentProfilePicker = 'true'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', '切换 Agent 配置')
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeAgentProfilePicker()
    })
    const dismissHub = () => {
      overlay.classList.remove('hm-hub-visible')
      setTimeout(() => overlay.remove(), 230)
    }
    close.addEventListener('click', dismissHub)
    overlay.addEventListener('click', event => {
      if (event.target === overlay) dismissHub()
    })

    const sheet = document.createElement('section')
    sheet.className = 'hermes-mobile-agent-sheet'
    const header = document.createElement('header')
    header.className = 'hermes-mobile-agent-header'
    const heading = document.createElement('div')
    const title = document.createElement('h2')
    title.textContent = '选择 Agent 配置'
    const subtitle = document.createElement('p')
    subtitle.textContent = '切换后，新消息将使用所选配置的指令、模型和技能。'
    heading.append(title, subtitle)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'hermes-mobile-agent-close'
    close.setAttribute('aria-label', '关闭 Agent 配置')
    close.setAttribute('data-slot', 'dialog-close')
    close.textContent = '×'
    close.addEventListener('click', closeAgentProfilePicker)
    header.append(heading, close)
    sheet.append(header)

    if (!agentProfiles.length) {
      const empty = document.createElement('p')
      empty.className = 'hermes-mobile-agent-empty'
      empty.textContent = '暂时无法读取配置列表，请检查网关连接后重试。'
      sheet.append(empty)
    } else {
      const list = document.createElement('div')
      list.className = 'hermes-mobile-agent-list'
      for (const profile of agentProfiles) {
        if (!profile?.name) continue
        const option = document.createElement('button')
        option.type = 'button'
        option.className = 'hermes-mobile-agent-option'
        option.setAttribute('aria-pressed', String(profile.name === agentProfileName))
        const copy = document.createElement('span')
        copy.className = 'hermes-mobile-agent-copy'
        const name = document.createElement('strong')
        name.textContent = profile.name
        const details = document.createElement('small')
        const model = [profile.provider, profile.model].filter(Boolean).join(' · ')
        details.textContent = `${profile.is_default ? '默认配置' : 'Agent 配置'}${model ? ` · ${model}` : ''}`
        copy.append(name, details)
        const check = document.createElement('span')
        check.className = 'hermes-mobile-agent-check'
        check.textContent = profile.name === agentProfileName ? '✓' : '›'
        option.append(copy, check)
        option.addEventListener('click', async () => {
          const findSelector = () => [...document.querySelectorAll('button[aria-label]')].find(button => {
            const label = button.getAttribute('aria-label') || ''
            // Default profile buttons append unread-session counts with a
            // comma, while non-default profiles use an em dash for the host.
            return label === profile.name || label.startsWith(`${profile.name} —`) || label.startsWith(`${profile.name},`)
          })
          let selector = findSelector()
          // Hermes mounts its real profile switcher in the session sidebar.
          // Open that native control when the drawer is collapsed, then use
          // the same click path as desktop so connection/session state follows.
          if (!selector) {
            document.querySelector('button[aria-label*="侧边栏"]')?.click()
            selector = await waitFor(findSelector)
          }
          if (!selector) {
            const message = document.createElement('p')
            message.className = 'hermes-mobile-agent-empty'
            message.textContent = '当前页面暂未找到 Hermes 配置切换入口，请重新打开选择器。'
            list.replaceChildren(message)
            return
          }
          selector.click()
          agentProfileName = profile.name
          updateAgentProfileButton()
          closeAgentProfilePicker()
        })
        list.append(option)
      }
      sheet.append(list)
    }

    const manage = document.createElement('button')
    manage.type = 'button'
    manage.className = 'hermes-mobile-agent-manage'
    manage.textContent = '管理配置档案　›'
    manage.addEventListener('click', () => {
      closeAgentProfilePicker()
      window.location.hash = '#/profiles'
    })
    sheet.append(manage)
    overlay.append(sheet)
    document.body.append(overlay)
    agentProfileOverlay = overlay
    close.focus({ preventScroll: true })
  }

  const ensureAgentConfigSwitcher = () => {
    if (window.innerWidth > 767 || !document.body) return
    // Settings and profile management have their own top controls. Keep the
    // floating chat shortcut out of those routes so it never covers a tab or
    // close button.
    if (/^\/(settings|profiles)(?:\/|$)/.test(window.location.hash.slice(1).split('?')[0])) {
      agentProfileButton?.remove()
      agentProfileButton = null
      return
    }
    if (!agentProfileButton?.isConnected) {
      agentProfileButton = document.createElement('button')
      agentProfileButton.type = 'button'
      agentProfileButton.className = 'hermes-mobile-agent-trigger'
      agentProfileButton.dataset.hermesAgentConfig = 'true'
      agentProfileButton.addEventListener('click', openAgentProfilePicker)
      document.body.append(agentProfileButton)
      updateAgentProfileButton()
      void loadAgentProfiles().catch(() => {})
    }
  }

  const setMobileSessionDrawer = open => {
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    const drawer = sidebar?.parentElement
    if (!drawer) return
    if (open) {
      // 属性决定 DOM 存在性；class 驱动 CSS transition
      drawer.dataset.hermesMobileSessionDrawer = 'true'
      // 下帧加上 open class，触发 translateX(-100%) → 0 的过渡
      requestAnimationFrame(() => drawer.classList.add('hm-drawer-open'))
    } else {
      drawer.classList.remove('hm-drawer-open')
      // 等动画结束后再移除属性（否则元素从右滑出很突兀）
      if (drawer._drawerCloseTimer) clearTimeout(drawer._drawerCloseTimer)
      drawer._drawerCloseTimer = setTimeout(() => {
        drawer.removeAttribute('data-hermes-mobile-session-drawer')
        drawer._drawerCloseTimer = null
      }, 240)
    }
    const title = document.querySelector('.hermes-mobile-title strong')
    if (title) title.textContent = open ? '会话' : 'Hermes 助手'
  }

  const openMobileHub = kind => {
    document.querySelector('[data-hermes-mobile-hub]')?.remove()
    const content = kind === 'tools'
      ? [
          ['capabilities', '技能与工具', '管理技能、MCP 服务和能力开关', '#/capabilities'],
          ['artifacts', '文件产物', '查找会话生成的文件和报告', '#/artifacts'],
          ['cron', '定时任务', '查看和管理自动运行的任务', '#/cron'],
          ['messaging', '消息平台', '管理 Telegram、Discord 等接入', '#/messaging'],
          ['webhooks', 'Webhook', '查看 Webhook 连接和事件', '#/webhooks']
        ]
      : [
          ['profiles', 'Agent 配置档案', '创建、导入和管理多个 Agent 配置', '#/profiles'],
          ['settings', '设置', '模型、外观、连接、安全和其他选项', '#/settings'],
          ['command-center', '命令中心', '查找并运行可用命令', '#/command-center'],
          ['agents', 'Agents', '查看 Agent 工作状态和管理选项', '#/agents'],
          ['starmap', 'StarMap', '查看任务和技能关系图', '#/starmap']
        ]
    const overlay = document.createElement('section')
    overlay.dataset.hermesMobileHub = kind
    overlay.className = 'hermes-mobile-hub'
    overlay.setAttribute('aria-label', kind === 'tools' ? '工具与能力' : '更多功能')
    const header = document.createElement('header')
    header.className = 'hermes-mobile-hub-header'
    const heading = document.createElement('h2')
    heading.textContent = kind === 'tools' ? '工具与能力' : '更多'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'hermes-mobile-icon'
    close.setAttribute('aria-label', '关闭导航页')
    close.textContent = '×'
    const dismissHub = () => {
      overlay.classList.remove('hm-hub-visible')
      setTimeout(() => overlay.remove(), 230)
    }
    close.addEventListener('click', dismissHub)
    overlay.addEventListener('click', event => {
      if (event.target === overlay) dismissHub()
    })
    header.append(heading, close)
    const list = document.createElement('div')
    list.className = 'hermes-mobile-hub-list'
    for (const [key, label, description, route] of content) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'hermes-mobile-hub-row'
      row.dataset.routeKey = key
      row.innerHTML = `<span class="hermes-mobile-hub-icon">${key === 'settings' ? '⚙' : key === 'profiles' ? '◉' : key === 'artifacts' ? '▧' : key === 'cron' ? '◷' : key === 'messaging' ? '✉' : key === 'webhooks' ? '↗' : '⌘'}</span><span class="hermes-mobile-hub-copy"><strong>${label}</strong><small>${description}</small></span><span class="hermes-mobile-hub-chevron">›</span>`
      row.addEventListener('click', () => {
        rememberConversationHash()
        dismissHub()
        setTimeout(() => { window.location.hash = route }, 240)
      })
      list.append(row)
    }
    overlay.append(header, list)
    document.body.append(overlay)
    // Trigger slide-up animation on next paint
    requestAnimationFrame(() => overlay.classList.add('hm-hub-visible'))
    overlay.querySelector('button')?.focus({ preventScroll: true })
  }

  // Keep the visual proxy in step with the renderer's real model selector.
  // The proxy can lag if the real button mounts without a later mutation
  // batch, so chrome creation additionally waits for it explicitly.
  const syncModelPill = () => {
    const pill = document.querySelector('[data-hermes-mobile-chrome] .hermes-mobile-model-display')
    if (!pill) return
    const label = document.querySelector('button[aria-label^="模型 ·"], button[aria-label^="Model ·"]')?.getAttribute('aria-label')
    if (!label) {
      pill.hidden = true
      return
    }
    const modelLabel = label.replace(/^(模型|Model)\s*[·:]\s*/, '模型 · ')
    if (pill.textContent !== modelLabel) pill.textContent = modelLabel
    pill.hidden = false
  }

  const ensureMobileNavigationShell = () => {
    if (window.innerWidth > 767 || !document.body) return
    const mobileRoute = window.location.hash.slice(1).split('?')[0]
    const isSettings = /^\/(settings|profiles)(?:\/|$)/.test(mobileRoute)
    let chrome = document.querySelector('[data-hermes-mobile-chrome]')
    if (isSettings) {
      chrome?.remove()
      const activeSettings = document.querySelector('button[aria-label="关闭设置"], button[aria-label="Close settings"]')
      if (activeSettings) activeSettings.dataset.hermesMobileSettingsActive = 'true'
      return
    }
    if (!chrome) {
      chrome = document.createElement('div')
      chrome.dataset.hermesMobileChrome = 'true'
      chrome.className = 'hermes-mobile-chrome'

      const header = document.createElement('header')
      header.className = 'hermes-mobile-topbar'
      const menu = document.createElement('button')
      menu.className = 'hermes-mobile-icon'
      menu.type = 'button'
      menu.setAttribute('aria-label', '打开会话导航')
      menu.textContent = '☰'
      menu.addEventListener('click', () => {
        dismissMobileKeyboard()
        const open = !sidebarIsOpen()
        sidebarToggle()?.click()
        setTimeout(() => setMobileSessionDrawer(open), 0)
      })
      const title = document.createElement('div')
      title.className = 'hermes-mobile-title'
      title.innerHTML = '<strong>Hermes 助手</strong><small>移动工作台</small>'
      const fresh = document.createElement('button')
      fresh.className = 'hermes-mobile-icon'
      fresh.type = 'button'
      fresh.setAttribute('aria-label', '新会话')
      fresh.textContent = '＋'
      fresh.addEventListener('click', () => {
        const choose = () => [...document.querySelectorAll('button')].find(button => /^(新建会话|New chat|New conversation)/i.test(button.textContent.trim()))
        const button = choose()
        if (button) {
          button.click()
          return
        }
        sidebarToggle()?.click()
        void waitFor(choose).then(found => found?.click())
      })
      // Visual proxy for the model selector — see the stacking-context note in
      // mobile-touch.css; the real button stays hit-testable underneath.
      const modelDisplay = document.createElement('div')
      modelDisplay.className = 'hermes-mobile-model-display'
      modelDisplay.setAttribute('aria-hidden', 'true')
      modelDisplay.hidden = true
      header.append(menu, title, fresh)

      const quickbar = document.createElement('div')
      quickbar.className = 'hermes-mobile-quickbar'
      const agentSlot = document.createElement('div')
      agentSlot.className = 'hermes-mobile-agent-slot'
      quickbar.append(agentSlot)

      const nav = document.createElement('nav')
      nav.className = 'hermes-mobile-bottom-nav'
      nav.setAttribute('aria-label', '主导航')
      const items = [
        ['chat', '◉', '聊天'],
        ['sessions', '▤', '会话'],
        ['tools', '⌘', '工具'],
        ['more', '•••', '更多']
      ]
      for (const [id, icon, label] of items) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.mobileNav = id
        button.className = 'hermes-mobile-nav-item'
        if (id === 'chat') button.classList.add('active')
        button.innerHTML = `<span>${icon}</span><small>${label}</small>`
        button.addEventListener('click', () => {
          dismissMobileKeyboard()
          document.querySelector('[data-hermes-mobile-hub]')?.remove()
          if (id === 'chat') {
            closeSidebar()
            setMobileSessionDrawer(false)
            if (lastConversationHash && window.location.hash !== lastConversationHash) {
              window.location.hash = lastConversationHash
            }
          }
          else if (id === 'sessions') {
            const open = !sidebarIsOpen()
            sidebarToggle()?.click()
            setTimeout(() => setMobileSessionDrawer(open), 0)
          } else openMobileHub(id)
          nav.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button))
        })
        nav.append(button)
      }
      const settings = document.createElement('button')
      settings.type = 'button'
      settings.className = 'hermes-mobile-settings-link'
      settings.setAttribute('aria-label', '设置')
      settings.textContent = '⚙'
      settings.addEventListener('click', () => document.querySelector('button[aria-label="打开设置"], button[aria-label="Open settings"]')?.click())
      quickbar.append(settings)

      chrome.append(header, quickbar, nav)
      chrome.append(modelDisplay)
      document.body.append(chrome)
      // Measure the real bar heights (font scale / wrap can change them) and
      // keep the CSS variables in sync from then on.
      const geometryObserver = new ResizeObserver(scheduleGeometry)
      for (const bar of chrome.querySelectorAll('.hermes-mobile-topbar, .hermes-mobile-quickbar, .hermes-mobile-bottom-nav')) {
        geometryObserver.observe(bar)
      }
      scheduleGeometry()
      // Close the mount-timing hole: the model button may appear after the
      // last mutation batch, so poll for it once instead of relying on tunePage.
      void waitFor(syncModelPill, 15000, 250)
    }

    const shell = document.querySelector('#root > div > .contents > div.flex.h-screen')
    if (shell) {
      shell.dataset.hermesMobileAppShell = 'true'
      const titlebar = [...shell.children].find(element => String(element.className).includes('h-[34px]'))
      const footer = shell.querySelector(':scope > footer[data-slot="statusbar"]')
      if (titlebar) titlebar.dataset.hermesDesktopTitlebar = 'true'
      if (footer) footer.dataset.hermesDesktopStatusbar = 'true'
    }
    const agentSlot = chrome.querySelector('.hermes-mobile-agent-slot')
    if (agentSlot && agentProfileButton && agentProfileButton.parentElement !== agentSlot) agentSlot.append(agentProfileButton)
    syncModelPill()

    const chat = [...document.querySelectorAll('[class*="ui-chat-surface-background"]')]
      .find(element => element.classList.contains('isolate') && element.classList.contains('h-full'))
    if (chat) chat.dataset.hermesMobileChatSurface = 'true'
  }

  // The packaged WebView's CSSOM can omit the mobile override for the
  // desktop settings backdrop. Apply the narrow-screen geometry directly so
  // the dialog uses the phone width as soon as the settings route mounts.
  const tuneSettingsLayout = () => {
    if (window.innerWidth > 767) return
    const backdrop = document.querySelector('.fixed.inset-0.z-50[class*="backdrop-blur"]')
    if (!backdrop) return
    backdrop.style.setProperty('padding', '8px 12px', 'important')

    const strip = backdrop.querySelector('.grid:has(> aside [data-tour="nav-gateway"]) > aside')
    if (strip) {
      // The close control is absolutely positioned over the first row. Keep
      // a dedicated 64px lane on the right so tab labels and the X never
      // occupy the same hit area.
      strip.style.setProperty('width', 'calc(100% - 64px)', 'important')
      strip.style.setProperty('justify-self', 'start', 'important')
    }
  }

  // Android WebView did not perform native pan-x scrolling on the settings
  // rail because each tab is itself a button. Drive its scroll position from
  // horizontal touch movement and suppress the resulting accidental click.
  const bindSettingsStrip = () => {
    const strip = document.querySelector('.grid:has(> aside [data-tour="nav-gateway"]) > aside')
    if (!strip || strip.dataset.mobileSwipeBound) return
    strip.dataset.mobileSwipeBound = 'true'
    let start = null
    let draggedUntil = 0
    strip.addEventListener('touchstart', event => {
      if (window.innerWidth > 767 || event.touches.length !== 1) return
      const touch = event.touches[0]
      start = { x: touch.clientX, y: touch.clientY, left: strip.scrollLeft, dragged: false }
    }, { passive: true })
    strip.addEventListener('touchmove', event => {
      const touch = event.touches[0]
      if (!start || !touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return
      start.dragged = true
      strip.scrollLeft = start.left - dx
      if (event.cancelable) event.preventDefault()
    }, { passive: false })
    strip.addEventListener('touchend', () => {
      if (start?.dragged) draggedUntil = Date.now() + 350
      start = null
    }, { passive: true })
    strip.addEventListener('touchcancel', () => { start = null }, { passive: true })
    strip.addEventListener('click', event => {
      if (Date.now() > draggedUntil) return
      event.preventDefault()
      event.stopImmediatePropagation()
      draggedUntil = 0
    }, true)
  }

  const closeSidebar = () => {
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    if (!sidebar || sidebar.getBoundingClientRect().width < 100) return false
    const button = document.querySelector('button[aria-label^="隐藏侧边栏"], button[aria-label^="Hide sidebar"]')
    if (!button || !button.getClientRects().length) return false
    button.click()
    return true
  }

  const sidebarToggle = () => document.querySelector(
    'button[aria-label*="侧边栏"], button[aria-label*="sidebar"]'
  )
  const sidebarIsOpen = () => {
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    return Boolean(sidebar && sidebar.getBoundingClientRect().width >= 100)
  }
  const finishDrawerSwipe = (start, touch) => {
    if (!start || !touch) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    const toggle = sidebarToggle()
    if (!toggle) return
    if (start.open && dx < 0) setTimeout(closeSidebar, 0)
    else if (!start.open && dx > 0 && !sidebarIsOpen()) setTimeout(() => toggle.click(), 0)
  }

  // Drawer gestures only close an already-open drawer. Opening from the
  // leading edge conflicts with Android's system Back gesture, which owns the
  // same edge; the visible session button remains the reliable open control.
  // Ignore controls and editors so this does not steal horizontal scrolling,
  // text selection, or clicks from the UI.
  let drawerSwipeStart = null
  document.addEventListener('touchstart', event => {
    if (window.innerWidth > 767 || event.touches.length !== 1) return
    const touch = event.touches[0]
    if (event.target.closest?.('input, textarea, [contenteditable="true"], [role="dialog"]')) return
    const open = sidebarIsOpen()
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    const withinDrawer = open && sidebar && touch.clientX <= sidebar.getBoundingClientRect().right
    drawerSwipeStart = withinDrawer
      ? { x: touch.clientX, y: touch.clientY, open }
      : null
  }, { capture: true, passive: true })
  document.addEventListener('touchmove', event => {
    const touch = event.touches[0]
    if (!drawerSwipeStart || !touch) return
    const dx = touch.clientX - drawerSwipeStart.x
    const dy = touch.clientY - drawerSwipeStart.y
    if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    const start = drawerSwipeStart
    drawerSwipeStart = null
    finishDrawerSwipe(start, touch)
  }, { capture: true, passive: true })
  document.addEventListener('touchend', event => {
    const start = drawerSwipeStart
    drawerSwipeStart = null
    const touch = event.changedTouches[0]
    finishDrawerSwipe(start, touch)
  }, { capture: true, passive: true })
  document.addEventListener('touchcancel', event => {
    const start = drawerSwipeStart
    drawerSwipeStart = null
    const touch = event.changedTouches[0]
    finishDrawerSwipe(start, touch)
  }, { capture: true, passive: true })

  // The desktop sidebar leaves only half of a phone screen for the selected
  // conversation. Return to the chat immediately after choosing a session.
  document.addEventListener('click', event => {
    if (window.innerWidth > 1024) return
    const button = event.target.closest?.('button')
    if (!button) return
    const session = button.matches('[data-slot="row-button"]') && button.closest('[data-slot="sidebar-group-content"]')
    const newChat = button.matches('[data-sidebar="menu-button"]') && /^(新建会话|New chat|New conversation)/i.test(button.textContent.trim())
    if (session || newChat) setTimeout(() => {
      closeSidebar()
      setMobileSessionDrawer(false)
    }, 0)
  }, true)

  // The renderer uses in-page panels for settings. Android's system Back
  // should close the visible panel before leaving the Activity.
  window.__hermesAndroidBack = () => {
    const visible = element => element && element.getClientRects().length > 0
    const mobileHub = document.querySelector('[data-hermes-mobile-hub]')
    if (visible(mobileHub)) {
      mobileHub.remove()
      return true
    }
    const settingsClose = [...document.querySelectorAll(
      'button[aria-label="关闭设置"], button[aria-label="Close settings"]',
    )].find(visible)
    if (settingsClose) {
      settingsClose.click()
      return true
    }
    const login = document.querySelector('[data-hermes-login-overlay]')
    if (visible(login)) {
      login.querySelector('[data-cancel]')?.click()
      return true
    }
    const panel = document.querySelector('[data-boot-failure-card]:not([data-boot-failure-card="recovery"])')
    if (visible(panel)) {
      const back = panel.querySelector(':scope > button')
      if (back) {
        back.click()
        return true
      }
    }

    const dialog = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')]
      .reverse().find(visible)
    if (dialog) {
      const close = dialog.querySelector('[data-slot="dialog-close"], button[aria-label="Close"]')
      if (visible(close)) close.click()
      else (document.activeElement || dialog).dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true
      }))
      return true
    }
    if (window.innerWidth <= 1024 && closeSidebar()) {
      setMobileSessionDrawer(false)
      return true
    }
    return false
  }

  viewport?.addEventListener('resize', syncViewport)
  viewport?.addEventListener('scroll', syncViewport)
  window.addEventListener('resize', syncViewport)
  document.addEventListener('focusin', event => {
    if (event.target?.matches?.('input, textarea, [contenteditable="true"]')) {
      requestAnimationFrame(syncViewport)
    }
    if (event.target?.closest?.('[data-hermes-image-viewer]')) return
  })
  document.addEventListener('focusout', () => requestAnimationFrame(syncViewport))

  const start = () => {
    syncViewport()
    tunePage()
    tuneRoute()
    // Phase 1: coalesce whole-tree mutations into one rAF-throttled pass and
    // skip batches that only changed text/attributes — streaming responses
    // used to trigger several full-document queries per frame.
    let tuneQueued = false
    new MutationObserver(records => {
      if (tuneQueued) return
      if (!records.some(record => record.addedNodes.length)) return
      tuneQueued = true
      requestAnimationFrame(() => {
        tuneQueued = false
        tunePage()
      })
    }).observe(document.body, { childList: true, subtree: true })
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme']
    })
    updateStartupNotice()
    startupTimer = window.setInterval(updateStartupNotice, 750)
    window.addEventListener('hermes-mobile-ws-state', updateStartupNotice)
    window.addEventListener('hashchange', () => requestAnimationFrame(() => {
      tunePage()
      tuneRoute()
    }))
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
