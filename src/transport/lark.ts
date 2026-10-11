import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { FeishuTransport, InboundCommand, InboundContext, OutboundEvent } from "../types.js"
import { parseFeishuCommand, cardActionToCommand } from "../router.js"
import { renderCards, renderStreamingCard, type FeishuCard } from "../renderer.js"

/**
 * 飞书官方 SDK 传输层（LarkChannel：WebSocket 长连接，无公网端口）。
 * - 出站：channel.send → 交互卡片（msg_type interactive）
 * - 入站消息：message 事件 → parseFeishuCommand → onInbound 回调
 * - 入站按钮：cardAction 事件（裸 WSClient 不分发 card 帧，LarkChannel 支持）→ onCardAction
 * - 防重放：传输层自带 dedup + 本地 ReplayGuard 双保险
 * - 重连：SDK 内建 reconnect + liveness watchdog
 */
export type LarkTransportOptions = {
  appId: string
  appSecret: string
  domain?: string
  /** 通知发送的目标飞书会话（群 chat_id 或 open_id） */
  chatID: string
  receiveIDType?: "chat_id" | "open_id"
  logger?: (level: "info" | "error", msg: string) => void
  /** 调试：把 SDK 的 WS 帧/dispatcher 日志写入 <stateDir>/lark-sdk.log（FEISHU_SHARE_DEBUG=1 时开启） */
  debug?: { logFile: string }
}

type InboundHandler = (cmd: InboundCommand, ctx: InboundContext) => void
type CardActionHandler = (value: unknown, ctx: InboundContext, messageID?: string) => void

/** SDK Logger 接口的文件实现（用于 FEISHU_SHARE_DEBUG 诊断） */
export function createFileLogger(logFile: string): Record<string, (...args: unknown[]) => void> {
  const write = (level: string) => (...args: unknown[]) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      const msg = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a)))
        .join(" ")
        .slice(0, 800)
      appendFileSync(logFile, `${new Date().toISOString()} ${level} ${msg}\n`)
    } catch {
      // 日志失败不影响主流程
    }
  }
  return {
    trace: write("TRACE"),
    debug: write("DEBUG"),
    info: write("INFO"),
    warn: write("WARN"),
    error: write("ERROR"),
  }
}

/** LRU 去重集合（防飞书事件重推导致的重复执行） */
export class ReplayGuard {
  private seen = new Set<string>()
  private order: string[] = []
  constructor(private cap = 1024) {}

