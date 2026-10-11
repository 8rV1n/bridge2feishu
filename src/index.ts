import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InboundCommand, InboundContext, OutboundEvent, SessionSnapshot } from "./types.js"
import { appendFileSync } from "node:fs"
import { loadConfig, type PluginConfig } from "./config.js"
import { ShareStateManager } from "./share-state.js"
import { Security } from "./security.js"
import { lastAssistantText, summarize, textOfMessage } from "./session.js"
import { MockTransport } from "./transport/mock.js"
import { createTransport } from "./transport/index.js"
import { renderOutbound, renderStreamingCard, renderProcessedCard, HELP_TEXT } from "./renderer.js"
import { cardActionToCommand } from "./router.js"

const TEST_PROMPT = "Reply with exactly: PONG"

export const id = "opencode-feishu-share"

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const config: PluginConfig = loadConfig()
  const share = new ShareStateManager()
  const security = new Security(config)
  let transport: ReturnType<typeof createTransport> | null = null
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
  // 会话忙时的远程 prompt 队列（对齐 TUI 本地排队语义）
  const promptQueue: string[] = []
  // TUI 本地输入镜像：用户消息 ID 集合 / 已镜像 part / 插件注入 prompt 记录（防回声）
  const userMessageIDs = new Set<string>()
  const mirroredParts = new Set<string>()
  const recentInjected = new Map<string, number>()
  // /model 与 /agent 的列表缓存（保证 list 与 switch 编号一致性）
  let modelCache: Array<{ providerID: string; modelID: string; label: string }> = []
  let agentCache: Array<{ name: string; label: string }> = []

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
    const agents = (res.error === undefined ? (res.data ?? []) : []) as Array<{
      name: string
      description?: string
      mode?: string
      hidden?: boolean
    }>
    agentCache = agents
      .filter((a) => !a.hidden && a.mode !== "subagent")
      .map((a) => ({ name: a.name, label: a.description ? `${a.name}（${a.description}）` : a.name }))
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
    // 自动注入会话摘要（卡片标题显示用）
    const withTitle: OutboundEvent =
      event.sessionID && !event.sessionTitle
        ? { ...event, sessionTitle: api.state.session.get(event.sessionID)?.title }
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
  let streaming: Streaming | null = null
  const STREAM_INTERVAL_MS = 1200
  const TIMELINE_MAX = 6
  // 提问回答后的续段流式：旧卡定格，agent 继续产出时开新卡（保证回复在飞书消息底部可见）
  let resumeStreaming = false
  let resumeOpening = false
  let resumeBuffer: Array<{ id?: string; type?: string; text?: string; tool?: string; state?: { status?: string; title?: string } }> = []

  /** 把一个 message part 应用到流式卡（text→正文 / tool→时间线 / reasoning→思考中） */
  const applyPartToStreaming = (
    target: Streaming,
    p: { id?: string; type?: string; text?: string; tool?: string; state?: { status?: string; title?: string } },
  ): void => {
    if (!target || !p?.id) return
    if (p.type === "text") {
      target.textPartIDs.add(p.id)
      target.parts.set(p.id, p.text ?? "")
      target.reasoningActive = false
      scheduleStreamingFlush()
      return
    }
    if (p.type === "tool") {
      if (p.tool === "question") {
        // 提问工具：单独的问答卡负责展示，流式卡只显示等待状态，不进时间线
        // 按工具状态同步等待标志（answered 后不再误显示"等待你的回答"）
        const st = p.state?.status
        target.questionPending = !(st === "completed" || st === "error")
        scheduleStreamingFlush()
        return
      }
      const title = p.state?.title || p.tool || "工具"
      target.questionPending = false
      target.tools.set(p.id, { tool: p.tool ?? "tool", title, status: p.state?.status ?? "pending" })
      scheduleStreamingFlush()
      return
    }
    if (p.type === "reasoning" && target.parts.size === 0) {
      target.reasoningActive = true
      scheduleStreamingFlush()
    }
  }

  /** 回答后开新流式卡：先落卡，再把等卡期间的 parts 按序回放进去 */
  const openResumeCard = (sessionID: string): void => {
    resumeOpening = true
    dbg(`resume-card opening buffer=${resumeBuffer.length}`)
    void (async () => {
      const messageID = await emit({ kind: "task_resumed", sessionID, chatID: share.current?.chatID ?? "mock" })
      if (!messageID) {
        dbg("resume-card open FAILED (no messageID)")
        resumeOpening = false
        return
      }
      dbg(`resume-card opened ${messageID.slice(0, 16)} replay=${resumeBuffer.length}`)
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
      for (const part of resumeBuffer) applyPartToStreaming(s, part)
      resumeBuffer = []
      streaming = s
      resumeStreaming = false
      resumeOpening = false
      void flushStreaming(false)
    })()
  }

  const streamingText = (): string => [...(streaming?.parts.values() ?? [])].join("\n").trim()

  /** OpenCode 风格活动时间线（最近 N 条：✓ 完成 / ⟳ 运行中 / ✗ 失败 / … 等待） */
  const streamingTimeline = (target: Streaming | null = streaming): string => {
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

  const flushStreaming = async (final: boolean, errText?: string): Promise<void> => {
    if (!streaming || !transport) return
    if (streaming.timer) {
      clearTimeout(streaming.timer)
      streaming.timer = null
    }
    streaming.lastFlush = Date.now()
    const text = streamingText()
    const timeline = streamingTimeline()
    const segments: string[] = []
    if (timeline) segments.push(timeline)
    if (streaming.questionPending) segments.push("❓ 等待你的回答…")
    if (promptQueue.length > 0) segments.push(`📥 排队 prompt：${promptQueue.length} 条`)
    if (text) segments.push(final ? text : `${text} ▌`)
    if (segments.length === 0) {
      segments.push(final ? "（无文本输出）" : streaming.reasoningActive ? "🤔 思考中…" : "正在处理…")
    } else if (!final && text && streaming.reasoningActive) {
      segments.push("🤔 思考中…")
    }
    const body = errText ?? segments.join("\n\n")
    const card =
      final && errText
        ? renderStreamingCard("❌ 执行失败", errText, "red")
        : renderStreamingCard(final ? "✅ 任务完成" : "⏳ 正在处理", body, final ? "green" : "blue")
    try {
      await transport.updateCard(streaming.messageID, card)
    } catch {
      // 卡片更新失败不影响本地任务
    }
  }

  const scheduleStreamingFlush = (): void => {
    if (!streaming) return
    const now = Date.now()
    const due = streaming.lastFlush + STREAM_INTERVAL_MS
    if (now >= due) {
      void flushStreaming(false)
      return
    }
    if (!streaming.timer) {
      streaming.timer = setTimeout(() => void flushStreaming(false), due - now)
    }
  }

  const closeStreaming = (): void => {
    if (streaming?.timer) clearTimeout(streaming.timer)
    streaming = null
  }

  const sharedSession = (): string | null => share.current?.sessionID ?? null

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
      promptQueue.length > 0 ? `**排队远程 prompt**：${promptQueue.length}` : null,
    ]
    return lines.filter(Boolean).join("\n")
  }

  /**
   * 读取会话最后一条 assistant 消息携带的模型/agent，
   * 远程 prompt 显式沿用（与 TUI 本地提交行为一致，避免 server 默认模型配置失效导致 401）。
   */
  const resolveSessionModel = async (
    sessionID: string,
  ): Promise<{ model?: { providerID: string; modelID: string }; agent?: string }> => {
    try {
      const msgs = await fetchMessages(sessionID, 10)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info as
          | { role?: string; modelID?: string; providerID?: string; agent?: string }
          | undefined
        if (info?.role !== "assistant") continue
        if (!info.modelID || !info.providerID) continue
        return {
          model: { providerID: info.providerID, modelID: info.modelID },
          ...(typeof info.agent === "string" && info.agent ? { agent: info.agent } : {}),
        }
      }
    } catch {
      // 读取失败则不带 model（回落 server 默认）
    }
    return {}
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
    const chatID = share.current?.chatID ?? ""
    while (promptQueue.length > 0) {
      const text = promptQueue[0]!
      try {
        await submitPrompt(sessionID, text)
      } catch (err) {
        if (/busy/i.test(String(err))) return // 又忙了，等下一个 idle
        promptQueue.shift()
        await emit({ kind: "task_failed", sessionID, chatID, error: `queued prompt: ${String(err)}` })
        continue
      }
      promptQueue.shift()
      return // 已启动一个回合，等它完成后的下一个 idle 继续
    }
  }

  // ---- 入站命令处理（飞书 → TUI） ----
  const sendRejected = async (chatID: string, reason: string): Promise<void> => {
    await emit({ kind: "status", sessionID: sharedSession() ?? "", chatID, text: `rejected: ${reason}` })
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
    opts?: { silentStatus?: boolean },
  ): Promise<void> => {
    const guard = security.checkInbound(ctx)
    if (!guard.ok) {
      security.audit({ direction: "in", action: cmd.action, ok: false, senderID: ctx.senderID, chatID: ctx.chatID, detail: guard.reason })
      await sendRejected(ctx.chatID, guard.reason)
      return
    }
    const sessionID = sharedSession()
    if (cmd.action !== "stop") {
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
    }
    security.audit({ direction: "in", action: cmd.action, ok: true, senderID: ctx.senderID, chatID: ctx.chatID })
    const sid = sessionID ?? ""

    switch (cmd.action) {
      case "prompt": {
        const text = (cmd.text ?? "").trim()
        if (!text) return
        const st = api.state.session.status(sid)?.type
        if (st === "busy" || st === "retry") {
          // 会话忙：进入插件自管队列（流式卡显示 📥 队列行），idle 后自动执行
          promptQueue.push(text)
          if (streaming) void flushStreaming(false)
          else
            await emit({
              kind: "status",
              sessionID: sid,
              chatID: ctx.chatID,
              text: `已加入队列（第 ${promptQueue.length} 条），当前任务结束后自动执行`,
            })
          return
        }
        try {
          // 空闲直接提交；不发送确认卡 —— 紧随其后的流式任务卡即是反馈
          await submitPrompt(sid, text)
        } catch (err) {
          const msg = String(err)
          if (/busy/i.test(msg)) {
            promptQueue.push(text)
            if (streaming) scheduleStreamingFlush()
            else
              await emit({
                kind: "status",
                sessionID: sid,
                chatID: ctx.chatID,
                text: `会话转为忙碌，已加入队列（第 ${promptQueue.length} 条）`,
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
        stopSharing("remote stop")
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
    try {
      transport = createTransport(config, (level, msg) => {
        if (level === "error") api.ui.toast({ variant: "error", title: "feishu-share", message: msg })
      })
      await transport.start()
    } catch (err) {
      share.stop()
      transport = null
      api.ui.toast({ variant: "error", title: "feishu-share", message: `transport start failed: ${String(err)}` })
      return
    }
    transport.onInbound((cmd, ctx) => {
      void handleInbound(cmd, ctx)
    })
    // 卡片按钮点击：走与文本指令相同的安全/路由路径，处理后把原卡片置为已处理状态
    transport.onCardAction((value, ctx, messageID) => {
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
        onQuestionResolved("card-action", cmd.requestID)
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
    await emit({ kind: "share_open", sessionID, chatID, session: await buildSnapshot(sessionID) })
    api.ui.toast({ variant: "success", title: "feishu-share", message: `Sharing ${sessionID} -> ${chatID}` })
  }

  const stopSharing = (reason: string): void => {
    const was = share.current
    share.stop()
    busySessions = new Set()
    pendingPermissions.clear()
    pendingQuestions.clear()
    permissionOrder.length = 0
    questionOrder.length = 0
    promptQueue.length = 0
    closeStreaming()
    const t = transport
    transport = null
    if (t) {
      void t
        .send({ kind: "share_close", sessionID: was?.sessionID ?? "", chatID: was?.chatID ?? "", reason })
        .then(() => t.stop())
        .catch(() => {})
    }
    api.ui.toast({ variant: "info", title: "feishu-share", message: `Sharing stopped (${reason})` })
  }

  // ---- 事件监听（TUI → 飞书 通知） ----
  api.event.on("session.status", (e) => {
    const { sessionID, status } = e.properties
    if (!share.isShared(sessionID)) return
    const chatID = share.current?.chatID ?? "mock"
    dbg(`status ${status.type} session=${sessionID.slice(0, 12)} busy=${busySessions.has(sessionID)} streaming=${streaming ? streaming.messageID.slice(0, 12) : "null"} resume=${resumeStreaming}`)
    if (status.type === "busy") {
      if (busySessions.has(sessionID)) return
      busySessions.add(sessionID)
      closeStreaming()
      resumeStreaming = false
      resumeBuffer = []
      resumeOpening = false
      void (async () => {
        const messageID = await emit({ kind: "task_started", sessionID, chatID })
        if (messageID)
          streaming = {
            messageID,
            parts: new Map(),
            textPartIDs: new Set(),
            reasoningActive: false,
            questionPending: false,
            tools: new Map(),
            lastFlush: Date.now(),
            timer: null,
          }
      })()
      return
    }
    if (status.type === "retry") {
      // 模型限流等可重试错误：反馈到飞书（流式卡原地提示，否则发一次性通知）
      const attempt = (status as { attempt?: number }).attempt ?? 0
      const message = String((status as { message?: string }).message ?? "rate limited")
      if (streaming && transport) {
        void (async () => {
          if (!streaming || !transport) return
          const body = `${streamingText()}\n\n⚠️ ${message}（第 ${attempt} 次重试）`
          try {
            await transport.updateCard(streaming.messageID, renderStreamingCard("⏳ 模型限流，自动重试中", body, "orange"))
            streaming.lastFlush = Date.now()
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
      resumeStreaming = false
      resumeBuffer = []
      resumeOpening = false
      if (streaming) {
        // 流式卡定稿（承担 task_completed 通知，避免重复消息）
        void (async () => {
          await flushStreaming(true)
          closeStreaming()
          if (promptQueue.length > 0) await drainPromptQueue(sessionID)
        })()
        return
      }
      void fetchMessages(sessionID, 5)
        .then((msgs) => emit({ kind: "task_completed", sessionID, chatID, summary: lastAssistantText(msgs as never) }))
        .catch(() => emit({ kind: "task_completed", sessionID, chatID }))
        .finally(() => {
          if (promptQueue.length > 0) void drainPromptQueue(sessionID)
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
    dbg(`part type=${p.type} tool=${p.tool ?? "-"} st=${p.state?.status ?? "-"} msg=${p.messageID?.slice(0, 12) ?? "-"} userMsg=${p.messageID ? userMessageIDs.has(p.messageID) : "-"} streaming=${streaming ? "y" : "n"} resume=${resumeStreaming} busy=${busySessions.has(sessionID)}`)
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
          void emit({ kind: "tui_input", sessionID, chatID: share.current?.chatID ?? "mock", text: text.slice(0, 1000) })
        }
      }
      return
    }
    if (!share.isShared(sessionID)) return
    if (!streaming) {
      // 提问回答后 agent 继续产出：为后续回复开一张新流式卡（旧卡已定格在上方）
      if (resumeStreaming && busySessions.has(sessionID) && (p.type === "text" || p.type === "tool" || p.type === "reasoning")) {
        resumeBuffer.push(p)
        if (!resumeOpening) openResumeCard(sessionID)
      }
      return
    }
    // 提问刚被回答：TUI 事件总线不发 question.replied（API 应答不触发），
    // 以 question 工具 part 状态变 completed/error 为准 → 定格旧卡，后续回复开新卡
    if (p.type === "tool" && p.tool === "question" && streaming.questionPending && (p.state?.status === "completed" || p.state?.status === "error")) {
      streaming.questionPending = false
      onQuestionResolved("tool-part", p.id ?? "-")
      return
    }
    applyPartToStreaming(streaming, p)
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
    if (streaming) {
      // 流式卡原地变红
      void (async () => {
        await flushStreaming(true, errMsg)
        closeStreaming()
      })()
      return
    }
    void emit({
      kind: "task_failed",
      sessionID,
      chatID: share.current?.chatID ?? "mock",
      error: errMsg,
    })
  })

  api.event.on("permission.asked", (e) => {
    const { id, sessionID, permission, metadata } = e.properties
    if (!share.isShared(sessionID)) return
    if (!pendingPermissions.has(id)) permissionOrder.push(id)
    pendingPermissions.set(id, e.properties)
    const title = metadata && typeof metadata === "object" ? String((metadata as Record<string, unknown>).title ?? "") : undefined
    void emit({
      kind: "permission_requested",
      sessionID,
      chatID: share.current?.chatID ?? "",
      requestID: id,
      permission,
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

  api.event.on("question.asked", (e) => {
    const { id, sessionID, questions } = e.properties
    if (!share.isShared(sessionID)) return
    if (!pendingQuestions.has(id)) questionOrder.push(id)
    pendingQuestions.set(id, e.properties)
    void emit({ kind: "question_asked", sessionID, chatID: share.current?.chatID ?? "", requestID: id, questions })
  })
  /** 提问已解决（回答/拒绝）：定格旧流式卡，agent 继续产出时开新卡展示回复 */
  const onQuestionResolved = (source: string, requestID: string): void => {
    dbg(`question.${source} id=${requestID} streaming=${streaming ? streaming.messageID.slice(0, 12) : "null"} resume -> true`)
    if (streaming) {
      streaming.questionPending = false
      const prev = streaming
      const segments = [streamingTimeline(prev), "✅ 已收到你的回答，继续处理中…", [...prev.parts.values()].join("\n").trim()]
      closeStreaming()
      resumeStreaming = true
      resumeBuffer = []
      resumeOpening = false
      void transport
        ?.updateCard(prev.messageID, renderStreamingCard("⏳ 已收到回答，继续处理…", segments.filter(Boolean).join("\n\n"), "blue"))
        .catch(() => {})
      return
    }
    resumeStreaming = true
    resumeBuffer = []
    resumeOpening = false
  }

  api.event.on("question.replied", (e) => {
    const requestID = e.properties.requestID
    if (!pendingQuestions.has(requestID)) return
    pendingQuestions.delete(requestID)
    const idx = questionOrder.indexOf(requestID)
    if (idx >= 0) questionOrder.splice(idx, 1)
    onQuestionResolved("replied", requestID)
  })
  api.event.on("question.rejected", (e) => {
    const requestID = e.properties.requestID
    if (!pendingQuestions.has(requestID)) return
    pendingQuestions.delete(requestID)
    const idx = questionOrder.indexOf(requestID)
    if (idx >= 0) questionOrder.splice(idx, 1)
    onQuestionResolved("rejected", requestID)
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
        description: "Unbind remote access (keeps local task running)",
      },
      {
        title: "Show share status",
        value: "status",
        description: current ? `shared: ${current.sessionID} -> ${current.chatID}` : "unshared",
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
        stopSharing("menu")
        return
      case "status": {
        const s = share.current
        api.ui.toast({
          variant: "info",
          title: "feishu-share",
          message: s ? `shared: ${s.sessionID} -> ${s.chatID}` : "unshared",
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
    if (share.current) stopSharing("tui exit")
    const t = transport
    transport = null
    return t?.stop() ?? Promise.resolve()
  })
}

export default { id, tui }
