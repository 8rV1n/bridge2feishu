import type { FeishuTransport, InboundCommand, InboundContext, OutboundEvent } from "../types.js"
import { parseFeishuCommand } from "../router.js"
import { renderOutbound, HELP_TEXT } from "../renderer.js"

/**
 * 飞书官方 SDK 传输层（WebSocket 长连接，无公网端口）。
 * - 出站：im.v1.message.create → chat_id（文本消息）
 * - 入站：im.message.receive_v1 事件 → parseFeishuCommand → onInbound 回调
 * - 防重放：event_id / message_id LRU 去重（飞书可能重推同一事件）
 * - 重连：SDK 内建 reconnect + liveness watchdog
 */
export type LarkTransportOptions = {
  appId: string
  appSecret: string
  domain?: string
  /** 通知发送的目标飞书会话（群 chat_id 或 open_id + receive_id_type） */
  chatID: string
  receiveIDType?: "chat_id" | "open_id"
  logger?: (level: "info" | "error", msg: string) => void
}

type InboundHandler = (cmd: InboundCommand, ctx: InboundContext) => void

type LarkModules = {
  Client: new (params: { appId: string; appSecret: string; domain?: string }) => {
    im: { v1: { message: { create: (payload: unknown, options?: unknown) => Promise<{ code?: number; msg?: string }> } } }
  }
  EventDispatcher: new (params: Record<string, unknown>) => {
    register: (handles: Record<string, unknown>) => { unregister: (...keys: string[]) => void }
  }
  WSClient: new (params: Record<string, unknown>) => {
    start: (params: { eventDispatcher: unknown }) => Promise<void>
    close: (params?: { force?: boolean }) => void
    getConnectionStatus: () => { state?: string }
  }
  Domain: Record<string, string>
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

export class LarkTransport implements FeishuTransport {
  private mod: LarkModules | null = null
  private ws: { close: (params?: { force?: boolean }) => void } | null = null
  private imClient: { im: { v1: { message: { create: (payload: unknown, options?: unknown) => Promise<{ code?: number; msg?: string }> } } } } | null = null
  private handler: InboundHandler | null = null
  private guard = new ReplayGuard()
  private log: (level: "info" | "error", msg: string) => void

  constructor(private opts: LarkTransportOptions) {
    this.log = opts.logger ?? (() => {})
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    if (this.ws) return
    const mod = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkModules
    this.mod = mod

    const domain = this.opts.domain ?? mod.Domain?.Feishu ?? "https://open.feishu.cn"
    this.imClient = new mod.Client({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain,
    })
    const dispatcher = new mod.EventDispatcher({})

    dispatcher.register({
      "im.message.receive_v1": async (data: {
        event_id?: string
        message: {
          message_id: string
          chat_id: string
          message_type: string
          content: string
          mentions?: Array<{ key: string; id: { open_id?: string } }>
        }
        sender: { sender_id?: { open_id?: string }; sender_type?: string }
      }) => {
        try {
          // 防重放：同一 event/message 只处理一次
          if (!this.guard.first(data.event_id ?? data.message.message_id)) return
          if (data.message.message_type !== "text") return
          if (data.sender.sender_type && data.sender.sender_type !== "user") return

          let text = ""
          try {
            const parsed = JSON.parse(data.message.content) as { text?: string }
            text = parsed.text ?? ""
          } catch {
            return
          }
          const cmd = parseFeishuCommand(text, data.message.mentions)
          if (!cmd) return

          const ctx: InboundContext = {
            senderID: data.sender.sender_id?.open_id ?? "unknown",
            chatID: data.message.chat_id,
            messageID: data.message.message_id,
          }
          this.log("info", `inbound: ${cmd.action} from ${ctx.senderID}`)
          this.handler?.(cmd, ctx)
        } catch (err) {
          this.log("error", `inbound handler error: ${String(err)}`)
        }
      },
    })

    const ws = new mod.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain,
      loggerLevel: "warn",
    })
    this.ws = ws
    await ws.start({ eventDispatcher: dispatcher })
    this.log("info", "lark ws connected")
  }

  async stop(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close({ force: true })
      } catch (err) {
        this.log("error", `ws close error: ${String(err)}`)
      }
      this.ws = null
    }
  }

  async send(event: OutboundEvent): Promise<void> {
    if (!this.mod || !this.imClient) throw new Error("lark transport not started")
    const text = event.kind === "status" && event.text === "__help__" ? HELP_TEXT : renderOutbound(event)
    const res = await this.imClient.im.v1.message.create({
      params: { receive_id_type: this.opts.receiveIDType ?? "chat_id" },
      data: {
        receive_id: this.opts.chatID,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    })
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(`feishu send failed: ${res.code} ${res.msg}`)
    }
  }
}
