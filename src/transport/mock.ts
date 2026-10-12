import { appendFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs"
import type { InboundCommand, InboundContext, OutboundEvent } from "../types.js"

/**
 * Mock 传输层（PoC）：
 * - 出站：追加 JSONL 到 <stateDir>/outbox.jsonl
 * - 入站：轮询 <stateDir>/inbox.jsonl 的新增行，每行一个 {senderID, chatID, messageID, command}
 * 用于无真实飞书凭证下的双向自动化测试。
 */
export type MockTransportOptions = {
  stateDir: string
  pollIntervalMs?: number
}

type InboundHandler = (cmd: InboundCommand, ctx: InboundContext) => void

export class MockTransport {
  private outboxPath: string
  private inboxPath: string
  private offset = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private handler: InboundHandler | null = null
  private cardActionHandler: ((value: unknown, ctx: InboundContext, messageID?: string) => void) | null = null
  private stopped = true
  private nextID = 1

  constructor(private opts: MockTransportOptions) {
    this.outboxPath = `${opts.stateDir}/outbox.jsonl`
    this.inboxPath = `${opts.stateDir}/inbox.jsonl`
  }

  async start(): Promise<void> {
    mkdirSync(this.opts.stateDir, { recursive: true })
    // 标记新连接起点：入站只处理 start 之后追加的行，避免旧积压误执行
    this.offset = this.inboxSize()
    this.stopped = false
    this.timer = setInterval(() => this.poll(), this.opts.pollIntervalMs ?? 400)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async send(event: OutboundEvent): Promise<string | undefined> {
    const messageID = `mock_msg_${this.nextID++}`
    appendFileSync(this.outboxPath, JSON.stringify({ ts: Date.now(), messageID, ...event }) + "\n")
    return messageID
  }

  async sendCard(card: unknown): Promise<string | undefined> {
    const messageID = `mock_msg_${this.nextID++}`
    appendFileSync(this.outboxPath, JSON.stringify({ ts: Date.now(), messageID, kind: "card_send", card }) + "\n")
    return messageID
  }

  async updateCard(messageID: string, card: unknown): Promise<void> {
    appendFileSync(this.outboxPath, JSON.stringify({ ts: Date.now(), kind: "card_update", messageID, card }) + "\n")
  }

  onInbound(handler: InboundHandler): void {
    this.handler = handler
  }

  onCardAction(handler: (value: unknown, ctx: InboundContext, messageID?: string) => void): void {
    this.cardActionHandler = handler
  }

  private inboxSize(): number {
    try {
      return statSync(this.inboxPath).size
    } catch {
      return 0
    }
  }

  private poll(): void {
    if (this.stopped || !this.handler) return
    let text: string
    try {
      const stat = statSync(this.inboxPath)
      if (stat.size <= this.offset) return
      const fd = openSync(this.inboxPath, "r")
      const len = stat.size - this.offset
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, this.offset)
      closeSync(fd)
      this.offset = stat.size
      text = buf.toString("utf8")
    } catch {
      return
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: {
        senderID?: string
        chatID?: string
        messageID?: string
        command?: InboundCommand
        cardAction?: { value: unknown; clickedMessageID?: string }
      }
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      // 卡片按钮点击模拟
      if (parsed.cardAction) {
        const ctx: InboundContext = {
          senderID: parsed.senderID ?? "unknown",
          chatID: parsed.chatID ?? "mock",
          messageID: parsed.cardAction.clickedMessageID,
        }
        this.cardActionHandler?.(parsed.cardAction.value, ctx, ctx.messageID)
        continue
      }
      const cmd = parsed.command
      if (!cmd) continue
      const ctx: InboundContext = {
        senderID: parsed.senderID ?? "unknown",
        chatID: parsed.chatID ?? "mock",
        messageID: parsed.messageID,
      }
      this.handler?.(cmd, ctx)
    }
  }
}
