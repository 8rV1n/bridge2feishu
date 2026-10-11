import type { InboundContext } from "./types.js"
import type { PluginConfig } from "./config.js"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * 安全层：
 * - 用户/会话白名单，默认拒绝
 * - 权限审批 requestID 绑定（由 SessionController 保证只批复当前 pending 请求）
 * - 防重放（传输层 ReplayGuard / mock offset）
 * - 审计日志：所有远程操作与来源留痕（不含密钥）
 */
export class Security {
  private auditPath: string

  constructor(private config: PluginConfig) {
    this.auditPath = join(config.stateDir, "audit.jsonl")
  }

  checkInbound(ctx: InboundContext): { ok: true } | { ok: false; reason: string } {
    const senders = this.config.allowedSenderIDs
    const chats = this.config.allowedChatIDs
    const senderOk = senders.includes("*") || senders.includes(ctx.senderID)
    if (!senderOk) return { ok: false, reason: `sender ${ctx.senderID} not allowed` }
    const chatOk = chats.includes("*") || chats.includes(ctx.chatID)
    if (!chatOk) return { ok: false, reason: `chat ${ctx.chatID} not allowed` }
    return { ok: true }
  }

  /** 远程操作审计（本地 JSONL，仅记录动作与来源，不含文本内容与密钥） */
  audit(entry: {
    direction: "in" | "out"
    action: string
    ok: boolean
    senderID?: string
    chatID?: string
    detail?: string
  }): void {
    try {
      mkdirSync(this.config.stateDir, { recursive: true })
      appendFileSync(
        this.auditPath,
        `${JSON.stringify({ ts: Date.now(), ...entry })}\n`,
      )
    } catch {
      // 审计失败不影响主流程
    }
  }
}