  /** 返回 true 表示首次出现（允许处理） */
  first(id: string | undefined): boolean {
    if (!id) return true
    if (this.seen.has(id)) return false
    this.seen.add(id)
    this.order.push(id)
    if (this.order.length > this.cap) {
      const evict = this.order.shift()
      if (evict) this.seen.delete(evict)
    }
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

type LarkModules = {
  createLarkChannel: (opts: Record<string, unknown>) => LarkChannelLike
  Domain: Record<string, string>
  /** SDK 日志级别是数字枚举（debug=4），传字符串会导致所有日志被静默过滤 */
  LoggerLevel: Record<string, number>
}

type LarkChannelLike = {
  connect(): Promise<void>
  disconnect(): Promise<void>
  on(handlers: Partial<{
    message: (msg: NormalizedMessageLike) => void | Promise<void>
    cardAction: (evt: CardActionEventLike) => void | Promise<void>
    error: (err: Error) => void
  }>): () => void
  send(to: string, input: { card: unknown } | { markdown: string } | { text: string }, opts?: unknown): Promise<{ messageId: string }>
  updateCard(messageId: string, card: object): Promise<void>
}

type NormalizedMessageLike = {
  messageId: string
  chatId: string
  senderId: string
  content: string
  mentions: Array<{ key: string; openId?: string; name?: string }>
  rawContentType: string
}

type CardActionEventLike = {
  messageId: string
  chatId: string
  operator: { openId: string }
  action: { value?: unknown }
}

export class LarkTransport implements FeishuTransport {
  private mod: LarkModules | null = null
  private channel: LarkChannelLike | null = null
  private handler: InboundHandler | null = null
  private cardActionHandler: CardActionHandler | null = null
  private guard = new ReplayGuard()
  private log: (level: "info" | "error", msg: string) => void

  constructor(private opts: LarkTransportOptions) {
    this.log = opts.logger ?? (() => {})
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler
  }

  onCardAction(handler: CardActionHandler): void {
    this.cardActionHandler = handler
  }

  async start(): Promise<void> {
    if (this.channel) return
    const mod = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkModules
    this.mod = mod

    const domain = this.opts.domain ?? mod.Domain?.Feishu ?? "https://open.feishu.cn"
    const sdkLogger = this.opts.debug ? createFileLogger(this.opts.debug.logFile) : undefined
    const level = mod.LoggerLevel?.debug ?? 4
    const channel = mod.createLarkChannel({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      transport: "websocket",
      domain,
      logger: sdkLogger,
      loggerLevel: this.opts.debug ? level : (mod.LoggerLevel?.warn ?? 2),
      source: "opencode-feishu-share",
      policy: { dmMode: "open" },
    })

    channel.on({
      message: async (msg) => {
        try {
          // 防重放：同一消息只处理一次
          if (!this.guard.first(msg.messageId)) return
          if (msg.rawContentType !== "text") return

          const cmd = parseFeishuCommand(
            msg.content,
            msg.mentions.map((m) => ({ key: m.key, id: { open_id: m.openId } })),
          )
          if (!cmd) return

          const ctx: InboundContext = {
            senderID: msg.senderId,
            chatID: msg.chatId,
            messageID: msg.messageId,
          }
          this.log("info", `inbound: ${cmd.action} from ${ctx.senderID}`)
          this.handler?.(cmd, ctx)
        } catch (err) {
          this.log("error", `inbound handler error: ${String(err)}`)
        }
      },
      cardAction: async (evt) => {
        try {
          if (!this.guard.first(`${evt.messageId}:${evt.operator.openId}:${JSON.stringify(evt.action?.value ?? {})}`)) return
          const cmd = cardActionToCommand(evt.action?.value)
          if (!cmd) return
          const ctx: InboundContext = {
            senderID: evt.operator.openId,
            chatID: evt.chatId,
            messageID: evt.messageId,
          }
          this.log("info", `card action: ${cmd.action} from ${ctx.senderID}`)
          this.cardActionHandler?.(evt.action?.value, ctx, evt.messageId)
        } catch (err) {
          this.log("error", `card action handler error: ${String(err)}`)
        }
      },
      error: (err) => {
        this.log("error", `lark channel error: ${String(err)}`)
      },
    })

    this.channel = channel

    // ---- 同步响应卡片回调（飞书要求 3s 内应答，否则显示 callback timeout） ----
    // SDK 的 cardAction 处理走异步队列、不向飞书返回响应；这里替换 dispatcher 上的
    // card.action.trigger 处理器：立即同步返回"处理中"卡片，业务逻辑异步执行。
    type DispatcherLike = { handles?: Map<string, (data: unknown) => Promise<unknown>> }
    const dispatcher = (channel as unknown as { dispatcher?: DispatcherLike }).dispatcher
    if (dispatcher?.handles?.has("card.action.trigger")) {
      dispatcher.handles.set("card.action.trigger", async (raw: unknown) => {
        try {
          const e = raw as {
            operator?: { open_id?: string; openId?: string }
            action?: { value?: unknown }
            context?: { open_message_id?: string; open_chat_id?: string }
            open_message_id?: string
            open_chat_id?: string
          }
          const value = e.action?.value
          const cmd = cardActionToCommand(value)
          if (!cmd) return {}
          const ctx: InboundContext = {
            senderID: e.operator?.open_id ?? e.operator?.openId ?? "unknown",
            chatID: e.context?.open_chat_id ?? e.open_chat_id ?? "unknown",
            messageID: e.context?.open_message_id ?? e.open_message_id,
          }
          this.log("info", `card action: ${cmd.action} from ${ctx.senderID}`)
          // 同步应答：立即返回"处理中/引导"卡片（飞书原地替换，无 timeout）
          let respCard: FeishuCard
          if (cmd.action === "question_custom") {
            respCard = renderStreamingCard("✍️ 自定义回答", "请直接回复: /answer <你的答案>（将作为本次提问的回答）", "grey")
          } else {
            respCard = renderStreamingCard(cmd.action === "permission_reply" ? "⏳ 正在处理审批…" : "⏳ 正在提交回答…", "操作已收到，正在执行…", "grey")
          }
          // 异步执行业务（回复/置灰由 onCardAction 回调完成）
          queueMicrotask(() => this.cardActionHandler?.(value, ctx, ctx.messageID))
          return respCard
        } catch (err) {
          this.log("error", `card action sync handler error: ${String(err)}`)
          return {}
        }
      })
    }

    await channel.connect()
    this.log("info", "lark ws connected")
  }

  async stop(): Promise<void> {
    if (this.channel) {
      try {
        await this.channel.disconnect()
      } catch (err) {
        this.log("error", `ws close error: ${String(err)}`)
      }
      this.channel = null
    }
  }

  async send(event: OutboundEvent): Promise<string | undefined> {
    if (!this.channel) throw new Error("lark transport not started")
    const cards: FeishuCard[] = renderCards(event)
    let lastMessageID: string | undefined
    for (const card of cards) {
      const result = await this.channel.send(this.opts.chatID, { card })
      lastMessageID = result.messageId
    }
    return lastMessageID
  }

  async updateCard(messageID: string, card: object): Promise<void> {
    if (!this.channel) throw new Error("lark transport not started")
    await this.channel.updateCard(messageID, card)
  }
}
