import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InboundCommand, InboundContext, OutboundEvent, SessionListEntry, SessionSnapshot } from "./types.js"
import { appendFileSync } from "node:fs"
import { loadConfig, type PluginConfig } from "./config.js"
import { ShareStateManager } from "./share-state.js"
import { Security } from "./security.js"
import { lastAssistantText, summarize, textOfMessage } from "./session.js"
import { MockTransport } from "./transport/mock.js"
import { createTransport } from "./transport/index.js"
import { RelayTransport } from "./transport/relay.js"
import { LeaderHub } from "./hub.js"
import { acquireTransportLock, newInstanceID } from "./lock.js"
import { renderOutbound, renderStreamingCard, renderProcessedCard, splitContent, cardTail, HELP_TEXT } from "./renderer.js"
import { cardActionToCommand } from "./router.js"

const TEST_PROMPT = "Reply with exactly: PONG"

export const id = "opencode-feishu-share"

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const config: PluginConfig = loadConfig()
  const instanceID = newInstanceID()
  const share = new ShareStateManager()
  const security = new Security(config)
  let transport: ReturnType<typeof createTransport> | RelayTransport | null = null
  let releaseTransportLock: (() => void) | null = null
  // 跨 TUI 进程协作：followerMode = 本进程不直连飞书（leader 持锁）；hub = leader 侧中继枢纽
  let followerMode = false
  let hub: LeaderHub | null = null
  // 事件流调试日志（FEISHU_SHARE_DEBUG=1 时启用，排查事件时序用）
  const dbg = ((msg: string): void => {
    if (process.env.FEISHU_SHARE_DEBUG !== "1") return
    try {
      appendFileSync(`${config.stateDir}/plugin-debug.log`, `${new Date().toISOString()} ${msg}\n`)
    } catch {
      // 日志失败不影响主流程
    }
  })

  // ---- 出站通知（busy 去重 + idle 完成后拉取结果；后续阶段做合并/节流） ----
  let busySessions = new Set<string>()
  const pendingPermissions = new Map<string, unknown>()
  const pendingQuestions = new Map<string, unknown>()
  const permissionOrder: string[] = []
  const questionOrder: string[] = []
  // 会话忙时的远程 prompt 队列（对齐 TUI 本地排队语义）——按 session 隔离
  const promptQueues = new Map<string, string[]>()
  // TUI 本地输入镜像：用户消息 ID 集合 / 已镜像 part / 插件注入 prompt 记录（防回声）
  const userMessageIDs = new Set<string>()
  const mirroredParts = new Set<string>()
  const recentInjected = new Map<string, number>()
  // /model 与 /agent 的列表缓存（保证 list 与 switch 编号一致性）
  let modelCache: Array<{ providerID: string; modelID: string; label: string }> = []
  let agentCache: Array<{ name: string; label: string }> = []
  // 远程切换 agent/model 的回声抑制窗口：插件自己调用 switch API 后短暂屏蔽事件同步，避免飞书重复通知
  let remoteSwitchUntil = 0

  /** 某 session 的排队队列（无则建空队列） */
  const queueOf = (sessionID: string): string[] => {
    let q = promptQueues.get(sessionID)
    if (!q) {
      q = []
      promptQueues.set(sessionID, q)
    }
    return q
  }

  /** 事件卡归属标记：单会话不标注；多会话时非 active 会话标（后台） */
  const titleFor = (sessionID: string): string | undefined => {
    const title = api.state.session.get(sessionID)?.title
    if (!title) return title
    if (share.count > 1 && share.activeSessionID !== sessionID) return `（后台）${title}`
    return title
  }

  /** 事件发送的目标 chatID：优先该 session 分享时绑定的 chat，兜底默认 chat */
  const chatIDFor = (sessionID: string): string =>
    share.targetOf(sessionID)?.chatID ?? (config.defaultChatID || "mock")

  /** /session 列表条目（全局分享顺序 + 当前标记；标题：本进程走 state，follower 走注册表） */
  const sessionListEntries = (): SessionListEntry[] =>
    share.list().map((t) => {
      const extPID = share.externalOwnerOf(t.sessionID)
      let title: string | undefined
      if (extPID === undefined) {
        title = api.state.session.get(t.sessionID)?.title
      } else {
        const fs = hub?.followerSession(t.sessionID)
        title = fs?.title
      }
      return {
        sessionID: t.sessionID,
        title,
        active: t.sessionID === share.activeSessionID,
      }
    })

  /** follower 模式：把本进程会话与快照写进注册表（leader 据此列表/切换/渲染卡片标题） */
  const followerSessions = async (): Promise<Array<{ sessionID: string; chatID: string; title?: string; snapshot?: import("./relay.js").SwitchSnapshot }>> => {
    const out: Array<{ sessionID: string; chatID: string; title?: string; snapshot?: import("./relay.js").SwitchSnapshot }> = []
    for (const t of share.list().filter((x) => !share.externalOwnerOf(x.sessionID))) {
      const sid = t.sessionID
      const msgs = await fetchMessages(sid, 20).catch(() => [])
      const sm = summarize(api.state.session.get(sid), msgs as never)
      out.push({
        sessionID: sid,
        chatID: t.chatID,
        title: api.state.session.get(sid)?.title,
        snapshot: {
          title: api.state.session.get(sid)?.title,
          messageCount: sm.messageCount,
          status: api.state.session.status(sid)?.type ?? "idle",
          statusText: await buildStatusText(sid).catch(() => ""),
          lastUserText: sm.lastUserText,
          lastAssistantText: sm.lastAssistantText,
        },
      })
    }
    return out
  }

  const publishFollowerMeta = async (): Promise<void> => {
    if (!followerMode || !(transport instanceof RelayTransport)) return
    const relay = transport as RelayTransport
    const sessions = await followerSessions()
    try {
      relay.publishSessions(sessions)
    } catch {
      // 注册表刷新失败不阻塞
    }
  }

  const listModels = (): Array<{ providerID: string; modelID: string; label: string }> => {
    if (modelCache.length > 0) return modelCache
    const out: Array<{ providerID: string; modelID: string; label: string }> = []
    for (const provider of api.state.provider ?? []) {
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        out.push({ providerID: provider.id, modelID, label: `${provider.id}/${modelID}（${model.name}）` })
      }
    }
    modelCache = out
    return out
  }

  const listAgents = async (): Promise<Array<{ name: string; label: string }>> => {
    if (agentCache.length > 0) return agentCache
    const res = await api.client.v2.agent.list()
    // 注意两点（实测确认）：
    // 1. res.data 是 { location, data: AgentV2Info[] } 包装对象，不是数组——直接 .filter 会抛 TypeError
    //    被 void handleInbound() 静默吞掉，表现为 /agent 完全没反应
    // 2. AgentV2Info 字段是 id（不是 name），取错字段列表全变 undefined
    const payload = res.error === undefined ? res.data : undefined
    const agents = (Array.isArray(payload) ? payload : (payload?.data ?? [])) as Array<{
      id: string
      description?: string
      mode?: string
      hidden?: boolean
    }>
    agentCache = agents
      .filter((a) => !a.hidden && a.mode !== "subagent")
      .map((a) => ({ name: a.id, label: a.description ? `${a.id}（${a.description}）` : a.id }))
    return agentCache
  }

  /** 将 "#latest"/"#n" 选择器解析为真实 requestID */
  const resolveSelector = (selector: string, order: string[]): string | null => {
    if (!selector.startsWith("#")) return pendingPermissions.has(selector) || pendingQuestions.has(selector) ? selector : null
    if (selector === "#latest") return order[order.length - 1] ?? null
    const n = Number(selector.slice(1))
    if (!Number.isInteger(n) || n < 1) return null
    return order[n - 1] ?? null
  }

  const emit = async (event: OutboundEvent): Promise<string | undefined> => {
    if (!transport) return undefined
    // 自动注入会话摘要（卡片标题显示用；多会话时后台会话加（后台）标记）
    const withTitle: OutboundEvent =
      event.sessionID && !event.sessionTitle
        ? { ...event, sessionTitle: titleFor(event.sessionID) }
        : event
    try {
      return await transport.send(withTitle)
    } catch (err) {
      api.ui.toast({ variant: "error", title: "feishu-share", message: `send failed: ${String(err)}` })
      return undefined
    }
  }

  // ---- 流式任务卡（busy 发出，中间过程对齐 TUI：工具时间线/思考中/正文流式，idle/error 定稿） ----
  type Streaming = {
    messageID: string
    parts: Map<string, string>
    textPartIDs: Set<string>
    reasoningActive: boolean
    questionPending: boolean
    tools: Map<string, { tool: string; title: string; status: string }>
    lastFlush: number
    timer: ReturnType<typeof setTimeout> | null
  }
  // 流式卡状态机按 session 隔离：多会话并发流式互不覆盖 messageID
  const streaming = new Map<string, Streaming>()
  const STREAM_INTERVAL_MS = 1200
  const TIMELINE_MAX = 6
  // 提问回答后的续段流式：旧卡定格，agent 继续产出时开新卡（保证回复在飞书消息底部可见）——按 session 隔离
  type ResumeState = { active: boolean; opening: boolean; buffer: Array<{ id?: string; type?: string; text?: string; tool?: string; state?: { status?: string; title?: string } }> }
  const resumeStates = new Map<string, ResumeState>()
  const resumeStateOf = (sessionID: string): ResumeState => {
    let rs = resumeStates.get(sessionID)
    if (!rs) {
      rs = { active: false, opening: false, buffer: [] }
      resumeStates.set(sessionID, rs)
    }
    return rs
  }
  // busy 已声明但流式卡未就绪期间到达的 parts（中继/WS 延迟窗口）：先缓冲，卡就绪后回放
  const pendingParts = new Map<string, Array<{ id?: string; type?: string; text?: string; tool?: string; state?: { status?: string; title?: string } }>>()

  /** 把一个 message part 应用到流式卡（text→正文 / tool→时间线 / reasoning→思考中） */
  const applyPartToStreaming = (
    sessionID: string,
    target: Streaming,
    p: { id?: string; type?: string; text?: string; tool?: string; state?: { status?: string; title?: string } },
  ): void => {
    if (!target || !p?.id) return
    if (p.type === "text") {
      // 空 text part（如 step 占位）不覆盖已有内容/思考状态，避免卡片"回退"观感
      if (p.text === undefined || p.text === "") return
      target.textPartIDs.add(p.id)
      target.parts.set(p.id, p.text)
      target.reasoningActive = false
      scheduleStreamingFlush(sessionID)
      return
    }
    if (p.type === "tool") {
      if (p.tool === "question") {
        // 提问工具：单独的问答卡负责展示，流式卡只显示等待状态，不进时间线
        // 按工具状态同步等待标志（answered 后不再误显示"等待你的回答"）
        const st = p.state?.status
        target.questionPending = !(st === "completed" || st === "error")
        scheduleStreamingFlush(sessionID)
        return
      }
      const title = p.state?.title || p.tool || "工具"
      target.questionPending = false
      target.tools.set(p.id, { tool: p.tool ?? "tool", title, status: p.state?.status ?? "pending" })
      scheduleStreamingFlush(sessionID)
      return
    }
    if (p.type === "reasoning" && target.parts.size === 0) {
      target.reasoningActive = true
      scheduleStreamingFlush(sessionID)
    }
  }

  /** 回答后开新流式卡：先落卡，再把等卡期间的 parts 按序回放进去 */
  const openResumeCard = (sessionID: string): void => {
    const rs = resumeStateOf(sessionID)
    rs.opening = true
    dbg(`resume-card opening session=${sessionID.slice(0, 12)} buffer=${rs.buffer.length}`)
    void (async () => {
      const messageID = await emit({ kind: "task_resumed", sessionID, chatID: chatIDFor(sessionID) })
      if (!messageID) {
        dbg("resume-card open FAILED (no messageID)")
        rs.opening = false
        return
      }
      dbg(`resume-card opened ${messageID.slice(0, 16)} replay=${rs.buffer.length}`)
      const s: Streaming = {
        messageID,
        parts: new Map(),
        textPartIDs: new Set(),
        reasoningActive: false,
        questionPending: false,
        tools: new Map(),
        lastFlush: 0,
        timer: null,
      }
      for (const part of rs.buffer) applyPartToStreaming(sessionID, s, part)
      rs.buffer = []
      streaming.set(sessionID, s)
      rs.active = false
      rs.opening = false
      void flushStreaming(sessionID, false)
    })()
  }

  const streamingText = (sessionID: string): string => [...(streaming.get(sessionID)?.parts.values() ?? [])].join("\n").trim()

  /** OpenCode 风格活动时间线（最近 N 条：✓ 完成 / ⟳ 运行中 / ✗ 失败 / … 等待） */
  const streamingTimeline = (target: Streaming | null): string => {
    if (!target || target.tools.size === 0) return ""
    const entries = [...target.tools.values()].slice(-TIMELINE_MAX)
    return entries
      .map((t) => {
        if (t.status === "completed") return `✓ ${t.title}`
        if (t.status === "error") return `✗ ${t.title}`
        if (t.status === "running") return `⟳ **${t.title}**`
        return `… ${t.title}`
      })
      .join("\n")
  }

  const flushStreaming = async (sessionID: string, final: boolean, errText?: string): Promise<void> => {
    const st = streaming.get(sessionID)
    if (!st || !transport) return
    if (st.timer) {
      clearTimeout(st.timer)
      st.timer = null
    }
    st.lastFlush = Date.now()
    const text = streamingText(sessionID)
    const timeline = streamingTimeline(st)
    const queued = promptQueues.get(sessionID)?.length ?? 0
    const segments: string[] = []
    if (timeline) segments.push(timeline)
    if (st.questionPending) segments.push("❓ 等待你的回答…")
    if (queued > 0) segments.push(`📥 排队 prompt：${queued} 条`)
    if (text) segments.push(final ? text : `${cardTail(`${text} ▌`)} ▌`)
    if (segments.length === 0) {
      segments.push(final ? "（无文本输出）" : st.reasoningActive ? "🤔 思考中…" : "正在处理…")
    } else if (!final && text && st.reasoningActive) {
      segments.push("🤔 思考中…")
    }
    const body = errText ?? segments.join("\n\n")
    try {
      if (errText) {
        await transport.updateCard(st.messageID, renderStreamingCard("❌ 执行失败", cardTail(body), "red"))
        return
      }
      if (!final) {
        await transport.updateCard(st.messageID, renderStreamingCard("⏳ 正在处理", body, "blue"))
        return
      }
      // 成功定格：超长正文分页为多张卡（首卡原地更新，续页新增卡片），避免飞书单卡截断
      const chunks = splitContent(body)
      const total = chunks.length
      for (let i = 0; i < total; i++) {
        const card = renderStreamingCard(`✅ 任务完成${total > 1 ? ` (${i + 1}/${total})` : ""}`, chunks[i]!, "green")
        if (i === 0) await transport.updateCard(st.messageID, card)
        else await transport.sendCard(card)
      }
    } catch {
      // 卡片更新失败不影响本地任务
    }
  }

  const scheduleStreamingFlush = (sessionID: string): void => {
    const st = streaming.get(sessionID)
    if (!st) return
    const now = Date.now()
    const due = st.lastFlush + STREAM_INTERVAL_MS
    if (now >= due) {
      void flushStreaming(sessionID, false)
      return
    }
    if (!st.timer) {
      st.timer = setTimeout(() => void flushStreaming(sessionID, false), due - now)
    }
  }

  const closeStreaming = (sessionID: string): void => {
    const st = streaming.get(sessionID)
    if (st?.timer) clearTimeout(st.timer)
    streaming.delete(sessionID)
  }

  /** 单会话停止分享后清空其派生状态（流式卡/队列/续段/pending 审批与提问） */
  const cleanupSessionState = (sessionID: string): void => {
    busySessions.delete(sessionID)
    promptQueues.delete(sessionID)
    closeStreaming(sessionID)
    resumeStates.delete(sessionID)
    pendingParts.delete(sessionID)
    for (const [id, props] of pendingPermissions) {
      if ((props as { sessionID?: string }).sessionID === sessionID) {
        pendingPermissions.delete(id)
        const idx = permissionOrder.indexOf(id)
        if (idx >= 0) permissionOrder.splice(idx, 1)
      }
    }
    for (const [id, props] of pendingQuestions) {
      if ((props as { sessionID?: string }).sessionID === sessionID) {
        pendingQuestions.delete(id)
        const idx = questionOrder.indexOf(id)
        if (idx >= 0) questionOrder.splice(idx, 1)
      }
    }
  }

  /** 飞书指令的目标会话：优先按来源 chat 精确匹配（D6），多会话同 chat 时取 active */
  const resolveTargetSession = (ctx: InboundContext): string | null => {
    const inChat = share.list().filter((t) => t.chatID === ctx.chatID)
    if (inChat.length > 0) {
      const activeID = share.activeSessionID
      return inChat.find((t) => t.sessionID === activeID)?.sessionID ?? inChat[0]!.sessionID
    }
    return share.activeSessionID
  }

  const fetchMessages = async (sessionID: string, limit: number) => {
    const res = await api.client.session.messages({ sessionID, limit })
    if (res.error !== undefined) return []
    return res.data ?? []
  }

  const buildSnapshot = async (sessionID: string): Promise<SessionSnapshot> => {
    const session = api.state.session.get(sessionID)
    let messages: Array<{ info: unknown; parts: unknown[] }> = []
    try {
      messages = await fetchMessages(sessionID, 20)
    } catch {
      messages = []
    }
    const s = summarize(session, messages as never)
    return {
      id: s.id,
      title: s.title,
      messageCount: s.messageCount,
      status: api.state.session.status(sessionID)?.type ?? "idle",
      lastAssistantText: s.lastAssistantText,
      directory: api.state.path.directory,
    }
  }

  const buildStatusText = async (sessionID: string): Promise<string> => {
    // 对齐 TUI 右侧栏/底栏的上下文信息：模型、agent、Context tokens、费用、文件变更、待办
    let lastAssistant:
      | {
          role?: string
          modelID?: string
          providerID?: string
          agent?: string
          cost?: number
          tokens?: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
        }
      | undefined
    try {
      const msgs = await fetchMessages(sessionID, 10)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info as typeof lastAssistant
        if (info?.role === "assistant") {
          lastAssistant = info
          break
        }
      }
    } catch {
      // 无消息
    }
    const session = api.state.session.get(sessionID)
    const st = api.state.session.status(sessionID)?.type ?? "idle"
    const files = api.state.session.diff(sessionID)
    const todos = api.state.session.todo(sessionID)

    const tok = lastAssistant?.tokens
    const contextTokens =
      tok?.total ?? (tok ? tok.input + tok.output + (tok.cache?.read ?? 0) + (tok.cache?.write ?? 0) + (tok.reasoning ?? 0) : undefined)
    const fmtK = (n: number | undefined): string =>
      n === undefined ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
    const doneTodos = todos.filter((t) => t.status === "completed").length
    const addDel = files.reduce((acc, f) => ({ a: acc.a + f.additions, d: acc.d + f.deletions }), { a: 0, d: 0 })
    const messageCount = api.state.session.messages(sessionID).length

    // 每个栏目独占一行；会话标题已在卡片头部，不再重复
    const lines = [
      `**模型**：${lastAssistant?.providerID ?? "?"}/${lastAssistant?.modelID ?? "?"}`,
      `**Agent**：${lastAssistant?.agent ?? "?"}`,
      `**Context**：${fmtK(contextTokens)} tokens`,
      `**费用**：$${(lastAssistant?.cost ?? 0).toFixed(4)}`,
      `**状态**：${st}`,
      `**消息数**：${messageCount}`,
      files.length > 0 ? `**文件变更**：${files.length} 个（+${addDel.a}/-${addDel.d}）` : null,
      todos.length > 0 ? `**待办**：${doneTodos}/${todos.length} 完成` : null,
      (promptQueues.get(sessionID)?.length ?? 0) > 0 ? `**排队远程 prompt**：${promptQueues.get(sessionID)?.length}` : null,
    ]
    return lines.filter(Boolean).join("\n")
  }

  /**
   * 解析远程 prompt 应沿用的模型/agent。优先级：
   * 1) 服务端会话状态（v2 session.get，权威——实时反映 switchAgent/switchModel，
   *    已实测远程/TUI 切换后该字段立即更新；TUI 本地状态对外部切换可能滞后，不可作唯一依据）
   * 2) TUI 本地状态（server 查询失败时兜底）
   * 3) 最后一条 assistant 消息（最终兜底）
   * 不能只读最后一条消息——那会把刚切换的 agent/model 又钉回旧值，导致切换"无效"。
   */
  const resolveSessionModel = async (
    sessionID: string,
  ): Promise<{ model?: { providerID: string; modelID: string }; agent?: string }> => {
    let model: { providerID: string; modelID: string } | undefined
    let agent: string | undefined

    // 1) 服务端会话状态
    try {
      const res = await api.client.v2.session.get({ sessionID })
      if (res.error === undefined) {
        // 与 agent.list 同款包装：data 可能是 { data: SessionV2Info }
        const s = ((res.data as { data?: { agent?: string; model?: { providerID?: string; id?: string } } })?.data ??
          res.data) as { agent?: string; model?: { providerID?: string; id?: string } } | undefined
        if (s?.model?.providerID && s.model.id) model = { providerID: s.model.providerID, modelID: s.model.id }
        if (typeof s?.agent === "string" && s.agent) agent = s.agent
      }
    } catch {
      // 查询失败走下方兜底
    }

    // 2) TUI 本地状态
    if (!model || !agent) {
      const s = api.state.session.get(sessionID) as
        | { agent?: string; model?: { providerID?: string; id?: string } }
        | undefined
      if (!model && s?.model?.providerID && s.model.id) model = { providerID: s.model.providerID, modelID: s.model.id }
      if (!agent && typeof s?.agent === "string" && s.agent) agent = s.agent
    }

    // 3) 最后一条 assistant 消息
    if (!model || !agent) {
      try {
        const msgs = await fetchMessages(sessionID, 10)
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i]?.info as
            | { role?: string; modelID?: string; providerID?: string; agent?: string }
            | undefined
          if (info?.role !== "assistant") continue
          if (!model && info.modelID && info.providerID) {
            model = { providerID: info.providerID, modelID: info.modelID }
          }
          if (!agent && typeof info.agent === "string" && info.agent) agent = info.agent
          break
        }
      } catch {
        // 读取失败则不带 model（回落 server 默认）
      }
    }
    return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) }
  }

  /** 以经典 parts prompt 注入（消息会像本地输入一样出现在 TUI 会话中） */
  const submitPrompt = async (sid: string, text: string): Promise<void> => {
    // 记录插件注入的 prompt 文本（60s 内用于抑制 TUI 输入镜像的回声）
    recentInjected.set(text, Date.now())
    if (recentInjected.size > 64) {
      const oldest = [...recentInjected.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) recentInjected.delete(oldest[0])
    }
    const { model, agent } = await resolveSessionModel(sid)
    const res = await api.client.session.prompt({
      sessionID: sid,
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text }],
    })
    if (res.error !== undefined) {
      throw new Error(JSON.stringify(res.error))
    }
  }

  /** 会话空闲后依次执行排队的远程 prompt */
  const drainPromptQueue = async (sessionID: string): Promise<void> => {
    const chatID = chatIDFor(sessionID)
    const queue = queueOf(sessionID)
    while (queue.length > 0) {
      const text = queue[0]!
      try {
        await submitPrompt(sessionID, text)
      } catch (err) {
        if (/busy/i.test(String(err))) return // 又忙了，等下一个 idle
        queue.shift()
        await emit({ kind: "task_failed", sessionID, chatID, error: `queued prompt: ${String(err)}` })
        continue
      }
      queue.shift()
      return // 已启动一个回合，等它完成后的下一个 idle 继续
    }
  }

  // ---- 入站命令处理（飞书 → TUI） ----
  const sendRejected = async (chatID: string, reason: string): Promise<void> => {
    await emit({ kind: "status", sessionID: share.activeSessionID ?? "", chatID, text: `rejected: ${reason}` })
  }

  /** 回答明细文本：Q 保留原问题、A 显示选择（问题原文缺失时只显示 A） */
  const answerDetail = (answers: string[] | string[][], qInfo: Array<{ question?: string; header?: string }>): string => {
    const rows = (answers.length > 0 && Array.isArray(answers[0]) ? answers : [answers]) as unknown as string[][]
    return rows
      .map((a, i) => {
        const q = qInfo[i]?.question || qInfo[i]?.header || ""
        const qLine = q ? `Q${i + 1}. ${q.slice(0, 120)}\n` : ""
        return `${qLine}A${i + 1}. ${a.length > 0 ? a.join("、") : "（跳过）"}`
      })
      .join("\n")
  }

  const handleInbound = async (
    cmd: InboundCommand,
    ctx: InboundContext,
    opts?: { silentStatus?: boolean; targetSessionID?: string },
  ): Promise<void> => {
    const guard = security.checkInbound(ctx)
    if (!guard.ok) {
      security.audit({ direction: "in", action: cmd.action, ok: false, senderID: ctx.senderID, chatID: ctx.chatID, detail: guard.reason })
      await sendRejected(ctx.chatID, guard.reason)
      return
    }
    // 审批/提问回复：requestID 跨实例归属——follower 发起的审批/提问必须转发回 follower
    if (cmd.action === "permission_reply" || cmd.action === "question_reply") {
      const order = cmd.action === "permission_reply" ? permissionOrder : questionOrder
      const ownResolvable = cmd.requestID.startsWith("#")
        ? resolveSelector(cmd.requestID, order) !== null
        : (cmd.action === "permission_reply" ? pendingPermissions : pendingQuestions).has(cmd.requestID)
      if (!ownResolvable && hub) {
        const pid = hub.ownerOfRequest(cmd.requestID)
        if (pid) {
          security.audit({ direction: "in", action: cmd.action, ok: true, senderID: ctx.senderID, chatID: ctx.chatID, detail: `relay->pid ${pid}` })
          hub.forwardCommand(pid, cmd, ctx)
          return
        }
      }
    }
    // 多会话管理指令（列表/切换）作用于全局列表；断开指令在 case stop 内处理跨实例转发
    const bypassSessionCheck = cmd.action === "stop" || cmd.action === "session_list" || cmd.action === "session_switch"
    let sid = ""
    if (!bypassSessionCheck) {
      const sessionID = opts?.targetSessionID ?? resolveTargetSession(ctx)
      if (!sessionID) {
        security.audit({ direction: "in", action: cmd.action, ok: false, senderID: ctx.senderID, chatID: ctx.chatID, detail: "no shared session" })
        await sendRejected(ctx.chatID, "no shared session")
        return
      }
      if (!share.routeCommand(sessionID)) {
        security.audit({ direction: "in", action: cmd.action, ok: false, senderID: ctx.senderID, chatID: ctx.chatID, detail: "session mismatch" })
        await sendRejected(ctx.chatID, "session mismatch")
        return
      }
      // external 会话（其他 TUI 进程的）：转发给属主
      const pid = share.externalOwnerOf(sessionID)
      if (pid) {
        security.audit({ direction: "in", action: cmd.action, ok: true, senderID: ctx.senderID, chatID: ctx.chatID, detail: `relay->pid ${pid}` })
        hub?.forwardCommand(pid, cmd, ctx, sessionID)
        return
      }
      sid = sessionID
    }
    security.audit({ direction: "in", action: cmd.action, ok: true, senderID: ctx.senderID, chatID: ctx.chatID })

    // 兜底：命令处理抛出的任何异常都回一张错误卡 + 写调试日志，绝不静默失败
    //（此前 void handleInbound() 会吞掉 unhandled rejection，飞书侧表现为"没反应"）
    try {
      await runInbound(cmd, ctx, sid, opts)
    } catch (err) {
      dbg(`inbound ${cmd.action} ERROR: ${String(err)}`)
      await emit({ kind: "task_failed", sessionID: sid, chatID: ctx.chatID, error: `${cmd.action}: ${String(err)}` })
    }
  }

  /** 入站命令分发（前置校验通过后的 switch 部分） */
  const runInbound = async (
    cmd: InboundCommand,
    ctx: InboundContext,
    sid: string,
    opts?: { silentStatus?: boolean; targetSessionID?: string },
  ): Promise<void> => {
    switch (cmd.action) {
      case "prompt": {
        const text = (cmd.text ?? "").trim()
        if (!text) return
        const st = api.state.session.status(sid)?.type
        if (st === "busy" || st === "retry") {
          // 会话忙：进入插件自管队列（流式卡显示 📥 队列行），idle 后自动执行
          const queue = queueOf(sid)
          queue.push(text)
          if (streaming.has(sid)) void flushStreaming(sid, false)
          else
            await emit({
              kind: "status",
              sessionID: sid,
              chatID: ctx.chatID,
              text: `已加入队列（第 ${queue.length} 条），当前任务结束后自动执行`,
            })
          return
        }
        try {
          // 空闲直接提交；不发送确认卡 —— 紧随其后的流式任务卡即是反馈
          await submitPrompt(sid, text)
        } catch (err) {
          const msg = String(err)
          if (/busy/i.test(msg)) {
            const queue = queueOf(sid)
            queue.push(text)
            if (streaming.has(sid)) scheduleStreamingFlush(sid)
            else
              await emit({
                kind: "status",
                sessionID: sid,
                chatID: ctx.chatID,
                text: `会话转为忙碌，已加入队列（第 ${queue.length} 条）`,
              })
          } else {
            await emit({ kind: "task_failed", sessionID: sid, chatID: ctx.chatID, error: `prompt: ${msg}` })
          }
        }
        return
      }
      case "status": {
        await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: await buildStatusText(sid) })
        return
      }
      case "recent": {
        const msgs = await fetchMessages(sid, 1)
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: msgs.length ? textOfMessage(msgs[msgs.length - 1]!).slice(0, 800) : "(empty)",
        })
        return
      }
      case "abort": {
        const res = await api.client.session.abort({ sessionID: sid })
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: res.error !== undefined ? `abort failed: ${JSON.stringify(res.error)}` : "abort sent",
        })
        return
      }
      case "permission_reply": {
        const requestID = resolveSelector(cmd.requestID, permissionOrder)
        if (!requestID || !pendingPermissions.has(requestID)) {
          await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: `rejected: permission ${cmd.requestID} not pending` })
          return
        }
        pendingPermissions.delete(requestID)
        const idx = permissionOrder.indexOf(requestID)
        if (idx >= 0) permissionOrder.splice(idx, 1)
        const res = await api.client.permission.reply({ requestID, reply: cmd.reply })
        if (!opts?.silentStatus) {
          await emit({
            kind: "status",
            sessionID: sid,
            chatID: ctx.chatID,
            text: res.error !== undefined
              ? `审批失败: ${JSON.stringify(res.error)}`
              : `已审批：${cmd.reply === "once" ? "批准一次" : cmd.reply === "always" ? "永久批准" : "拒绝"}`,
          })
        }
        return
      }
      case "question_reply": {
        const requestID = resolveSelector(cmd.requestID, questionOrder)
        if (!requestID || !pendingQuestions.has(requestID)) {
          await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: `rejected: question ${cmd.requestID} not pending` })
          return
        }
        pendingQuestions.delete(requestID)
        const idx = questionOrder.indexOf(requestID)
        if (idx >= 0) questionOrder.splice(idx, 1)
        // 兼容两种入参：string[]（第一个问题的选项）或 string[][]（每个问题的选项）
        const answers =
          cmd.answers.length > 0 && Array.isArray(cmd.answers[0])
            ? (cmd.answers as unknown as string[][])
            : [cmd.answers as unknown as string[]]
        const res = await api.client.question.reply({ requestID, answers })
        if (!opts?.silentStatus) {
          await emit({
            kind: "status",
            sessionID: sid,
            chatID: ctx.chatID,
            text: res.error !== undefined
              ? `回答失败: ${JSON.stringify(res.error)}`
              : `已回答：${answers.map((a) => a.join("、") || "(跳过)").join(" / ")}`,
          })
        }
        return
      }
      case "question_custom": {
        // 用户点击"✍️ 其他答案"：引导用 /answer 文本回复（#latest 即该问题）
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: "✍️ 请直接回复：`/answer <你的答案>`\n（将作为本次提问的回答）",
        })
        return
      }
      case "help": {
        await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: HELP_TEXT })
        return
      }
      case "model_list": {
        const entries = listModels()
        const { model: current } = await resolveSessionModel(sid)
        const cur = current ? `${current.providerID}/${current.modelID}` : "(未知)"
        const text = [`**当前模型**：${cur}`, "", ...entries.map((m, i) => `**${i + 1}.** ${m.label}`)].join("\n")
        await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: text.slice(0, 3000) })
        return
      }
      case "model_switch": {
        const entries = listModels()
        const target = entries[cmd.index - 1]
        if (!target) {
          await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: `rejected: 模型序号 ${cmd.index} 不存在（先发 /model 查看列表）` })
          return
        }
        remoteSwitchUntil = Date.now() + 5000
        const res = await api.client.v2.session.switchModel({
          sessionID: sid,
          model: { id: target.modelID, providerID: target.providerID },
        })
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: res.error !== undefined ? `切换失败: ${JSON.stringify(res.error)}` : `已切换模型 → ${target.label}`,
        })
        return
      }
      case "agent_list": {
        const entries = await listAgents()
        const current = (await resolveSessionModel(sid)).agent
        const text = [`**当前 Agent**：${current ?? "(未知)"}`, "", ...entries.map((a, i) => `**${i + 1}.** ${a.label}`)].join("\n")
        await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: text.slice(0, 3000) })
        return
      }
      case "agent_switch": {
        const entries = await listAgents()
        const target = entries[cmd.index - 1]
        if (!target) {
          await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: `rejected: Agent 序号 ${cmd.index} 不存在（先发 /agent 查看列表）` })
          return
        }
        remoteSwitchUntil = Date.now() + 5000
        const res = await api.client.v2.session.switchAgent({ sessionID: sid, agent: target.name })
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: res.error !== undefined ? `切换失败: ${JSON.stringify(res.error)}` : `已切换 Agent → ${target.label}`,
        })
        return
      }
      case "stop": {
        if (cmd.scope === "all") {
          // 全部断开：转发给所有 follower（它们自停自清），再停本进程全部
          if (hub) {
            for (const ownerID of new Set(hub.listSessions().map((s) => s.ownerID))) {
              hub.forwardCommand(ownerID, { action: "stop", scope: "all" }, ctx)
            }
          }
          stopSharing("remote stop", "all")
          return
        }
        const target = opts?.targetSessionID ?? (sid || share.activeSessionID)
        if (!target) {
          stopSharing("remote stop", "active") // 无会话：保持 0.1.x 收尾行为
          return
        }
        const pid = share.externalOwnerOf(target)
        if (pid) {
          // active 属于其他 TUI：定向转发（targetSessionID 防止 follower 停错自己的 active）
          hub?.forwardCommand(pid, { action: "stop", scope: "active", targetSessionID: target }, ctx)
          return
        }
        stopSharing("remote stop", "active", target)
        return
      }
      case "session_list": {
        if (share.count === 0) {
          await emit({ kind: "status", sessionID: "", chatID: ctx.chatID, text: "当前没有已分享的会话（在 TUI 里 /feishu → Share current session）" })
          return
        }
        await emit({ kind: "session_list", sessionID: share.activeSessionID ?? "", chatID: ctx.chatID, sessions: sessionListEntries() })
        return
      }
      case "session_switch": {
        const list = share.list()
        const target = list[cmd.index - 1]
        if (!target) {
          await emit({
            kind: "status",
            sessionID: share.activeSessionID ?? "",
            chatID: ctx.chatID,
            text: `rejected: 会话序号 ${cmd.index} 不存在（先发 /session 查看列表，共 ${list.length} 个）`,
          })
          return
        }
        const previous = share.activeSessionID
        if (previous === target.sessionID) {
          const title = sessionListEntries().find((s) => s.sessionID === target.sessionID)?.title
          await emit({ kind: "status", sessionID: target.sessionID, chatID: ctx.chatID, text: `当前已在该会话上（${title ?? target.sessionID}），无需切换` })
          return
        }
        share.setActive(target.sessionID)
        // D3 三段式：切换提醒（卡标题）+ 历史 summary + 最新一次交互
        // 本进程会话：实时查询；external 会话：读属主同步过来的快照（跨进程拿不到对方服务端）
        const extPID = share.externalOwnerOf(target.sessionID)
        if (extPID !== undefined) {
          const meta = hub?.followerSession(target.sessionID)
          const snap = meta?.snapshot
          await emit({
            kind: "session_switched",
            sessionID: target.sessionID,
            chatID: ctx.chatID,
            sessionTitle: meta?.title,
            previousSessionID: previous ?? undefined,
            statusText: snap?.statusText || "（属主尚未同步快照，稍后重试 /session <n>）",
            messageCount: snap?.messageCount,
            lastUserText: snap?.lastUserText,
            lastAssistantText: snap?.lastAssistantText,
          })
          return
        }
        const [statusText, msgs] = await Promise.all([
          buildStatusText(target.sessionID),
          fetchMessages(target.sessionID, 20).catch(() => []),
        ])
        const summary = summarize(api.state.session.get(target.sessionID), msgs as never)
        await emit({
          kind: "session_switched",
          sessionID: target.sessionID,
          chatID: ctx.chatID,
          previousSessionID: previous ?? undefined,
          statusText,
          messageCount: summary.messageCount,
          lastUserText: summary.lastUserText,
          lastAssistantText: summary.lastAssistantText,
        })
        return
      }
    }
  }

  // ---- 分享生命周期 ----
  const startSharing = async (): Promise<void> => {
    const route = api.route.current
    if (route.name !== "session") {
      api.ui.toast({ variant: "warning", title: "feishu-share", message: "Open a session first, then run /feishu" })
      return
    }
    const params = route.params as { sessionID?: unknown } | undefined
    const sessionID = params?.sessionID
    if (typeof sessionID !== "string" || !sessionID) {
      api.ui.toast({ variant: "warning", title: "feishu-share", message: "No session in current route" })
      return
    }
    const chatID = config.defaultChatID
    const result = share.share(sessionID, chatID)
    if (!result.ok) {
      api.ui.toast({ variant: "error", title: "feishu-share", message: result.reason })
      return
    }
    if (result.already) {
      api.ui.toast({ variant: "info", title: "feishu-share", message: `Already sharing ${sessionID}` })
      return
    }
    if (!transport) {
      // 角色选举：锁空闲 → leader（直连飞书）；被其他存活实例持有 → follower（本地中继）
      const lock = acquireTransportLock(config, instanceID)
      if (lock.ok) {
        releaseTransportLock = lock.release
        try {
          transport = createTransport(config, (level, msg) => {
            if (level === "error") api.ui.toast({ variant: "error", title: "feishu-share", message: msg })
          })
          await transport.start()
        } catch (err) {
          share.stopOne(sessionID)
          transport = null
          releaseTransportLock()
          releaseTransportLock = null
          api.ui.toast({ variant: "error", title: "feishu-share", message: `transport start failed: ${String(err)}` })
          return
        }
        startLeaderHub()
      } else {
        followerMode = true
        const relay = new RelayTransport(config, instanceID, {
          onPromote: (release) => promoteFollowerToLeader(release),
        })
        try {
          await relay.start()
        } catch (err) {
          followerMode = false
          share.stopOne(sessionID)
          api.ui.toast({ variant: "error", title: "feishu-share", message: `relay start failed: ${String(err)}` })
          return
        }
        transport = relay
        relay.onLeaderExit((reason) => {
          // leader 优雅退出：接管连接（升为 leader）；接管失败则本会话分享失效
          dbg(`leader exit (${reason}) -> promote`)
          promoteFollowerToLeader(() => {})
        })
      }
      wireTransport(transport)
    }
    // 通知飞书：新会话自己的开启卡 + 多会话时的全局提醒卡（不打断当前 active）
    if (followerMode) await publishFollowerMeta()
    await emit({ kind: "share_open", sessionID, chatID, session: await buildSnapshot(sessionID) })
    if (share.count > 1) {
      await emit({
        kind: "multi_session_new",
        sessionID,
        chatID,
        sessions: sessionListEntries(),
        newIndex: share.indexOf(sessionID),
      })
    }
    api.ui.toast({ variant: "success", title: "feishu-share", message: `Sharing ${sessionID} -> ${chatID}` })
  }

  /** 给任意 transport 挂上入站处理（leader 直连与 follower 接管共用） */
  const wireTransport = (t: NonNullable<typeof transport>): void => {
    t.onInbound((cmd, ctx, inboundOpts) => {
      void handleInbound(cmd, ctx, inboundOpts)
    })
    t.onCardAction((value, ctx, messageID) => {
      // follower 的卡片：转发回属主 TUI 处理（按钮 value 只作路由，白名单在 follower 侧）
      const pid = messageID ? hub?.ownerOfMessageID(messageID) : undefined
      if (pid) {
        security.audit({ direction: "in", action: "card_action->relay", ok: true, senderID: ctx.senderID, chatID: ctx.chatID, detail: `pid ${pid}` })
        hub?.forwardCardAction(pid, value, ctx, messageID)
        return
      }
      const cmd = cardActionToCommand(value)
      if (!cmd) return
      // question_custom 的引导卡由传输层同步返回，无需异步处理
      if (cmd.action === "question_custom") return
      const kind = cmd.action === "permission_reply" ? "权限审批" : "问题回答"
      // 问题原文缓存（handleInbound 会清 pendingQuestions，需先取）
      const qInfo =
        cmd.action === "question_reply"
          ? ((pendingQuestions.get(cmd.requestID) as { questions?: Array<{ question?: string; header?: string }> } | undefined)?.questions ?? [])
          : []
      // 卡片按钮作答：定格旧流式卡（回复将开新卡展示，不再重复回答内容）
      if (cmd.action === "question_reply") {
        const entry = pendingQuestions.get(cmd.requestID) as { sessionID?: string } | undefined
        onQuestionResolved("card-action", cmd.requestID, entry?.sessionID)
      }
      void (async () => {
        await handleInbound(cmd, ctx, { silentStatus: true })
        if (messageID && transport && (cmd.action === "permission_reply" || cmd.action === "question_reply")) {
          const detail =
            cmd.action === "permission_reply"
              ? cmd.reply === "once"
                ? "已批准（一次）"
                : cmd.reply === "always"
                  ? "已批准（永久）"
                  : "已拒绝"
              : answerDetail(cmd.answers, qInfo)
          await transport.updateCard(messageID, renderProcessedCard(kind, detail)).catch(() => {})
        }
      })()
    })
  }

  /** 启动 leader 侧中继枢纽：扫描 follower、泵卡片、收编 external 会话 */
  const startLeaderHub = (): void => {
    if (hub || !transport) return
    hub = new LeaderHub(config.stateDir, instanceID, transport, {
      onSessionsAdded: (sessions, ownerID) => {
        for (const s of sessions) {
          share.addExternal(s.sessionID, s.chatID, ownerID, s.pid)
          security.audit({ direction: "in", action: "follower_join", ok: true, detail: `owner ${ownerID} session ${s.sessionID}` })
        }
        // 后接入的会话不抢占 active（需求 3/5）：发全局提醒卡
        const last = sessions[sessions.length - 1]!
        if (share.count > 1) {
          void emit({
            kind: "multi_session_new",
            sessionID: last.sessionID,
            chatID: last.chatID,
            sessions: sessionListEntries(),
            newIndex: share.indexOf(last.sessionID),
          })
        }
        api.ui.toast({ variant: "info", title: "feishu-share", message: `Follower session joined (owner ${ownerID})` })
      },
      onSessionsRemoved: (sessions) => {
        for (const s of sessions) share.removeExternal(s.sessionID)
      },
      dbg,
    })
    hub.start()
  }

  /** follower 接管：锁已到手，换真 transport + 起 hub，收编其余 follower */
  const promoteFollowerToLeader = (release: () => void): void => {
    if (!followerMode) return
    followerMode = false
    releaseTransportLock = release
    void (async () => {
      try {
        const real = createTransport(config, (level, msg) => {
          if (level === "error") api.ui.toast({ variant: "error", title: "feishu-share", message: msg })
        })
        await real.start()
        transport = real
        startLeaderHub()
        wireTransport(real)
        api.ui.toast({ variant: "success", title: "feishu-share", message: "已接管飞书连接（升为 leader）" })
        await publishFollowerMeta().catch(() => {})
      } catch (err) {
        api.ui.toast({ variant: "error", title: "feishu-share", message: `接管飞书连接失败: ${String(err)}` })
      }
    })()
  }

  /**
   * 停止分享。scope=active（默认）只停当前 active 会话；scope=all 全部停止。
   * targetSessionID 可定向停某个本进程会话（跨实例转发用，绕过 active 语义）。
   * 多会话下单个停止不关 transport（WS 常驻），最后一个停止/无会话残留时才收尾关闭。
   */
  const stopSharing = (reason: string, scope: "active" | "all" = "active", targetSessionID?: string): void => {
    const stopped: Array<{ sessionID: string; chatID: string }> = []
    if (scope === "all") {
      // 只停本进程会话；external 会话由调用方负责转发（各 TUI 自停自清）
      for (const t of share.list().filter((x) => !share.externalOwnerOf(x.sessionID))) {
        stopped.push({ sessionID: t.sessionID, chatID: t.chatID })
      }
      share.stopAll()
    } else {
      const cur = targetSessionID ? share.targetOf(targetSessionID) : share.current
      if (targetSessionID && share.externalOwnerOf(targetSessionID) !== undefined) {
        api.ui.toast({ variant: "error", title: "feishu-share", message: "refusing to stop a relayed session owned by another TUI" })
        return
      }
      if (cur) {
        share.stopOne(cur.sessionID)
        stopped.push({ sessionID: cur.sessionID, chatID: cur.chatID })
      }
    }
    for (const t of stopped) cleanupSessionState(t.sessionID)
    // TUI 会话内留一条持久通知（像普通对话消息一样显示、不消失；noReply 不触发 agent 回复）
    if (reason !== "tui exit") {
      const reasonText = reason === "remote stop" ? "远程 /disconnect" : reason === "menu" ? "TUI 菜单停止" : reason
      for (const t of stopped) {
        const text = `⏸️ 飞书分享已断开（${reasonText}），本地任务不受影响`
        recentInjected.set(text, Date.now())
        void api.client.session
          .prompt({ sessionID: t.sessionID, parts: [{ type: "text", text }], noReply: true })
          .catch(() => {})
      }
    }
    const t = transport
    if (share.count === 0 && t) {
      // 最后一个会话停止：逐个发 share_close 后收尾关闭 transport 并释放实例锁
      transport = null
      void (async () => {
        for (const target of stopped) {
          try {
            await t.send({ kind: "share_close", sessionID: target.sessionID, chatID: target.chatID, reason })
          } catch {
            // 关闭路径忽略发送失败
          }
        }
        await t.stop().catch(() => {})
        releaseTransportLock?.()
        releaseTransportLock = null
      })()
    } else if (t && stopped.length > 0) {
      // 仍有剩余会话：只通知被停会话，transport 保持
      void (async () => {
        for (const target of stopped) {
          try {
            await t.send({ kind: "share_close", sessionID: target.sessionID, chatID: target.chatID, reason })
          } catch {
            // 忽略
          }
        }
      })()
    }
    api.ui.toast({ variant: "warning", title: "feishu-share", message: `Sharing stopped (${reason})` })
  }

  // ---- 事件监听（TUI → 飞书 通知） ----
  api.event.on("session.status", (e) => {
    const { sessionID, status } = e.properties
    if (!share.isShared(sessionID)) return
    const chatID = chatIDFor(sessionID)
    dbg(`status ${status.type} session=${sessionID.slice(0, 12)} busy=${busySessions.has(sessionID)} streaming=${streaming.has(sessionID) ? streaming.get(sessionID)!.messageID.slice(0, 12) : "null"} resume=${resumeStates.get(sessionID)?.active ?? false}`)
    if (status.type === "busy") {
      if (busySessions.has(sessionID)) return
      busySessions.add(sessionID)
      closeStreaming(sessionID)
      const rs = resumeStateOf(sessionID)
      rs.active = false
      rs.buffer = []
      rs.opening = false
      pendingParts.set(sessionID, [])
      void (async () => {
        const messageID = await emit({ kind: "task_started", sessionID, chatID })
        if (messageID)
          streaming.set(sessionID, {
            messageID,
            parts: new Map(),
            textPartIDs: new Set(),
            reasoningActive: false,
            questionPending: false,
            tools: new Map(),
            lastFlush: Date.now(),
            timer: null,
          })
        // 卡就绪：回放延迟窗口内的 parts（中继/WS 延迟不丢正文）
        const buffered = pendingParts.get(sessionID) ?? []
        pendingParts.delete(sessionID)
        const st2 = streaming.get(sessionID)
        if (st2) for (const part of buffered) applyPartToStreaming(sessionID, st2, part)
      })()
      return
    }
    if (status.type === "retry") {
      // 模型限流等可重试错误：反馈到飞书（流式卡原地提示，否则发一次性通知）
      const attempt = (status as { attempt?: number }).attempt ?? 0
      const message = String((status as { message?: string }).message ?? "rate limited")
      const st = streaming.get(sessionID)
      if (st && transport) {
        void (async () => {
          if (!transport) return
          const body = `${cardTail(streamingText(sessionID))}\n\n⚠️ ${message}（第 ${attempt} 次重试）`
          try {
            await transport.updateCard(st.messageID, renderStreamingCard("⏳ 模型限流，自动重试中", body, "orange"))
            st.lastFlush = Date.now()
          } catch {
            // 忽略
          }
        })()
        return
      }
      if (busySessions.has(sessionID)) {
        void emit({ kind: "task_retry", sessionID, chatID, attempt, message })
      }
      return
    }
    if (status.type === "idle") {
      if (!busySessions.has(sessionID)) return
      busySessions.delete(sessionID)
      const rs = resumeStateOf(sessionID)
      rs.active = false
      rs.buffer = []
      rs.opening = false
      const st = streaming.get(sessionID)
      if (st) {
        // 流式卡定稿（承担 task_completed 通知，避免重复消息）
        void (async () => {
          await flushStreaming(sessionID, true)
          closeStreaming(sessionID)
          if (followerMode) await publishFollowerMeta().catch(() => {})
          if ((promptQueues.get(sessionID)?.length ?? 0) > 0) await drainPromptQueue(sessionID)
        })()
        return
      }
      void fetchMessages(sessionID, 5)
        .then((msgs) => emit({ kind: "task_completed", sessionID, chatID, summary: lastAssistantText(msgs as never) }))
        .catch(() => emit({ kind: "task_completed", sessionID, chatID }))
        .finally(() => {
          if (followerMode) void publishFollowerMeta().catch(() => {})
          if ((promptQueues.get(sessionID)?.length ?? 0) > 0) void drainPromptQueue(sessionID)
        })
    }
  })

  // 流式刷新：正文文本流式；工具调用进活动时间线（对齐 TUI）；reasoning 只显示"思考中"
  api.event.on("message.part.updated", (e) => {
    const { sessionID, part } = e.properties
    const p = part as {
      id?: string
      messageID?: string
      type?: string
      text?: string
      synthetic?: boolean
      ignored?: boolean
      tool?: string
      state?: { status?: string; title?: string }
    }
    if (!p?.id) return
    dbg(`part type=${p.type} tool=${p.tool ?? "-"} st=${p.state?.status ?? "-"} msg=${p.messageID?.slice(0, 12) ?? "-"} userMsg=${p.messageID ? userMessageIDs.has(p.messageID) : "-"} streaming=${streaming.has(sessionID) ? "y" : "n"} resume=${resumeStates.get(sessionID)?.active ?? false} busy=${busySessions.has(sessionID)}`)
    // 用户消息的文本 part：镜像到飞书（TUI 本地输入同步），不进流式卡正文
    if (p.messageID && userMessageIDs.has(p.messageID)) {
      if (
        p.type === "text" &&
        !p.synthetic &&
        !p.ignored &&
        typeof p.text === "string" &&
        p.text.trim() &&
        !mirroredParts.has(p.id)
      ) {
        mirroredParts.add(p.id)
        if (mirroredParts.size > 200) {
          const first = mirroredParts.values().next().value
          if (first) mirroredParts.delete(first)
        }
        const text = p.text.trim()
        const injectedAt = recentInjected.get(text)
        if (injectedAt && Date.now() - injectedAt < 60_000) {
          recentInjected.delete(text) // 飞书注入的 prompt 回声，跳过
        } else {
          void emit({ kind: "tui_input", sessionID, chatID: chatIDFor(sessionID), text: text.slice(0, 1000) })
        }
      }
      return
    }
    if (!share.isShared(sessionID)) return
    const st = streaming.get(sessionID)
    if (!st) {
      // busy 但流式卡未就绪（task_started 还在路上）：先缓冲，卡就绪后回放
      if (busySessions.has(sessionID) && (p.type === "text" || p.type === "tool" || p.type === "reasoning")) {
        const buf = pendingParts.get(sessionID) ?? []
        buf.push(p)
        pendingParts.set(sessionID, buf)
        return
      }
      // 提问回答后 agent 继续产出：为后续回复开一张新流式卡（旧卡已定格在上方）
      const rs = resumeStateOf(sessionID)
      if (rs.active && busySessions.has(sessionID) && (p.type === "text" || p.type === "tool" || p.type === "reasoning")) {
        rs.buffer.push(p)
        if (!rs.opening) openResumeCard(sessionID)
      }
      return
    }
    // 提问刚被回答：TUI 事件总线不发 question.replied（API 应答不触发），
    // 以 question 工具 part 状态变 completed/error 为准 → 定格旧卡，后续回复开新卡
    if (p.type === "tool" && p.tool === "question" && st.questionPending && (p.state?.status === "completed" || p.state?.status === "error")) {
      st.questionPending = false
      onQuestionResolved("tool-part", p.id ?? "-", sessionID)
      return
    }
    applyPartToStreaming(sessionID, st, p)
  })

  // TUI 用户消息跟踪：为镜像本地输入识别用户消息（仅共享会话）
  api.event.on("message.updated", (e) => {
    const { sessionID, info } = e.properties
    const m = info as { id?: string; role?: string } | undefined
    if (!m?.id || m.role !== "user") return
    if (share.isShared(sessionID)) userMessageIDs.add(m.id)
    else userMessageIDs.delete(m.id)
    if (userMessageIDs.size > 200) {
      const first = userMessageIDs.values().next().value
      if (first) userMessageIDs.delete(first)
    }
  })

  api.event.on("session.error", (e) => {
    const sessionID = e.properties.sessionID
    if (!sessionID || !share.isShared(sessionID)) return
    busySessions.delete(sessionID)
    const err = e.properties.error as { message?: string } | undefined
    const errMsg = String(err?.message ?? "unknown")
    const st = streaming.get(sessionID)
    if (st) {
      // 流式卡原地变红
      void (async () => {
        await flushStreaming(sessionID, true, errMsg)
        closeStreaming(sessionID)
      })()
      return
    }
    void emit({
      kind: "task_failed",
      sessionID,
      chatID: chatIDFor(sessionID),
      error: errMsg,
    })
  })

  /** 权限卡详情：metadata 去掉 title 后的紧凑 JSON（外部目录路径等关键字段通常在 metadata/patterns 里） */
  const permissionDetail = (metadata: unknown): string | undefined => {
    if (!metadata || typeof metadata !== "object") return undefined
    const rest = Object.fromEntries(
      Object.entries(metadata as Record<string, unknown>).filter(
        ([k, v]) => k !== "title" && v !== undefined && v !== null && v !== "",
      ),
    )
    if (Object.keys(rest).length === 0) return undefined
    try {
      return JSON.stringify(rest, null, 2).slice(0, 600)
    } catch {
      return undefined
    }
  }

  api.event.on("permission.asked", (e) => {
    const { id, sessionID, permission, patterns, metadata } = e.properties
    if (!share.isShared(sessionID)) return
    if (!pendingPermissions.has(id)) permissionOrder.push(id)
    pendingPermissions.set(id, e.properties)
    const meta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined
    const title = meta ? String(meta.title ?? "") : undefined
    void emit({
      kind: "permission_requested",
      sessionID,
      chatID: chatIDFor(sessionID),
      requestID: id,
      permission,
      patterns: Array.isArray(patterns) ? patterns.map(String) : undefined,
      detail: permissionDetail(metadata),
      title: title || undefined,
      ordinal: permissionOrder.indexOf(id) + 1,
    })
  })
  api.event.on("permission.replied", (e) => {
    const requestID = e.properties.requestID
    if (!pendingPermissions.has(requestID)) return
    pendingPermissions.delete(requestID)
    const idx = permissionOrder.indexOf(requestID)
    if (idx >= 0) permissionOrder.splice(idx, 1)
  })

  // TUI 本地切换 Agent/模型 → 同步通知飞书（远程切换由指令路径负责通知，5s 窗口内抑制回声）
  api.event.on("session.next.agent.switched", (e) => {
    const { sessionID, agent } = e.properties
    if (!share.isShared(sessionID)) return
    if (Date.now() < remoteSwitchUntil) return
    void emit({
      kind: "status",
      sessionID,
      chatID: chatIDFor(sessionID),
      text: `🔀 已切换 Agent → **${agent}**（对后续对话生效）`,
    })
  })
  api.event.on("session.next.model.switched", (e) => {
    const { sessionID, model } = e.properties
    if (!share.isShared(sessionID)) return
    if (Date.now() < remoteSwitchUntil) return
    void emit({
      kind: "status",
      sessionID,
      chatID: chatIDFor(sessionID),
      text: `🔀 已切换模型 → **${model.providerID}/${model.id}**（对后续对话生效）`,
    })
  })

  api.event.on("question.asked", (e) => {
    const { id, sessionID, questions } = e.properties
    if (!share.isShared(sessionID)) return
    if (!pendingQuestions.has(id)) questionOrder.push(id)
    pendingQuestions.set(id, e.properties)
    void emit({ kind: "question_asked", sessionID, chatID: chatIDFor(sessionID), requestID: id, questions })
  })
  /** 提问已解决（回答/拒绝）：定格旧流式卡，agent 继续产出时开新卡展示回复 */
  const onQuestionResolved = (source: string, requestID: string, sessionID?: string): void => {
    const sid = sessionID ?? (pendingQuestions.get(requestID) as { sessionID?: string } | undefined)?.sessionID
    dbg(`question.${source} id=${requestID} session=${sid?.slice(0, 12) ?? "?"} streaming=${sid && streaming.has(sid) ? streaming.get(sid)!.messageID.slice(0, 12) : "null"} resume -> true`)
    if (!sid) return
    const st = streaming.get(sid)
    const rs = resumeStateOf(sid)
    rs.active = true
    rs.buffer = []
    rs.opening = false
    if (st) {
      st.questionPending = false
      const segments = [streamingTimeline(st), "✅ 已收到你的回答，继续处理中…", cardTail([...st.parts.values()].join("\n").trim())]
      closeStreaming(sid)
      void transport
        ?.updateCard(st.messageID, renderStreamingCard("⏳ 已收到回答，继续处理…", segments.filter(Boolean).join("\n\n"), "blue"))
        .catch(() => {})
      return
    }
  }

  api.event.on("question.replied", (e) => {
    const requestID = e.properties.requestID
    const entry = pendingQuestions.get(requestID) as { sessionID?: string } | undefined
    if (!entry) return
    pendingQuestions.delete(requestID)
    const idx = questionOrder.indexOf(requestID)
    if (idx >= 0) questionOrder.splice(idx, 1)
    onQuestionResolved("replied", requestID, entry.sessionID)
  })
  api.event.on("question.rejected", (e) => {
    const requestID = e.properties.requestID
    const entry = pendingQuestions.get(requestID) as { sessionID?: string } | undefined
    if (!entry) return
    pendingQuestions.delete(requestID)
    const idx = questionOrder.indexOf(requestID)
    if (idx >= 0) questionOrder.splice(idx, 1)
    onQuestionResolved("rejected", requestID, entry.sessionID)
  })

  // ---- /feishu 命令与交互菜单 ----
  const openMenu = (): void => {
    const isSessionRoute = api.route.current.name === "session"
    const current = share.current
    const items = [
      {
        title: "Share current session",
        value: "share",
        description: "Bind the current session to Feishu",
        disabled: !isSessionRoute,
      },
      {
        title: "Stop sharing",
        value: "stop",
        description: share.count > 1 ? "Stop sharing the active session (keeps others)" : "Unbind remote access (keeps local task running)",
      },
      {
        title: "Show share status",
        value: "status",
        description: current ? `shared: ${share.count} session(s), active ${current.sessionID} -> ${current.chatID}` : "unshared",
      },
      {
        title: "PoC: send test prompt",
        value: "test",
        description: "Inject a tiny prompt into the shared session",
        disabled: !current,
      },
    ]
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: "Feishu share",
        options: items,
        skipFilter: true,
        onSelect: (option) => {
          api.ui.dialog.clear()
          void runMenuAction(String(option.value))
        },
      }),
    )
  }

  const runMenuAction = async (action: string): Promise<void> => {
    switch (action) {
      case "share":
        await startSharing()
        return
      case "stop":
        {
          // TUI 菜单停止：仅停本进程会话；active 属于其他 TUI 时提示去对应端操作
          if (share.current === null && share.activeSessionID) {
            api.ui.toast({ variant: "info", title: "feishu-share", message: "当前飞书活动会话属于另一个 TUI；请在飞书端 /disconnect 或到对应 TUI 停止" })
            return
          }
          stopSharing("menu")
        }
        return
      case "status": {
        const s = share.current
        api.ui.toast({
          variant: "info",
          title: "feishu-share",
          message: s ? `shared: ${share.count} session(s), active ${s.sessionID} -> ${s.chatID}` : "unshared",
        })
        if (s) await emit({ kind: "status", sessionID: s.sessionID, chatID: s.chatID, text: await buildStatusText(s.sessionID) })
        return
      }
      case "test": {
        const s = share.current
        if (!s) return
        void api.client.session
          .prompt({ sessionID: s.sessionID, parts: [{ type: "text", text: TEST_PROMPT }] })
          .catch(() => {})
        api.ui.toast({ variant: "success", title: "feishu-share", message: "Test prompt injected into shared session" })
        return
      }
    }
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "feishu.share.menu",
        title: "Feishu share",
        slashName: "feishu",
        category: "Feishu",
        namespace: "palette",
        run() {
          openMenu()
        },
      },
    ],
  })

  // ---- 生命周期清理 ----
  api.lifecycle.onDispose(() => {
    if (share.count > 0) stopSharing("tui exit", "all")
    const t = transport
    transport = null
    // leader 优雅退出：通知 follower 接管（它们抢锁，一个升 leader），再关自己的连接
    if (hub) {
      hub.notifyLeaderExit("tui exit")
      hub.stop()
      hub = null
    }
    const done = t?.stop() ?? Promise.resolve()
    return Promise.resolve(done).finally(() => {
      releaseTransportLock?.()
      releaseTransportLock = null
    })
  })
}

export default { id, tui }
