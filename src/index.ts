import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InboundCommand, InboundContext, OutboundEvent, SessionSnapshot } from "./types.js"
import { loadConfig, type PluginConfig } from "./config.js"
import { ShareStateManager } from "./share-state.js"
import { Security } from "./security.js"
import { lastAssistantText, summarize, textOfMessage } from "./session.js"
import { MockTransport } from "./transport/mock.js"
import { createTransport } from "./transport/index.js"
import { renderOutbound, HELP_TEXT } from "./renderer.js"

const TEST_PROMPT = "Reply with exactly: PONG"

export const id = "opencode-feishu-share"

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const config: PluginConfig = loadConfig()
  const share = new ShareStateManager()
  const security = new Security(config)
  let transport: ReturnType<typeof createTransport> | null = null

  // ---- 出站通知（busy 去重 + idle 完成后拉取结果；后续阶段做合并/节流） ----
  let busySessions = new Set<string>()
  const pendingPermissions = new Map<string, unknown>()
  const pendingQuestions = new Map<string, unknown>()
  const permissionOrder: string[] = []
  const questionOrder: string[] = []

  /** 将 "#latest"/"#n" 选择器解析为真实 requestID */
  const resolveSelector = (selector: string, order: string[]): string | null => {
    if (!selector.startsWith("#")) return pendingPermissions.has(selector) || pendingQuestions.has(selector) ? selector : null
    if (selector === "#latest") return order[order.length - 1] ?? null
    const n = Number(selector.slice(1))
    if (!Number.isInteger(n) || n < 1) return null
    return order[n - 1] ?? null
  }

  const emit = async (event: OutboundEvent): Promise<void> => {
    if (!transport) return
    try {
      await transport.send(event)
    } catch (err) {
      api.ui.toast({ variant: "error", title: "feishu-share", message: `send failed: ${String(err)}` })
    }
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
    const snap = await buildSnapshot(sessionID)
    return [
      `session: ${snap.title ?? snap.id}`,
      `status: ${snap.status}`,
      `messages: ${snap.messageCount}`,
      snap.lastAssistantText ? `last: ${snap.lastAssistantText.slice(0, 200)}` : "last: (empty)",
    ].join("\n")
  }

  // ---- 入站命令处理（飞书 → TUI） ----
  const sendRejected = async (chatID: string, reason: string): Promise<void> => {
    await emit({ kind: "status", sessionID: sharedSession() ?? "", chatID, text: `rejected: ${reason}` })
  }

  const handleInbound = async (cmd: InboundCommand, ctx: InboundContext): Promise<void> => {
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
        // 使用 v2 durable prompt：busy 时按 delivery 语义 steer/queue，不会 SessionBusyError
        void api.client.v2.session
          .prompt({ sessionID: sid, prompt: { text }, delivery: cmd.delivery ?? "queue" })
          .then((res) => {
            if (res.error !== undefined) {
              return emit({ kind: "task_failed", sessionID: sid, chatID: ctx.chatID, error: `prompt: ${JSON.stringify(res.error)}` })
            }
            return emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: `prompt accepted (${cmd.delivery ?? "queue"})` })
          })
          .catch((err) => {
            void emit({ kind: "task_failed", sessionID: sid, chatID: ctx.chatID, error: `prompt: ${String(err)}` })
          })
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
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: res.error !== undefined ? `permission reply failed: ${JSON.stringify(res.error)}` : `permission ${requestID} -> ${cmd.reply}`,
        })
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
        await emit({
          kind: "status",
          sessionID: sid,
          chatID: ctx.chatID,
          text: res.error !== undefined ? `question reply failed: ${JSON.stringify(res.error)}` : `question ${requestID} answered`,
        })
        return
      }
      case "help": {
        await emit({ kind: "status", sessionID: sid, chatID: ctx.chatID, text: HELP_TEXT })
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
    if (status.type === "busy") {
      if (busySessions.has(sessionID)) return
      busySessions.add(sessionID)
      void emit({ kind: "task_started", sessionID, chatID })
      return
    }
    if (status.type === "idle") {
      if (!busySessions.has(sessionID)) return
      busySessions.delete(sessionID)
      void fetchMessages(sessionID, 5)
        .then((msgs) => emit({ kind: "task_completed", sessionID, chatID, summary: lastAssistantText(msgs as never) }))
        .catch(() => emit({ kind: "task_completed", sessionID, chatID }))
    }
  })

  api.event.on("session.error", (e) => {
    const sessionID = e.properties.sessionID
    if (!sessionID || !share.isShared(sessionID)) return
    busySessions.delete(sessionID)
    const err = e.properties.error as { message?: string } | undefined
    void emit({
      kind: "task_failed",
      sessionID,
      chatID: share.current?.chatID ?? "mock",
      error: String(err?.message ?? "unknown"),
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
  api.event.on("question.replied", (e) => {
    const requestID = e.properties.requestID
    if (!pendingQuestions.has(requestID)) return
    pendingQuestions.delete(requestID)
    const idx = questionOrder.indexOf(requestID)
    if (idx >= 0) questionOrder.splice(idx, 1)
  })
  api.event.on("question.rejected", (e) => {
    const requestID = e.properties.requestID
    if (!pendingQuestions.has(requestID)) return
    pendingQuestions.delete(requestID)
    const idx = questionOrder.indexOf(requestID)
    if (idx >= 0) questionOrder.splice(idx, 1)
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
