import type { ShareStatus, ShareTarget } from "./types.js"

/**
 * 会话级分享状态管理。
 * - 默认 unshared
 * - 只有显式 share 才进入 shared，并绑定 (sessionID, chatID)
 * - stop 解除远程访问，不影响本地 Agent
 * - TUI 插件生命周期结束即整体丢弃（无需持久化，重启后默认 unshared，更安全）
 */
export class ShareStateManager {
  private target: ShareTarget | null = null

  get status(): ShareStatus {
    return this.target ? "shared" : "unshared"
  }

  get current(): Readonly<ShareTarget> | null {
    return this.target
  }

  isShared(sessionID: string): boolean {
    return this.target?.sessionID === sessionID
  }

  /** 绑定当前会话；同一会话重复 share 幂等返回 true */
  share(sessionID: string, chatID: string): { ok: true; already: boolean } | { ok: false; reason: string } {
    if (this.target) {
      if (this.target.sessionID === sessionID && this.target.chatID === chatID) {
        return { ok: true, already: true }
      }
      return { ok: false, reason: `already sharing session ${this.target.sessionID}` }
    }
    this.target = { sessionID, chatID, sharedAt: Date.now() }
    return { ok: true, already: false }
  }

  stop(): { ok: true; was: ShareTarget | null } {
    const was = this.target
    this.target = null
    return { ok: true, was }
  }

  /** 远程命令只允许操作被分享的会话 */
  routeCommand(sessionID: string): boolean {
    return this.target?.sessionID === sessionID
  }
}
