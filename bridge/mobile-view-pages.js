// HERMES_MV_PAGES — Hermes Android 移动应用页面层
// ---------------------------------------------------------------------------
// 依赖核心 bridge/mobile-view.js 暴露的 window.__hermesMV。
// 页面：会话（REST /api/sessions 全管理）、任务（定时任务 + 审批中心）、
// 技能（技能/工具集/MCP）、更多（模型设置/Agent 配置/连接/服务器）。
// API fields follow the upstream Hermes Gateway contract.
// ---------------------------------------------------------------------------

/* global window, document */

(() => {
  const MV = window.__hermesMV
  if (!MV) return
  const { el, relTime, clampText, toast, promptDialog, actionSheet, rest, rpc, withProfile, store } = MV

  // ── 会话级模型切换（聊天 composer 胶囊）─────────────────────────────

  const modelPickerState = { providers: [], loaded: false }

  const fetchModelProviders = async () => {
    if (modelPickerState.loaded) return modelPickerState.providers
    try {
      const result = await rest('GET', '/api/model/options?explicit_only=1', undefined, { bust: true })
      modelPickerState.providers = Array.isArray(result?.providers)
        ? result.providers.filter(p => !p.has || p.authenticated !== false)
        : []
      modelPickerState.loaded = true
    } catch (error) {
      toast(`模型目录读取失败：${clampText(error?.message, 80)}`, 'error')
    }
    return modelPickerState.providers
  }

  const resumeRuntimeSession = async entry => {
    const resumed = await rpc('session.resume', withProfile({ session_id: entry.storedId }))
    entry.runtimeId = resumed?.session_id || ''
    return entry.runtimeId
  }

  // 桌面模型选择器同款路径：config.set key=model（网关进程内热切换，不起新进程）。
  // 旧实现的 slash.exec 会让网关 spawn 完整 slash worker 子进程，共享网关高负载下
  // 直接 45s 超时——「胶囊切模型不生效」的根因。
  const configSetModel = async (entry, provider, model, confirm = false) => rpc('config.set', withProfile({
    session_id: entry.runtimeId,
    key: 'model',
    value: `${model} --provider ${provider} --session`,
    ...(confirm ? { confirm_expensive_model: true } : {})
  }), 30000)

  const switchSessionModel = async (provider, model) => {
    const entry = MV.currentEntry()
    if (!entry) return
    try {
      if (!entry.runtimeId) await resumeRuntimeSession(entry)
      if (!entry.runtimeId) throw new Error('无法获得运行时会话')
      let result
      try {
        result = await configSetModel(entry, provider, model)
      } catch (error) {
        // 运行时会话可能已被网关回收（config.set: session not found）→ 重新挂载后重试一次
        if (!/not found|no live session/i.test(String(error?.message || error))) throw error
        await resumeRuntimeSession(entry)
        if (!entry.runtimeId) throw new Error('无法恢复运行时会话')
        result = await configSetModel(entry, provider, model)
      }
      if (result?.confirm_required) {
        // 贵模型/高风险提示：与服务端确认流对齐，确认后带 confirm_expensive_model 重发
        actionSheet(result.confirm_message || '确认切换该模型？', [
          {
            label: '确认切换',
            onTap: async () => {
              try {
                const r2 = await configSetModel(entry, provider, model, true)
                entry.model = r2?.value || model
                MV.updateHeaderTitle()
                if (r2?.deferred) toast('当前回复结束后生效', 'info', 2600)
                else toast(`本会话模型已切换为 ${model}`, 'success')
              } catch (e) {
                toast(`切换失败：${clampText(e?.message, 80)}`, 'error')
              }
            }
          },
          { label: '取消', onTap: () => {} }
        ])
        return
      }
      entry.model = result?.value || model
      MV.updateHeaderTitle()
      if (result?.deferred) toast('模型将在当前回复结束后生效', 'info', 2600)
      else toast(`本会话模型已切换为 ${model}`, 'success')
    } catch (error) {
      // 极老网关没有 config.set 的 model 分支时退回斜杠命令
      if (/-(32601|32602)|unknown method|method not found/i.test(String(error?.message || error))) {
        try {
          if (!entry.runtimeId) await resumeRuntimeSession(entry)
          await rpc('slash.exec', withProfile({
            session_id: entry.runtimeId,
            command: `model ${model} --provider ${provider} --session`
          }), 60000)
          entry.model = model
          MV.updateHeaderTitle()
          toast(`本会话模型已切换为 ${model}`, 'success')
          return
        } catch (fallbackError) {
          toast(`切换失败：${clampText(fallbackError?.message, 80)}`, 'error')
          return
        }
      }
      toast(`切换失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  const openModelPicker = async () => {
    const entry = MV.currentEntry()
    if (!entry) {
      toast('先选择或新建会话', 'warn')
      return
    }
    const providers = await fetchModelProviders()
    if (!providers.length) {
      toast('没有可用的模型提供商', 'warn')
      return
    }
    actionSheet(`切换模型（当前 ${entry.model || '默认'}）`, providers.map(p => ({
      label: `${p.name || p.slug}${p.models?.length ? `（${p.models.length} 个模型）` : ''}`,
      onTap: () => {
        const models = Array.isArray(p.models) ? p.models : []
        if (!models.length) {
          toast('该提供商没有模型列表', 'warn')
          return
        }
        actionSheet(`${p.name || p.slug} 的模型`, models.map(m => ({
          label: m === entry.model ? `✓ ${m}` : m,
          onTap: () => void switchSessionModel(p.slug || p.name, m)
        })))
      }
    })))
  }

  window.__hermesMVPagesOpenModelPicker = openModelPicker


  // ── 会话页 ──────────────────────────────────────────────────────────

  const sessionsState = { rows: [], archivedRows: [], showArchived: false, query: '' }

  const fetchSessionsRest = async () => {
    try {
      // REST /api/sessions 的 limit 上限是 100（le=100，超了直接 422）——
      // 分页取全量，主列表与归档列表都从这里拆分。
      const rows = []
      let total = Infinity
      for (let offset = 0; rows.length < total && offset < 1000; offset += 100) {
        const result = await rest('GET', `/api/sessions?limit=100&offset=${offset}&include_children=false&order=recent`, undefined, { bust: true })
        const page = Array.isArray(result?.sessions) ? result.sessions : []
        rows.push(...page)
        total = Number(result?.total ?? rows.length)
        if (!page.length) break
      }
      sessionsState.rows = rows.filter(r => !r.archived)
      sessionsState.archivedRows = rows.filter(r => r.archived)
    } catch (error) {
      console.warn('[mv-pages] sessions REST failed, fallback to rpc list:', error?.message)
      sessionsState.rows = store.sessions
      sessionsState.archivedRows = []
    }
    renderSessionsPage()
  }

  const sessionRow = (row, archived) => {
    const item = el('div', 'hmv-srow')
    if (row.id === store.currentId) item.dataset.active = 'true'
    if (row.pinned) item.dataset.pinned = 'true'
    const top = el('div', 'hmv-row-top')
    top.append(el('span', 'hmv-row-title', `${row.pinned ? '📌 ' : ''}${row.title || '未命名会话'}`))
    top.append(el('span', 'hmv-row-time', relTime(row.last_active || row.started_at)))
    item.append(top)
    const meta = []
    if (row.model) meta.push(row.model)
    if (row.message_count) meta.push(`${row.message_count} 条`)
    if (row.source && row.source !== 'desktop') meta.push(row.source)
    const bottom = el('div', 'hmv-row-preview', clampText(row.preview || meta.join(' · '), 70))
    item.append(bottom)
    if (row.unread) item.append(el('div', 'hmv-chip', '有未读更新'))
    const open = () => MV.openSession(row.id)
    item.addEventListener('click', open)
    MV.longPress(item, () => {
      actionSheet(row.title || '未命名会话', [
        { label: '打开会话', onTap: open },
        { label: row.pinned ? '取消置顶' : '置顶', onTap: () => patchSession(row.id, { pinned: !row.pinned }) },
        { label: '重命名', onTap: () => promptDialog('重命名会话', [{ name: 'title', label: '标题', value: row.title || '' }], async (v, close, fail) => {
          const title = String(v.title || '').trim()
          if (!title) return fail('标题不能为空')
          try { await patchSession(row.id, { title }); close() } catch (e) { fail(clampText(e?.message, 60)) }
        }) },
        archived
          ? { label: '恢复会话', onTap: () => patchSession(row.id, { archived: false }) }
          : { label: '归档', onTap: () => patchSession(row.id, { archived: true }) },
        { label: '删除会话', danger: true, confirm: '确认删除？不可恢复', onTap: () => void MV.deleteSession(row.id) }
      ])
    })
    return item
  }

  const patchSession = async (id, body) => {
    try {
      await rest('PATCH', `/api/sessions/${encodeURIComponent(id)}`, body)
      toast('已更新', 'success', 1800)
      await MV.refreshSessions()
      await fetchSessionsRest()
    } catch (error) {
      // 未发过消息的草稿会话在服务端没有持久行（REST 404）——先发一条消息再操作
      if (/404|not found/i.test(String(error?.message))) {
        toast('新会话要先发一条消息才能改名/归档', 'warn', 3200)
      } else {
        toast(`操作失败：${clampText(error?.message, 80)}`, 'error')
      }
    }
  }

  const renderSessionsPage = () => {
    const body = MV.ui.sections.sessions.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    const search = el('input', 'hmv-page-search')
    search.type = 'search'
    search.placeholder = '搜索会话'
    search.value = sessionsState.query
    search.setAttribute('autocomplete', 'off')
    search.addEventListener('input', () => { sessionsState.query = search.value; renderSessionsList() })
    body.append(search)
    // 全文搜索：把搜索框的词打到 /api/sessions/search（跨会话消息内容）
    const fulltextBtn = el('button', 'hmv-page-more-btn', '🔍 在全部会话内容中搜索')
    fulltextBtn.type = 'button'
    fulltextBtn.addEventListener('click', async () => {
      const q = sessionsState.query.trim()
      if (q.length < 2) {
        toast('先在上方输入至少 2 个字符', 'warn', 2200)
        return
      }
      fulltextBtn.disabled = true
      try {
        // bust 缓存：搜索是用户显式触发的新查询，stale-while-revalidate 会把
        // 刚改过内容（新会话/新消息）时的旧空结果回放给用户。
        const result = await MV.rest('GET', `/api/sessions/search?q=${encodeURIComponent(q)}&limit=20`, undefined, { bust: true })
        const results = (result?.results ?? []).filter(r => r.snippet)
        if (!results.length) {
          toast('没有匹配的内容', 'info', 2200)
          return
        }
        openContentSearch(q, results)
      } catch (error) {
        toast(`搜索失败：${clampText(error?.message, 80)}`, 'error')
      } finally {
        fulltextBtn.disabled = false
      }
    })
    body.append(fulltextBtn)
    const list = el('div', 'hmv-page-list')
    body.append(list)
    renderSessionsList(list)
  }

  const renderSessionsList = (list) => {
    list = list || MV.ui.sections.sessions.querySelector('.hmv-page-list')
    if (!list) return
    list.replaceChildren()
    const q = sessionsState.query.trim().toLowerCase()
    const match = r => !q || `${r.title || ''} ${r.preview || ''}`.toLowerCase().includes(q)

    if (!sessionsState.showArchived) {
      const pinned = sessionsState.rows.filter(r => r.pinned && match(r))
      const recent = sessionsState.rows.filter(r => !r.pinned && match(r))
      if (pinned.length) list.append(sectionHead('置顶'))
      for (const row of pinned) list.append(sessionRow(row, false))
      list.append(sectionHead('最近'))
      if (!recent.length && !pinned.length) {
        list.append(el('div', 'hmv-drawer-empty', q ? '没有匹配的会话。' : '还没有会话，去聊天页点 ＋ 新建。'))
      }
      for (const row of recent) list.append(sessionRow(row, false))
      const archivedBtn = el('button', 'hmv-page-more-btn', `已归档（${sessionsState.archivedRows.length}）`)
      archivedBtn.type = 'button'
      archivedBtn.addEventListener('click', () => {
        sessionsState.showArchived = true
        renderSessionsPage()
      })
      list.append(archivedBtn)
    } else {
      list.append(sectionHead('已归档'))
      const rows = sessionsState.archivedRows.filter(match)
      if (!rows.length) list.append(el('div', 'hmv-drawer-empty', '没有归档会话。'))
      for (const row of rows) list.append(sessionRow(row, true))
      const backBtn = el('button', 'hmv-page-more-btn', '‹ 返回会话列表')
      backBtn.type = 'button'
      backBtn.addEventListener('click', () => {
        sessionsState.showArchived = false
        renderSessionsPage()
      })
      list.append(backBtn)
    }
  }

  const sectionHead = text => {
    const head = el('div', 'hmv-section-head', text)
    return head
  }

  // ── 任务页（审批中心 + 定时任务）────────────────────────────────────

  const tasksState = { jobs: [], loading: false }

  const cronRow = job => {
    const item = el('div', 'hmv-srow')
    const top = el('div', 'hmv-row-top')
    top.append(el('span', 'hmv-row-title', job.name || '定时任务'))
    const state = el('span', 'hmv-row-time', job.paused || job.enabled === false ? '已暂停' : (job.next_run_at ? `下次 ${relTime(ToSec(job.next_run_at))}` : '已排程'))
    if (job.paused || job.enabled === false) state.dataset.warn = 'true'
    top.append(state)
    item.append(top)
    item.append(el('div', 'hmv-row-preview', clampText(job.schedule?.display || job.schedule?.expr || job.schedule || '未设置排程', 60)))
    if (job.last_status) item.append(el('div', 'hmv-chip', `上次：${job.last_status}`))
    item.addEventListener('click', () => {
      actionSheet(job.name || '定时任务', [
        { label: '编辑', onTap: () => promptDialog('编辑定时任务', [
          { name: 'name', label: '名称', value: job.name || '' },
          { name: 'prompt', label: '提示词', value: job.prompt || '' },
          { name: 'schedule', label: '排程（cron 表达式）', value: typeof job.schedule === 'string' ? job.schedule : (job.schedule?.expr || '') }
        ], async (v, close, fail) => {
          if (!v.name?.trim()) return fail('名称不能为空')
          try {
            await rest('PUT', `/api/cron/jobs/${encodeURIComponent(job.id)}`, { updates: { name: v.name.trim(), prompt: v.prompt, schedule: v.schedule.trim() } })
            close(); toast('已保存', 'success'); await fetchCronJobs()
          } catch (e) { fail(clampText(e?.message, 60)) }
        }) },
        job.paused || job.enabled === false
          ? { label: '恢复运行', onTap: () => cronAction(job.id, 'resume') }
          : { label: '暂停', onTap: () => cronAction(job.id, 'pause') },
        { label: '立即运行一次', onTap: () => cronAction(job.id, 'trigger') },
        { label: '删除任务', danger: true, confirm: '确认删除该任务？', onTap: async () => {
          try {
            await rest('DELETE', `/api/cron/jobs/${encodeURIComponent(job.id)}`)
            toast('任务已删除', 'success')
            await fetchCronJobs()
          } catch (error) { toast(`删除失败：${clampText(error?.message, 80)}`, 'error') }
        } }
      ])
    })
    return item
  }
  const ToSec = v => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v) >= 1e11 ? v / 1000 : v
    const numeric = Number(v)
    if (Number.isFinite(numeric) && numeric > 0) return numeric >= 1e11 ? numeric / 1000 : numeric
    const parsed = Date.parse(String(v ?? ''))
    return Number.isFinite(parsed) ? parsed / 1000 : 0
  }

  const cronAction = async (id, action) => {
    try {
      await rest('POST', `/api/cron/jobs/${encodeURIComponent(id)}/${action}`, {})
      toast(action === 'trigger' ? '已触发' : action === 'pause' ? '已暂停' : '已恢复', 'success')
      await fetchCronJobs()
    } catch (error) {
      toast(`操作失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  const fetchCronJobs = async () => {
    if (tasksState.loading) return
    tasksState.loading = true
    try {
      const result = await rest('GET', '/api/cron/jobs', undefined, { bust: true })
      tasksState.jobs = Array.isArray(result?.jobs) ? result.jobs : Array.isArray(result) ? result : []
    } catch (error) {
      console.warn('[mv-pages] cron list failed:', error?.message)
    } finally {
      tasksState.loading = false
    }
    renderTasksPage()
  }

  const renderTasksPage = () => {
    const body = MV.ui.sections.tasks.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()

    // 审批中心
    const pending = [...store.pendingRequests.values()].filter(r => r.status === 'pending')
    body.append(sectionHead(`待处理（${pending.length}）`))
    if (!pending.length) {
      body.append(el('div', 'hmv-drawer-empty', '暂无待处理的确认或提问。'))
    }
    for (const req of pending) {
      const item = el('div', 'hmv-srow')
      const top = el('div', 'hmv-row-top')
      top.append(el('span', 'hmv-row-title', req.method === 'approval' ? '🛡 执行确认' : req.method === 'clarify' ? '❓ 提问' : '🔑 需要信息'))
      top.append(el('span', 'hmv-row-time', relTime(req.createdAt / 1000)))
      item.append(top)
      const params = req.params || {}
      item.append(el('div', 'hmv-row-preview', clampText(params.command || params.question || params.prompt || params.description || '', 80)))
      const actions = el('div', 'hmv-request-actions')
      if (req.method === 'approval') {
        // 审批按钮即应答：点了就发 RPC。此前先跳聊天再 markAnswered，导致
        // 徽标清了、RPC 没发、聊天卡片因记录被删而消失——审批凭空丢失。
        const choices = Array.isArray(params.choices) && params.choices.length ? params.choices : ['once', 'deny']
        for (const c of choices.map(x => (typeof x === 'string' ? x : x?.id || x?.value)).filter(Boolean)) {
          const btn = el('button', 'hmv-request-btn', c === 'once' ? '允许一次' : c === 'deny' ? '拒绝' : c)
          btn.type = 'button'
          if (/deny|no/i.test(c)) btn.dataset.danger = 'true'
          btn.disabled = Boolean(req.answering)
          btn.addEventListener('click', async () => {
            if (req.answering) return
            btn.disabled = true
            try {
              await MV.respondPendingRequest(req, { choice: c })
              toast(`已应答（${c === 'once' ? '允许一次' : c === 'deny' ? '拒绝' : c}）`, 'success')
            } catch (error) {
              btn.disabled = false
              toast(`应答失败：${clampText(error?.message, 60)}`, 'error')
            }
          })
          actions.append(btn)
        }
      } else {
        const open = el('button', 'hmv-request-btn hmv-request-primary', '去处理')
        open.type = 'button'
        open.addEventListener('click', () => {
          if (req.sessionId && store.entries.has(req.sessionId)) {
            const entry = store.entries.get(req.sessionId)
            // 已有卡片不重复插（请求到达时若该会话正是当前页，聊天内已插过一次）
            if (!entry.items.some(i => i.kind === 'request' && i.requestId === req.id)) {
              entry.items.push({ kind: 'request', requestId: req.id })
            }
            MV.navigate('chat')
            MV.openSession(req.sessionId)
          } else {
            toast('该请求所属会话未在本机打开，请在来源端处理', 'warn')
          }
        })
        actions.append(open)
      }
      item.append(actions)
      body.append(item)
    }

    // 定时任务
    const head = sectionHead(`定时任务（${tasksState.jobs.length}）`)
    const newBtn = el('button', 'hmv-section-action', '＋ 新建')
    newBtn.type = 'button'
    newBtn.addEventListener('click', () => promptDialog('新建定时任务', [
      { name: 'name', label: '名称' },
      { name: 'prompt', label: '提示词' },
      { name: 'schedule', label: '排程（cron 表达式，如 0 9 * * *）' }
    ], async (v, close, fail) => {
      if (!v.name?.trim() || !v.schedule?.trim()) return fail('名称和排程必填')
      try {
        await rest('POST', '/api/cron/jobs', { name: v.name.trim(), prompt: v.prompt || '', schedule: v.schedule.trim(), deliver: 'local' })
        close(); toast('任务已创建', 'success'); await fetchCronJobs()
      } catch (e) { fail(clampText(e?.message, 60)) }
    }))
    head.append(newBtn)
    body.append(head)
    if (!tasksState.jobs.length) body.append(el('div', 'hmv-drawer-empty', tasksState.loading ? '加载中…' : '暂无定时任务。'))
    for (const job of tasksState.jobs) body.append(cronRow(job))
  }

  // ── 技能页（技能 / 工具集 / MCP）────────────────────────────────────

  const skillsState = { skills: [], toolsets: [], servers: [], section: 'skills', loading: false }

  const toggleRow = (title, subtitle, enabled, onToggle, onOpen) => {
    const item = el('div', 'hmv-srow')
    item.setAttribute('role', 'listitem')
    const top = el('div', 'hmv-row-top')
    const titleEl = el('span', 'hmv-row-title', title)
    top.append(titleEl)
    const toggle = el('button', 'hmv-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-label', `${enabled ? '停用' : '启用'} ${title}`)
    toggle.dataset.on = enabled ? 'true' : 'false'
    toggle.innerHTML = '<span></span>'
    toggle.addEventListener('click', async event => {
      event.stopPropagation()
      if (toggle.disabled) return
      const previous = toggle.dataset.on === 'true'
      const next = !previous
      toggle.dataset.on = next ? 'true' : 'false'
      toggle.setAttribute('aria-label', `${next ? '停用' : '启用'} ${title}`)
      toggle.disabled = true
      try {
        await onToggle(next)
        toast(next ? '已启用' : '已停用', 'success', 1500)
      } catch (error) {
        toggle.dataset.on = previous ? 'true' : 'false'
        toggle.setAttribute('aria-label', `${previous ? '停用' : '启用'} ${title}`)
        toast(`操作失败：${clampText(error?.message, 60)}`, 'error')
      } finally {
        toggle.disabled = false
      }
    })
    top.append(toggle)
    item.append(top)
    if (subtitle) item.append(el('div', 'hmv-row-preview', clampText(subtitle, 80)))
    if (onOpen) item.addEventListener('click', onOpen)
    return item
  }

  const fetchSkillsData = async () => {
    if (skillsState.loading) return
    skillsState.loading = true
    renderSkillsPage()
    const jobs = [
      rest('GET', '/api/skills', undefined, { bust: true }).then(r => {
        skillsState.skills = Array.isArray(r) ? r : Array.isArray(r?.skills) ? r.skills : []
      }).catch(() => { skillsState.skills = [] }),
      rest('GET', '/api/tools/toolsets', undefined, { bust: true }).then(r => {
        skillsState.toolsets = Array.isArray(r) ? r : Array.isArray(r?.toolsets) ? r.toolsets : []
      }).catch(() => { skillsState.toolsets = [] }),
      rest('GET', '/api/mcp/servers', undefined, { bust: true }).then(r => {
        skillsState.servers = Array.isArray(r) ? r : Array.isArray(r?.servers) ? r.servers : []
      }).catch(() => { skillsState.servers = [] })
    ]
    await Promise.allSettled(jobs)
    skillsState.loading = false
    renderSkillsPage()
  }

  const setToolsetEnabled = async (name, enabled) => {
    // 工具集开关走 config.agent.disabled_toolsets（读-改-写）
    const configRaw = await rest('GET', '/api/config', undefined, { bust: true })
    const config = (configRaw && typeof configRaw.config === 'object' ? configRaw.config : configRaw) || {}
    const agent = config.agent = config.agent || {}
    const disabled = new Set(Array.isArray(agent.disabled_toolsets) ? agent.disabled_toolsets : [])
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    agent.disabled_toolsets = [...disabled].sort()
    await rest('PUT', '/api/config', { config })
  }

  const renderSkillsPage = () => {
    const body = MV.ui.sections.skills.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    const tabs = el('div', 'hmv-seg')
    for (const [id, label] of [['skills', '技能'], ['toolsets', '工具集'], ['mcp', 'MCP']]) {
      const b = el('button', 'hmv-seg-btn', label)
      b.type = 'button'
      if (skillsState.section === id) b.classList.add('active')
      b.addEventListener('click', () => { skillsState.section = id; renderSkillsPage() })
      tabs.append(b)
    }
    body.append(tabs)
    const list = el('div', 'hmv-page-list')
    body.append(list)

    if (skillsState.loading) list.append(el('div', 'hmv-loading', '加载中…'))

    if (skillsState.section === 'skills') {
      if (!skillsState.skills.length && !skillsState.loading) list.append(el('div', 'hmv-drawer-empty', '暂无技能。'))
      for (const skill of skillsState.skills) {
        list.append(toggleRow(
          skill.name,
          clampText(skill.description || skill.category || '', 80),
          skill.enabled !== false,
          enabled => rest('PUT', '/api/skills/toggle', { name: skill.name, enabled }),
          () => openSkillContent(skill.name)
        ))
      }
    } else if (skillsState.section === 'toolsets') {
      if (!skillsState.toolsets.length && !skillsState.loading) list.append(el('div', 'hmv-drawer-empty', '暂无工具集。'))
      for (const ts of skillsState.toolsets) {
        const enabled = ts.enabled ?? ts.active ?? true
        list.append(toggleRow(
          ts.label || ts.name,
          clampText(`${ts.description || ''}${ts.tools?.length ? ` · ${ts.tools.length} 个工具` : ''}`, 80),
          Boolean(enabled),
          next => setToolsetEnabled(ts.name, next)
        ))
      }
    } else {
      if (!skillsState.servers.length && !skillsState.loading) list.append(el('div', 'hmv-drawer-empty', '暂无 MCP 服务。'))
      for (const server of skillsState.servers) {
        list.append(toggleRow(
          server.name,
          clampText(`${server.transport || ''}${server.tool_count ? ` · ${server.tool_count} 工具` : ''}${server.status ? ` · ${server.status}` : ''}`, 80),
          server.enabled !== false,
          enabled => rest('PUT', `/api/mcp/servers/${encodeURIComponent(server.name)}/enabled`, { enabled })
        ))
      }
    }
  }

  const openSkillContent = async name => {
    try {
      const result = await rest('GET', `/api/skills/content?name=${encodeURIComponent(name)}`)
      const content = result?.content || '(无内容)'
      const overlay = el('div', 'hmv-dialog-overlay')
      const box = el('div', 'hmv-dialog hmv-doc')
      box.append(el('h3', null, name))
      const pre = el('pre', 'hmv-doc-pre', content.length > 20000 ? `${content.slice(0, 20000)}\n…（截断）` : content)
      box.append(pre)
      const close = el('button', 'hmv-dialog-btn hmv-dialog-ok', '关闭')
      close.type = 'button'
      close.addEventListener('click', () => overlay.remove())
      box.append(close)
      overlay.append(box)
      document.body.append(overlay)
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    } catch (error) {
      toast(`读取技能内容失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  // ── 更多页 ──────────────────────────────────────────────────────────

  const moreState = { profiles: [], activeProfile: '', config: null, modelOptions: null, connections: null }

  const groupHead = text => {
    const head = el('div', 'hmv-section-head', text)
    return head
  }

  const moreRow = (icon, title, subtitle, onTap) => {
    const row = el('button', 'hmv-mrow')
    row.type = 'button'
    row.innerHTML = `<span class="hmv-mrow-icon">${icon}</span><span class="hmv-mrow-copy"><strong>${MV.esc(title)}</strong>${subtitle ? `<small>${MV.esc(clampText(subtitle, 50))}</small>` : ''}</span><span class="hmv-mrow-chevron">›</span>`
    row.addEventListener('click', onTap)
    return row
  }

  const fetchMoreData = async () => {
    const jobs = [
      rest('GET', '/api/profiles').then(r => {
        moreState.profiles = Array.isArray(r) ? r : Array.isArray(r?.profiles) ? r.profiles : []
      }).catch(() => {}),
      rest('GET', '/api/profiles/active').then(r => {
        moreState.activeProfile = r?.current || r?.active || ''
      }).catch(() => {}),
      rest('GET', '/api/config', undefined, { bust: true }).then(r => {
        moreState.config = (r && typeof r.config === 'object') ? r.config : r
      }).catch(() => {}),
      rest('GET', '/api/model/options?explicit_only=1', undefined, { bust: true }).then(r => {
        moreState.modelOptions = r
      }).catch(() => {}),
      rest('GET', '/api/model/info', undefined, { bust: true }).then(r => {
        moreState.modelInfo = r || {}
      }).catch(() => {}),
      MV.store.profileName || MV.setProfile(moreState.activeProfile || '')
    ]
    await Promise.allSettled(jobs)
    renderMorePage()
  }

  const currentModelSpec = () => ({
    provider: moreState.modelInfo?.provider || '',
    model: moreState.modelInfo?.model || '',
    context: moreState.modelInfo?.effective_context_length || 0
  })

  const openModelSettings = async () => {
    const spec = currentModelSpec()
    const providers = await fetchModelProviders()
    if (!providers.length) {
      toast('模型目录读取失败，稍后再试', 'warn')
      return
    }
    // 两步选择（与会话级模型胶囊一致）：提供商 → 模型列表联动。
    // 旧实现用静态下拉，切了提供商模型列表不跟随，提交的永远是旧模型 → 「切不过来」。
    actionSheet(`默认模型 · 选择提供商（当前 ${spec.provider || '默认'}）`, providers.map(p => {
      const slug = p.slug || p.name
      const models = Array.isArray(p.models) ? p.models : []
      return {
        label: `${p.name || slug}${models.length ? `（${models.length} 个模型）` : ''}${slug === spec.provider ? ' · 当前' : ''}`,
        onTap: () => {
          if (!models.length) {
            toast('该提供商没有可用模型列表', 'warn')
            return
          }
          actionSheet(`${p.name || slug} · 选择默认模型`, models.map(m => ({
            label: m === spec.model ? `✓ ${m}` : m,
            onTap: () => void finishDefaultModelSettings(slug, m)
          })))
        }
      }
    }))
  }

  // 主槽位默认模型提交：走 /api/model/set（桌面 Models 页同款端点——提供商校验、
  // 凭据解析、base_url 回填、贵模型二次确认都在服务端完成）。
  // 推理力度不在该端点的职责内（其 reasoning_effort 仅辅助槽位），仍写 agent.reasoning_effort。
  const finishDefaultModelSettings = async (provider, model) => {
    const currentEffort = moreState.config?.agent?.reasoning_effort || ''
    const saveEffort = async effort => {
      if (effort === currentEffort) return
      const configRaw = await rest('GET', '/api/config', undefined, { bust: true })
      const config = (configRaw && typeof configRaw.config === 'object' ? configRaw.config : configRaw) || {}
      config.agent = config.agent || {}
      if (effort) config.agent.reasoning_effort = effort
      else delete config.agent.reasoning_effort
      await rest('PUT', '/api/config', { config })
    }
    promptDialog(`默认模型：${provider} / ${model}`, [
      {
        name: 'effort', label: '推理力度', options: [
          { value: '', label: '跟随默认' },
          { value: 'low', label: '低' },
          { value: 'medium', label: '中' },
          { value: 'high', label: '高' },
          { value: 'xhigh', label: '最高' }
        ], value: currentEffort
      }
    ], async (v, close, fail) => {
      try {
        const result = await rest('POST', '/api/model/set', { scope: 'main', provider, model })
        if (result?.confirm_required) {
          // 服务端贵模型/高风险提示：用户确认后带 confirm_expensive_model 重发
          close()
          actionSheet(result.confirm_message || '确认切换该模型？', [
            { label: '仍要切换', onTap: () => {
              void (async () => {
                try {
                  const r2 = await rest('POST', '/api/model/set', { scope: 'main', provider, model, confirm_expensive_model: true })
                  if (!r2?.ok) throw new Error(r2?.detail || '切换未生效')
                  try {
                    await saveEffort(v.effort)
                  } catch (error) {
                    await fetchMoreData()
                    return toast(`模型已切换；推理力度保存失败：${clampText(error?.message, 60)}`, 'error')
                  }
                  toast(`默认模型已切换为 ${model}`, 'success')
                  await fetchMoreData()
                } catch (e) { toast(`切换失败：${clampText(e?.message, 80)}`, 'error') }
              })()
            } },
            { label: '取消', onTap: () => {} }
          ])
          return
        }
        if (!result?.ok) throw new Error(result?.detail || '切换未生效')
        // 推理力度：仅在用户改动时写入（清空 = 删除键，保留配置形状）。
        try {
          await saveEffort(v.effort)
        } catch (error) {
          close()
          await fetchMoreData()
          toast(`模型已切换；推理力度保存失败：${clampText(error?.message, 60)}`, 'error')
          return
        }
        close()
        toast(`默认模型已切换为 ${model}`, 'success')
        await fetchMoreData()
      } catch (e) { fail(clampText(e?.message, 80)) }
    })
  }

  const openConnections = async () => {
    try {
      const registry = await desktopConnectionsList()
      const conns = registry?.connections || []
      actionSheet('连接管理', [
        ...conns.map(c => ({
          label: `${c.id === registry.primary ? '★ ' : ''}${c.label || c.id}（${c.url || '未配置'}）`,
          onTap: async () => {
            try {
              await desktopConnectionsSetPrimary(c.id)
              toast('已切换主连接', 'success')
              window.location.reload()
            } catch (error) { toast(`切换失败：${clampText(error?.message, 60)}`, 'error') }
          }
        })),
        { label: '添加新连接…', onTap: () => promptDialog('添加网关连接', [
          { name: 'url', label: '网关地址（https://…）', placeholder: 'https://hermes.example.com' }
        ], async (v, close, fail) => {
          const url = String(v.url || '').trim().replace(/\/+$/, '')
          if (!/^https:\/\//.test(url)) return fail('需要 https 地址')
          try {
            const probe = await desktopProbeConnection(url)
            if (!probe.reachable) return fail(`不可达：${probe.error || 'unknown'}`)
            await desktopSaveConnection({ mode: 'remote', remoteUrl: url, remoteAuthMode: probe.authMode || 'oauth' })
            close()
            toast('已添加，正在打开登录…', 'success')
            if (probe.authMode === 'oauth') await desktopLoginFlow(url)
            window.location.reload()
          } catch (e) { fail(clampText(e?.message, 80)) }
        }) },
        { label: '重新登录当前网关…', onTap: async () => {
          const conn = conns.find(c => c.id === registry.primary) || conns[0]
          if (!conn?.url) return toast('没有可用连接', 'warn')
          const r = await desktopLoginFlow(conn.url)
          toast(r?.connected ? '登录成功' : '登录未完成', r?.connected ? 'success' : 'warn')
        } }
      ])
    } catch (error) {
      toast(`读取连接失败：${clampText(error?.message, 80)}`, 'error')
    }
  }

  const desktopConnectionsList = () => window.hermesDesktop.connections.list()
  const desktopConnectionsSetPrimary = id => window.hermesDesktop.connections.setPrimary(id)
  const desktopProbeConnection = url => window.hermesDesktop.probeConnectionConfig(url)
  const desktopSaveConnection = payload => window.hermesDesktop.saveConnectionConfig(payload)
  const desktopLoginFlow = url => window.hermesDesktop.oauthLoginConnectionConfig(url)

  const renderMorePage = () => {
    const body = MV.ui.sections.more.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    const spec = currentModelSpec()

    body.append(groupHead('Agent 配置'))
    const profileRow = moreRow('◉', `Agent · ${store.profileName || moreState.activeProfile || 'default'}`,
      `${moreState.profiles.length} 个配置档案`, () => {
        actionSheet('切换 Agent 配置', [
          { label: '跟随服务器当前配置', onTap: () => { MV.setProfile(''); toast('已恢复跟随', 'success'); fetchMoreData() } },
          ...moreState.profiles.map(p => ({
            label: `${p.name}${p.is_default ? '（默认）' : ''}`,
            onTap: () => { MV.setProfile(p.name); toast(`已切换到 ${p.name}`, 'success'); fetchMoreData() }
          }))
        ])
      })
    body.append(profileRow)

    body.append(groupHead('模型'))
    const ctxLabel = spec.context ? ` · 上下文 ${(spec.context / 1000).toFixed(0)}K` : ''
    body.append(moreRow('🧠', '默认模型设置（提供商 → 模型）', `${spec.provider || '?'} · ${spec.model || '?'}${ctxLabel}`, openModelSettings))

    body.append(groupHead('浏览与工具'))
    body.append(moreRow('📁', '文件浏览', '工作区目录/预览/编辑', () => MV.pushPage('files')))
    body.append(moreRow('🗂', '产物中心', '会话生成的文件', () => MV.pushPage('artifacts')))
    body.append(moreRow('⚡', '命令中心', '斜杠命令目录与执行', () => MV.pushPage('commands')))
    body.append(moreRow('📡', '消息平台', 'Telegram/微信等接入状态', () => MV.pushPage('messaging')))
    body.append(moreRow('🤖', 'Agents', '运行中的 Agent 进程', () => MV.pushPage('agents')))

    body.append(groupHead('连接与服务器'))
    body.append(moreRow('🔗', '网关连接管理', '添加/切换/重新登录', () => void openConnections()))

    body.append(groupHead('通知'))
    // 后台通知开关：App 切后台后由原生层在网关消息帧上发系统通知
    const notifyOn = MV.notifyEnabled()
    const notifyRow = moreRow(
      '🔔', '后台消息通知',
      notifyOn ? '已开启：切出应用后收到新回复提醒' : '已关闭',
      () => {
        actionSheet('后台消息通知', [
          { label: notifyOn ? '关闭' : '开启', onTap: () => {
            MV.setNotifyEnabled(!notifyOn)
            renderMorePage()
            toast(MV.notifyEnabled() ? '后台通知已开启' : '后台通知已关闭', 'success')
          } }
        ])
      })
    body.append(notifyRow)
    const previewOn = MV.notifyPreviewEnabled()
    body.append(moreRow(
      '🔒', '通知显示消息内容',
      previewOn ? '开启：显示回复和请求摘要' : '关闭：仅显示通用提醒',
      () => {
        actionSheet('通知显示消息内容', [
          { label: previewOn ? '关闭内容预览' : '开启内容预览', onTap: () => {
            MV.setNotifyPreviewEnabled(!previewOn)
            renderMorePage()
            toast(MV.notifyPreviewEnabled() ? '已开启通知内容预览' : '通知仅显示通用提醒', 'success')
          } }
        ])
      }))

    body.append(groupHead('关于'))
    const about = el('div', 'hmv-about')
    about.append(el('div', 'hmv-chip', `Hermes Android 移动应用 ${MV.version}`))
    about.append(el('div', 'hmv-chip', `界面状态：${{ idle: '未连接', connecting: '连接中', open: '已连接', closed: '已断开', error: '连接失败' }[store.connection] || store.connection}`))
    body.append(about)
  }

  // ── 共享文档查看器（文件浏览 / 产物中心共用）────────────────────────

  const TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'log', 'json', 'csv', 'yml', 'yaml', 'xml', 'html', 'htm', 'js', 'ts', 'py', 'sh', 'css', 'toml', 'ini', 'conf', 'sql', 'rs', 'go', 'java', 'c', 'cpp', 'h'])
  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'])
  const fileExt = name => String(name || '').split('.').pop().toLowerCase()
  const utf8FromDataUrl = dataUrl => {
    try { return decodeURIComponent(escape(atob(String(dataUrl).split(',')[1] || ''))) } catch { return null }
  }
  const utf8ToDataUrl = text => `data:text/plain;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(text)))}`

  const attachPinchZoom = img => {
    let start = null
    let scale = 1
    let x = 0
    let y = 0
    const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const paint = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})` }
    img.addEventListener('touchstart', event => {
      if (event.touches.length === 2) start = { distance: distance(event.touches), scale }
      else if (event.touches.length === 1 && scale > 1) start = { x: event.touches[0].clientX, y: event.touches[0].clientY, offsetX: x, offsetY: y }
    }, { passive: true })
    img.addEventListener('touchmove', event => {
      if (event.touches.length === 2 && start?.distance) {
        scale = Math.max(1, Math.min(5, start.scale * distance(event.touches) / start.distance))
        paint()
        event.preventDefault()
      } else if (event.touches.length === 1 && start && start.distance === undefined && scale > 1) {
        x = start.offsetX + event.touches[0].clientX - start.x
        y = start.offsetY + event.touches[0].clientY - start.y
        paint()
      }
    }, { passive: false })
    img.addEventListener('touchend', event => {
      if (!event.touches.length) {
        start = null
        if (scale <= 1.01) { scale = 1; x = 0; y = 0; paint() }
      }
    }, { passive: true })
    img.style.touchAction = 'none'
  }

  const openDocViewer = async (path, opts = {}) => {
    const name = path.split('/').pop()
    const overlay = el('div', 'hmv-dialog-overlay')
    const box = el('div', 'hmv-dialog hmv-doc')
    const head = el('div', 'hmv-doc-head')
    head.append(el('h3', null, clampText(name, 28)))
    // 下载到手机：系统「下载/Hermes/」目录（原生 saveFileBase64）。
    // dlData 在文件加载完成后填充；读取失败时保持 null，点按给提示。
    let dlData = null
    const dlBtn = el('button', 'hmv-icon hmv-doc-dl')
    dlBtn.type = 'button'
    dlBtn.setAttribute('aria-label', '下载到手机')
    dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
    dlBtn.addEventListener('click', () => {
      const native = window.__hermesMobile
      if (!native?.saveFileBase64 || !dlData) {
        toast('文件未加载，无法保存', 'warn', 2400)
        return
      }
      dlBtn.dataset.busy = '1'
      try {
        const res = JSON.parse(native.saveFileBase64(name, dlData.mime, dlData.url))
        if (res.ok) toast(`已保存到 ${res.path}`, 'success', 4200)
        else toast(`保存失败：${res.error || '未知错误'}`, 'error', 4200)
      } catch {
        toast('保存失败', 'error')
      } finally {
        delete dlBtn.dataset.busy
      }
    })
    head.append(dlBtn)
    const closeBtn = el('button', 'hmv-icon')
    closeBtn.type = 'button'
    closeBtn.setAttribute('aria-label', '关闭')
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
    closeBtn.addEventListener('click', () => overlay.remove())
    head.append(closeBtn)
    box.append(head)
    const meta = el('div', 'hmv-chip', clampText(path, 60))
    box.append(meta)
    const content = el('div', 'hmv-doc-content', '加载中…')
    box.append(content)
    overlay.append(box)
    document.body.append(overlay)
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

    let doc = null
    try {
      doc = await rest('GET', `/api/files/read?path=${encodeURIComponent(path)}`)
    } catch (error) {
      content.textContent = `读取失败：${clampText(error?.message, 100)}`
      return
    }
    const mime = doc?.mime_type || ''
    const dataUrl = doc?.data_url || ''
    const ext = fileExt(name)
    const isImage = IMAGE_EXTS.has(ext) || mime.startsWith('image/')
    const isText = TEXT_EXTS.has(ext) || mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')
    if (dataUrl) {
      const fallbackMime = isImage ? 'image/png' : isText ? 'text/plain' : 'application/octet-stream'
      dlData = { url: dataUrl, mime: mime || fallbackMime }
    }

    if (isImage) {
      const img = el('img', 'hmv-doc-image')
      img.src = dataUrl
      img.alt = name
      content.replaceChildren(img)
      attachPinchZoom(img)
      return
    }

    if (!isText) {
      const info = el('div', null)
      info.append(el('p', null, `二进制文件（${mime || ext || '未知类型'}，${Math.round((doc?.size || 0) / 1024)} KB）`))
      const copy = el('button', 'hmv-request-btn hmv-request-primary', '复制服务器路径')
      copy.type = 'button'
      copy.addEventListener('click', async () => {
        try { await window.hermesDesktop.writeClipboard(path); toast('路径已复制', 'success', 1600) } catch { toast('复制失败', 'error') }
      })
      info.append(copy)
      content.replaceChildren(info)
      return
    }

    const text = utf8FromDataUrl(dataUrl)
    if (text == null) {
      content.textContent = '文件内容无法按文本解析。'
      return
    }

    const renderRead = () => {
      content.replaceChildren()
      const pre = el('div', 'hmv-doc-text')
      if (ext === 'md' || ext === 'markdown') pre.innerHTML = MV.richText(text)
      else pre.textContent = text.length > 60000 ? `${text.slice(0, 60000)}\n…（截断）` : text
      content.append(pre)
      const actions = el('div', 'hmv-doc-actions')
      const editBtn = el('button', 'hmv-request-btn hmv-request-primary', '编辑')
      editBtn.type = 'button'
      editBtn.addEventListener('click', () => renderEdit(text))
      const copyBtn = el('button', 'hmv-request-btn', '复制路径')
      copyBtn.type = 'button'
      copyBtn.addEventListener('click', async () => {
        try { await window.hermesDesktop.writeClipboard(path); toast('路径已复制', 'success', 1600) } catch { }
      })
      actions.append(copyBtn, editBtn)
      content.append(actions)
    }

    const renderEdit = initial => {
      content.replaceChildren()
      const area = el('textarea', 'hmv-doc-edit')
      area.value = initial
      content.append(area)
      const actions = el('div', 'hmv-doc-actions')
      const cancel = el('button', 'hmv-request-btn', '取消')
      cancel.type = 'button'
      cancel.addEventListener('click', renderRead)
      const save = el('button', 'hmv-request-btn hmv-request-primary', '保存')
      save.type = 'button'
      save.addEventListener('click', async () => {
        save.disabled = true
        save.textContent = '保存中…'
        try {
          await rest('POST', '/api/files/upload', {
            path,
            data_url: utf8ToDataUrl(area.value),
            overwrite: true
          })
          toast('已保存', 'success')
          overlay.remove()
          if (opts.onSaved) opts.onSaved()
        } catch (error) {
          toast(`保存失败：${clampText(error?.message, 80)}`, 'error')
          save.disabled = false
          save.textContent = '保存'
        }
      })
      actions.append(cancel, save)
      content.append(actions)
    }

    renderRead()
  }

  // ── 文件浏览页 ──────────────────────────────────────────────────────

  const filesState = { root: '', path: '', parent: null, entries: [], loading: false, resolved: false }

  const resolveFileRoot = async () => {
    // 顺序：config.terminal.cwd（绝对路径）→ 活动项目 → /api/fs/default-cwd
    try {
      const cfg = await rest('GET', '/api/config', undefined, { bust: true })
      const conf = (cfg && typeof cfg.config === 'object') ? cfg.config : cfg
      const cwd = conf?.terminal?.cwd
      if (cwd && !['.', 'auto', 'cwd', ''].includes(String(cwd)) && /^[~\/]/.test(String(cwd))) return String(cwd)
    } catch { /* fallthrough */ }
    try {
      const pl = await rpc('projects.list', withProfile({}))
      const projects = Array.isArray(pl?.projects) ? pl.projects : []
      const active = projects.find(p => p.id === pl?.active_id) || projects[0]
      if (active?.primary_path) return active.primary_path
    } catch { /* fallthrough */ }
    try {
      const dc = await rest('GET', '/api/fs/default-cwd')
      if (dc?.cwd) return dc.cwd
    } catch { /* fallthrough */ }
    return null
  }

  const normPath = p => String(p || '').replace(/\/+$/, '') || '/'
  const parentOf = p => {
    const n = normPath(p)
    if (n === '/' || /^[~]$/.test(n)) return null
    const idx = n.lastIndexOf('/')
    return idx <= 0 ? '/' : n.slice(0, idx)
  }
  const crumbSegments = (root, path) => {
    const r = normPath(root)
    const cur = normPath(path)
    let rel = cur
    if (cur.startsWith(r)) rel = cur.slice(r.length).replace(/^\/+/, '')
    else rel = cur.replace(/^\/+/, '')
    const parts = rel ? rel.split('/') : []
    const segs = [{ label: r.split('/').pop() || r, path: r }]
    let acc = r
    for (const part of parts) {
      acc = `${acc}/${part}`
      segs.push({ label: part, path: acc })
    }
    return segs
  }

  const fetchFiles = async path => {
    filesState.loading = true
    renderFilesPage()
    try {
      const suffix = path ? `?path=${encodeURIComponent(path)}` : ''
      const result = await rest('GET', `/api/files${suffix}`)
      filesState.path = result?.path || path || ''
      if (!filesState.root) filesState.root = filesState.path
      filesState.parent = result?.parent ?? null
      filesState.entries = Array.isArray(result?.entries) ? result.entries : []
    } catch (error) {
      toast(`目录读取失败：${clampText(error?.message, 80)}`, 'error')
      filesState.entries = []
    } finally {
      filesState.loading = false
    }
    renderFilesPage()
  }

  const openFilesPage = async () => {
    if (!filesState.resolved) {
      // 管控区根目录由服务端决定：直接不带 path 请求 /api/files
      filesState.resolved = true
      try {
        await rest('GET', '/api/files')
      } catch {
        filesState.root = await resolveFileRoot() || ''
        if (!filesState.root) {
          toast('未能确定可浏览的目录', 'warn')
          renderFilesPage()
          return
        }
      }
    }
    await fetchFiles(filesState.path)
  }

  const fmtSize = size => {
    if (size == null) return ''
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
  }

  const fileEntryRow = entry => {
    const row = el('div', 'hmv-srow')
    const top = el('div', 'hmv-row-top')
    const icon = el('span', 'hmv-row-icon')
    icon.innerHTML = entry.is_directory
      ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
    top.append(icon)
    top.append(el('span', 'hmv-row-title', entry.name))
    const sub = [entry.is_directory ? '目录' : fmtSize(entry.size), relTime(entry.mtime || (entry.mtime_sec))].filter(Boolean).join(' · ')
    top.append(el('span', 'hmv-row-time', sub))
    row.append(top)
    row.addEventListener('click', () => {
      if (entry.is_directory) void fetchFiles(entry.path)
      else void openDocViewer(entry.path)
    })
    MV.longPress(row, () => {
      actionSheet(entry.name, [
        ...(entry.is_directory ? [] : [{ label: '打开 / 预览', onTap: () => void openDocViewer(entry.path) }]),
        { label: '复制路径', onTap: async () => { try { await window.hermesDesktop.writeClipboard(entry.path); toast('路径已复制', 'success', 1600) } catch { } } },
        { label: '删除', danger: true, confirm: '确认删除？', onTap: async () => {
          try {
            await rest('DELETE', '/api/files', { path: entry.path, recursive: entry.is_directory })
            toast('已删除', 'success')
            await fetchFiles(filesState.path)
          } catch (error) { toast(`删除失败：${clampText(error?.message, 80)}`, 'error') }
        } }
      ])
    })
    return row
  }

  const renderFilesPage = () => {
    const body = MV.ui.sections.files.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    if (filesState.loading && !filesState.entries.length) {
      body.append(el('div', 'hmv-loading', '加载中…'))
      return
    }
    if (!filesState.resolved) {
      body.append(el('div', 'hmv-drawer-empty', '尚未确定工作区目录。'))
      return
    }
    // 面包屑
    const crumbs = el('div', 'hmv-crumbs')
    for (const seg of crumbSegments(filesState.root, filesState.path)) {
      const b = el('button', 'hmv-crumb', seg.label)
      b.type = 'button'
      b.addEventListener('click', () => void fetchFiles(seg.path))
      crumbs.append(b)
      crumbs.append(el('span', 'hmv-crumb-sep', '›'))
    }
    body.append(crumbs)
    // 操作行
    const ops = el('div', 'hmv-doc-actions')
    if (filesState.parent) {
      const up = el('button', 'hmv-request-btn', '‹ 上一级')
      up.type = 'button'
      up.addEventListener('click', () => void fetchFiles(filesState.parent))
      ops.append(up)
    }
    const mkdir = el('button', 'hmv-request-btn', '新建文件夹')
    mkdir.type = 'button'
    mkdir.addEventListener('click', () => promptDialog('新建文件夹', [
      { name: 'name', label: '文件夹名称' }
    ], async (v, close, fail) => {
      const name = String(v.name || '').trim()
      if (!name) return fail('名称不能为空')
      try {
        await rest('POST', '/api/files/mkdir', { path: `${normPath(filesState.path)}/${name}` })
        close(); toast('已创建', 'success'); await fetchFiles(filesState.path)
      } catch (e) { fail(clampText(e?.message, 80)) }
    }))
    ops.append(mkdir)
    const refresh = el('button', 'hmv-request-btn', '刷新')
    refresh.type = 'button'
    refresh.addEventListener('click', () => void fetchFiles(filesState.path))
    ops.append(refresh)
    body.append(ops)
    // 列表
    const list = el('div', 'hmv-page-list')
    body.append(list)
    if (!filesState.entries.length) list.append(el('div', 'hmv-drawer-empty', '空目录。'))
    const sorted = [...filesState.entries].sort((a, b) => (b.is_directory - a.is_directory) || String(a.name).localeCompare(String(b.name)))
    for (const entry of sorted) list.append(fileEntryRow(entry))
  }

  // ── 产物中心页 ──────────────────────────────────────────────────────

  const ARTIFACT_EXTS = 'md|markdown|txt|pdf|docx?|xlsx?|csv|pptx?|html?|png|jpe?g|webp|gif|zip|apk'
  const artifactExtList = ARTIFACT_EXTS.split('|')
  const artifactBarePattern = new RegExp('(?:~\\/|\\./|/)[^"\"' + String.fromCharCode(96) + '\\n\\r{}<>|()，；]+?\\.(?:' + ARTIFACT_EXTS + ')(?![\\p{L}\\p{N}_.])', 'giu')

  const artifactsState = { items: [], scanned: 0, total: 0, scanning: false, sessions: [] }

  const resolveArtifactPath = (raw, cwd) => {
    let v = String(raw || '').trim().replace(/^[\`'"<>()]+|[\`'"<>()]+$/g, '')
    if (v.startsWith('MEDIA:')) v = v.slice(6).trim().replace(/^[\`']+|[\`']+$/g, '')
    if (v.startsWith('file://')) v = v.slice(7).replace(/^localhost/, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('file://')) return null // http 等外链
    if (v.startsWith('/') || v.startsWith('~/')) return v
    if (!cwd) return null
    return `${cwd.replace(/\/+$/, '')}/${v.replace(/^\.\//, '')}`
  }

  const extractArtifacts = (text, cwd) => {
    if (!text) return []
    const found = new Map()
    for (const m of text.matchAll(/!?\[([^\]]*)\]\(([^)\n]+)\)/g)) {
      const p = resolveArtifactPath(m[2], cwd)
      if (p && artifactExtList.includes(fileExt(p))) found.set(p, { path: p, name: p.split('/').pop(), linkText: m[1] })
    }
    for (const m of text.matchAll(artifactBarePattern)) {
      const p = resolveArtifactPath(m[0], cwd)
      if (p) found.set(p, { path: p, name: p.split('/').pop(), linkText: '' })
    }
    return [...found.values()]
  }

  const scanArtifacts = async (count, append) => {
    if (artifactsState.scanning) return
    artifactsState.scanning = true
    renderArtifactsPage()
    try {
      let sessions = artifactsState.sessions
      if (!sessions.length || !append) {
        const rows = await rest('GET', '/api/sessions?limit=40&order=recent&include_children=false', undefined, { bust: true })
        sessions = artifactsState.sessions = rows?.sessions || []
      }
      const batch = sessions.slice(artifactsState.scanned, artifactsState.scanned + count)
      for (const session of batch) {
        artifactsState.scanned += 1
        const count0 = session.message_count || 0
        const offset = Math.max(0, count0 - 150)
        try {
          const page = await rest('GET', `/api/sessions/${encodeURIComponent(session.id)}/messages?limit=150&offset=${offset}`)
          const messages = page?.messages || []
          const cwd = session.cwd || ''
          for (const msg of messages) {
            if (msg.role !== 'assistant' && msg.role !== 'user') continue
            // dashboard REST 消息用 content（字符串），RPC TranscriptMessage 用 text
            let text = ''
            if (typeof msg.text === 'string') text = msg.text
            else if (typeof msg.content === 'string') text = msg.content
            else if (Array.isArray(msg.content)) {
              text = msg.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n')
            }
            for (const art of extractArtifacts(text, cwd)) {
              if (!artifactsState.items.some(i => i.path === art.path)) {
                artifactsState.items.push({ ...art, sessionId: session.id, sessionTitle: session.title || '会话', startedAt: session.started_at })
              }
            }
          }
        } catch { /* 单会话失败忽略 */ }
        if (artifactsState.items.length >= 60) break
      }
    } finally {
      artifactsState.scanning = false
      renderArtifactsPage()
    }
  }

  const renderArtifactsPage = () => {
    const body = MV.ui.sections.artifacts?.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    body.append(sectionHead(`已发现产物（${artifactsState.items.length}）`))
    if (artifactsState.scanning) body.append(el('div', 'hmv-loading', `正在扫描会话（${artifactsState.scanned}/${artifactsState.total || artifactsState.sessions.length || '?'}）…`))
    if (!artifactsState.items.length && !artifactsState.scanning) {
      body.append(el('div', 'hmv-drawer-empty', '还没有从会话中发现文件。点下方按钮扫描最近会话。'))
    }
    const list = el('div', 'hmv-page-list')
    body.append(list)
    for (const item of artifactsState.items) {
      const row = el('div', 'hmv-srow')
      const top = el('div', 'hmv-row-top')
      const icon = el('span', 'hmv-row-icon')
      const ext = fileExt(item.path)
      const isImg = IMAGE_EXTS.has(ext)
      icon.innerHTML = isImg
        ? `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
        : `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
      top.append(icon)
      top.append(el('span', 'hmv-row-title', item.name))
      top.append(el('span', 'hmv-row-time', relTime(item.startedAt)))
      row.append(top)
      row.append(el('div', 'hmv-row-preview', `${clampText(item.path, 46)} · 来源：${clampText(item.sessionTitle, 14)}`))
      row.addEventListener('click', () => void openDocViewer(item.path))
      MV.longPress(row, () => {
        actionSheet(item.name, [
          { label: '打开 / 预览', onTap: () => void openDocViewer(item.path) },
          { label: '打开来源会话', onTap: () => { MV.navigate('chat'); void MV.openSession(item.sessionId) } },
          { label: '复制路径', onTap: async () => { try { await window.hermesDesktop.writeClipboard(item.path); toast('路径已复制', 'success', 1600) } catch { } } }
        ])
      })
      list.append(row)
    }
    if (!artifactsState.scanning && artifactsState.scanned < artifactsState.sessions.length) {
      const more = el('button', 'hmv-page-more-btn', `继续扫描更早的会话（剩 ${artifactsState.sessions.length - artifactsState.scanned} 个）`)
      more.type = 'button'
      more.addEventListener('click', () => void scanArtifacts(6, true))
      body.append(more)
    }
    if (!artifactsState.scanning && artifactsState.scanned === 0) {
      const start = el('button', 'hmv-request-btn hmv-request-primary', '扫描最近 6 个会话')
      start.type = 'button'
      start.addEventListener('click', () => void scanArtifacts(6, false))
      body.append(start)
    }
  }

  // ── 命令中心页 ──────────────────────────────────────────────────────

  const commandsState = { categories: [], query: '', loading: false }

  const fetchCommands = async () => {
    commandsState.loading = true
    renderCommandsPage()
    try {
      const result = await rpc('commands.catalog', withProfile({}))
      const categories = Array.isArray(result?.categories) ? result.categories : []
      commandsState.categories = categories
        .map(cat => ({
          name: cat.name || '其他',
          pairs: (Array.isArray(cat.pairs) ? cat.pairs : []).map(pair => {
            // pair 正常是 [name, desc]；防个别网关给对象/字符串。
            // 网关目录的 name 自带前导 "/"（如 "/new"），剥掉后渲染层统一补一个，
            // 否则显示成 //new。
            const name = String((Array.isArray(pair) ? pair[0] : (pair?.name ?? pair)) ?? '').replace(/^\/+/, '')
            const desc = Array.isArray(pair) ? pair[1] : (pair?.description ?? '')
            return { name, desc: String(desc ?? '') }
          }).filter(p => p.name)
        }))
        .filter(cat => cat.pairs.length)
    } catch (error) {
      toast(`命令目录读取失败：${clampText(error?.message, 80)}`, 'error')
      commandsState.categories = []
    } finally {
      commandsState.loading = false
    }
    renderCommandsPage()
  }

  const dispatchCommand = async (name, arg) => {
    const entry = MV.currentEntry()
    const sessionId = entry?.runtimeId || undefined
    try {
      const result = await rpc('command.dispatch', withProfile({ name, ...(arg ? { arg } : {}), ...(sessionId ? { session_id: sessionId } : {}) }), 60000)
      // 本网关对部分命令返回空结果：如实提示已发送，效果在会话流里看
      const output = result?.output || result?.display || result?.message
        || (result?.type ? `已执行（${result.type}），效果见当前会话` : '命令已发送，效果见当前会话')
      const overlay = el('div', 'hmv-dialog-overlay')
      const box = el('div', 'hmv-dialog')
      box.append(el('h3', null, `/${name}`))
      const pre = el('div', 'hmv-doc-text', String(output).slice(0, 4000))
      box.append(pre)
      const close = el('button', 'hmv-dialog-btn hmv-dialog-ok', '关闭')
      close.type = 'button'
      close.addEventListener('click', () => overlay.remove())
      box.append(close)
      overlay.append(box)
      document.body.append(overlay)
    } catch (error) {
      toast(`执行失败：${clampText(error?.message, 100)}`, 'error')
    }
  }

  const renderCommandsPage = () => {
    const body = MV.ui.sections.commands?.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    const search = el('input', 'hmv-page-search')
    search.type = 'search'
    search.placeholder = '搜索命令'
    search.value = commandsState.query
    search.setAttribute('autocomplete', 'off')
    search.addEventListener('input', () => { commandsState.query = search.value; renderCommandsList() })
    body.append(search)
    const list = el('div', 'hmv-page-list')
    body.append(list)
    renderCommandsList(list)
  }

  const renderCommandsList = (list) => {
    list = list || MV.ui.sections.commands?.querySelector('.hmv-page-list')
    if (!list) return
    list.replaceChildren()
    if (commandsState.loading) list.append(el('div', 'hmv-loading', '加载中…'))
    const q = commandsState.query.trim().toLowerCase()
    for (const cat of commandsState.categories) {
      const pairs = cat.pairs.filter(pair => !q || `${pair.name} ${pair.desc}`.toLowerCase().includes(q))
      if (!pairs.length) continue
      list.append(sectionHead(cat.name))
      for (const pair of pairs) {
        const name = pair.name
        const desc = pair.desc
        const row = el('button', 'hmv-srow')
        row.type = 'button'
        const top = el('div', 'hmv-row-top')
        top.append(el('span', 'hmv-row-title', `/${name}`))
        row.append(top)
        if (desc) row.append(el('div', 'hmv-row-preview', clampText(desc, 70)))
        row.addEventListener('click', () => {
          actionSheet(`/${name}`, [
            { label: '直接执行', onTap: () => void dispatchCommand(name, '') },
            { label: '带参数执行…', onTap: () => promptDialog(`/${name}`, [{ name: 'arg', label: '参数' }], (v, close) => { close(); void dispatchCommand(name, String(v.arg || '').trim()) }) }
          ])
        })
        list.append(row)
      }
    }
    if (!commandsState.categories.length && !commandsState.loading) list.append(el('div', 'hmv-drawer-empty', '暂无命令。'))
  }

  // ── 消息平台页 ──────────────────────────────────────────────────────

  const messagingState = { platforms: [], live: {}, loading: false }

  const fetchMessaging = async () => {
    messagingState.loading = true
    renderMessagingPage()
    try {
      const result = await rest('GET', '/api/messaging/platforms', undefined, { bust: true })
      messagingState.platforms = Array.isArray(result?.platforms) ? result.platforms : []
    } catch (error) {
      toast(`读取消息平台失败：${clampText(error?.message, 80)}`, 'error')
      messagingState.platforms = []
    }
    try {
      const status = await rest('GET', '/api/status', undefined, { bust: true })
      messagingState.live = status?.gateway_platforms || {}
    } catch { messagingState.live = {} }
    messagingState.loading = false
    renderMessagingPage()
  }

  const renderMessagingPage = () => {
    const body = MV.ui.sections.messaging?.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    body.append(sectionHead('接入平台'))
    if (messagingState.loading && !messagingState.platforms.length) {
      body.append(el('div', 'hmv-loading', '加载中…'))
      return
    }
    if (!messagingState.platforms.length) body.append(el('div', 'hmv-drawer-empty', '暂无平台配置。'))
    const list = el('div', 'hmv-page-list')
    body.append(list)
    for (const platform of messagingState.platforms) {
      const id = platform.id || platform.platform_id || platform.name
      const live = messagingState.live[id] || messagingState.live[String(id).toLowerCase()] || {}
      const enabled = platform.enabled == null ? Boolean(platform.configured) : Boolean(platform.enabled)
      const row = el('div', 'hmv-srow')
      const top = el('div', 'hmv-row-top')
      top.append(el('span', 'hmv-row-title', platform.display_name || platform.name || id))
      const state = el('span', 'hmv-row-time', live.state ? { connected: '已连接', disconnected: '未连接', error: `错误`, retrying: '重试中' }[live.state] || live.state : (enabled ? '已启用' : '未启用'))
      if (live.state === 'connected') state.style.color = '#34a46a'
      else if (live.state === 'error') state.style.color = '#d5564e'
      top.append(state)
      row.append(top)
      const sub = [live.error_message ? `⚠ ${clampText(live.error_message, 50)}` : '', platform.description || ''].filter(Boolean).join(' · ')
      if (sub) row.append(el('div', 'hmv-row-preview', sub))
      const actions = el('div', 'hmv-request-actions')
      const toggle = el('button', 'hmv-request-btn', enabled ? '停用' : '启用')
      toggle.type = 'button'
      toggle.addEventListener('click', async () => {
        try {
          await rest('PUT', `/api/messaging/platforms/${encodeURIComponent(id)}`, { enabled: !enabled })
          toast(!enabled ? '已启用' : '已停用', 'success')
          await fetchMessaging()
        } catch (error) { toast(`操作失败：${clampText(error?.message, 80)}`, 'error') }
      })
      actions.append(toggle)
      const test = el('button', 'hmv-request-btn', '测试')
      test.type = 'button'
      test.addEventListener('click', async () => {
        try {
          const r = await rest('POST', `/api/messaging/platforms/${encodeURIComponent(id)}/test`, {})
          toast(r?.ok === false ? `测试失败：${clampText(r?.error || r?.detail || '', 60)}` : '测试通过', r?.ok === false ? 'error' : 'success')
        } catch (error) { toast(`测试失败：${clampText(error?.message, 60)}`, 'error') }
      })
      actions.append(test)
      row.append(actions)
      list.append(row)
    }
  }

  // ── Agents 页 ───────────────────────────────────────────────────────

  const agentsState = { processes: [], loading: false }

  const fetchAgents = async () => {
    agentsState.loading = true
    renderAgentsPage()
    try {
      const result = await rpc('agents.list', withProfile({}))
      agentsState.processes = Array.isArray(result?.processes) ? result.processes : []
    } catch (error) {
      toast(`读取 Agents 失败：${clampText(error?.message, 80)}`, 'error')
      agentsState.processes = []
    } finally {
      agentsState.loading = false
    }
    renderAgentsPage()
  }

  const renderAgentsPage = () => {
    const body = MV.ui.sections.agents?.querySelector('.hmv-page-body')
    if (!body) return
    body.replaceChildren()
    body.append(sectionHead(`运行中的 Agent 进程（${agentsState.processes.length}）`))
    if (agentsState.loading && !agentsState.processes.length) {
      body.append(el('div', 'hmv-loading', '加载中…'))
      return
    }
    if (!agentsState.processes.length) body.append(el('div', 'hmv-drawer-empty', '当前没有运行的 Agent 进程。'))
    const list = el('div', 'hmv-page-list')
    body.append(list)
    for (const proc of agentsState.processes) {
      const row = el('div', 'hmv-srow')
      const top = el('div', 'hmv-row-top')
      top.append(el('span', 'hmv-row-title', clampText(proc.command || proc.session_id, 40)))
      const status = el('span', 'hmv-row-time', proc.status || '')
      if (proc.status === 'running') status.style.color = '#34a46a'
      top.append(status)
      row.append(top)
      const meta = [proc.session_id, proc.uptime ? `运行 ${Math.floor(proc.uptime / 60)} 分钟` : ''].filter(Boolean).join(' · ')
      if (meta) row.append(el('div', 'hmv-row-preview', meta))
      list.append(row)
    }
  }


  // ── 页面注册 ────────────────────────────────────────────────────────

  const makeBody = section => {
    let body = section.querySelector('.hmv-page-body')
    if (!body) {
      body = el('div', 'hmv-page-body')
      section.append(body)
    }
    return body
  }

  // ── 全会话内容搜索结果页（/api/sessions/search）────────────────────
  let contentSearchState = { query: '', results: [] }

  const renderContentSearch = () => {
    const body = makeBody(MV.ui.sections['content-search'])
    body.replaceChildren()
    body.append(groupHead(`「${clampText(contentSearchState.query, 20)}」的全文命中（${contentSearchState.results.length}）`))
    const list = el('div', 'hmv-page-list')
    if (!contentSearchState.results.length) {
      list.append(el('div', 'hmv-drawer-empty', '没有匹配的内容。'))
    }
    const q = contentSearchState.query
    for (const r of contentSearchState.results) {
      const sid = r.session_id || r.id || ''
      const row = store.sessions.find(x => x.id === sid)
      const item = el('div', 'hmv-srow')
      const top = el('div', 'hmv-row-top')
      top.append(el('span', 'hmv-row-title', row?.title || (sid ? `会话 ${String(sid).slice(0, 10)}…` : '会话')))
      top.append(el('span', 'hmv-row-time', relTime(r.last_active || r.session_started)))
      item.append(top)
      // snippet 高亮命中词（服务端返回的是纯文本片段）
      const preview = el('div', 'hmv-row-preview')
      const snippet = String(r.snippet || '')
      const lower = snippet.toLowerCase()
      const ql = q.toLowerCase()
      let cursor = 0
      let at = ql ? lower.indexOf(ql) : -1
      let guard = 0
      while (at >= 0 && guard < 4) {
        if (at > cursor) preview.append(document.createTextNode(snippet.slice(cursor, at)))
        const mark = document.createElement('mark')
        mark.className = 'hmv-search-mark'
        mark.textContent = snippet.slice(at, at + q.length)
        preview.append(mark)
        cursor = at + q.length
        at = lower.indexOf(ql, cursor)
        guard++
      }
      if (cursor < snippet.length) preview.append(document.createTextNode(clampText(snippet.slice(cursor), 90)))
      item.append(preview)
      item.addEventListener('click', () => {
        if (sid) void MV.openSession(sid)
      })
      list.append(item)
    }
    body.append(list)
  }

  const openContentSearch = (query, results) => {
    contentSearchState = { query: String(query || ''), results: Array.isArray(results) ? results : [] }
    renderContentSearch()
    MV.pushPage('content-search')
  }

  MV.registerPage('files', {
    title: '文件浏览',
    onShow: () => { makeBody(MV.ui.sections.files); void openFilesPage() }
  })
  MV.registerPage('artifacts', {
    title: '产物中心',
    onShow: () => { makeBody(MV.ui.sections.artifacts); renderArtifactsPage(); if (!artifactsState.scanned && !artifactsState.scanning) void scanArtifacts(6, false) }
  })
  MV.registerPage('commands', {
    title: '命令中心',
    onShow: () => { makeBody(MV.ui.sections.commands); renderCommandsPage(); if (!commandsState.categories.length) void fetchCommands() }
  })
  MV.registerPage('messaging', {
    title: '消息平台',
    onShow: () => { makeBody(MV.ui.sections.messaging); renderMessagingPage(); if (!messagingState.platforms.length) void fetchMessaging() }
  })
  MV.registerPage('agents', {
    title: 'Agents',
    onShow: () => { makeBody(MV.ui.sections.agents); renderAgentsPage(); if (!agentsState.processes.length) void fetchAgents() }
  })
  MV.registerPage('sessions', {
    title: '会话',
    onShow: () => { makeBody(MV.ui.sections.sessions); fetchSessionsRest() }
  })
  MV.registerPage('content-search', {
    title: '内容搜索',
    onShow: () => renderContentSearch()
  })
  MV.registerPage('tasks', {
    title: '任务',
    onShow: () => { makeBody(MV.ui.sections.tasks); renderTasksPage(); fetchCronJobs() }
  })
  MV.registerPage('skills', {
    title: '技能与工具',
    onShow: () => { makeBody(MV.ui.sections.skills); renderSkillsPage(); fetchSkillsData() }
  })
  MV.registerPage('more', {
    title: '更多',
    onShow: () => { makeBody(MV.ui.sections.more); renderMorePage(); fetchMoreData() }
  })

  // 核心回调
  window.__hermesMVPages = {
    openModelPicker: () => void openModelPicker(),
    openContentSearch: (query, results) => void openContentSearch(query, results),
    onSessionsUpdated: rows => {
      sessionsState.rows = (rows || []).map(r => ({ ...r, pinned: r.pinned ?? sessionsState.rows.find(x => x.id === r.id)?.pinned ?? false }))
      if (store.activeTab === 'sessions') renderSessionsList()
    },
    onRequestsUpdated: () => {
      MV.updateBadges()
      if (store.activeTab === 'tasks') renderTasksPage()
    },
    onConnected: () => {
      if (store.activeTab === 'sessions') fetchSessionsRest()
      else if (store.activeTab === 'skills') fetchSkillsData()
      else if (store.activeTab === 'more') fetchMoreData()
    }
  }
})()
