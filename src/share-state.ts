import type { ShareStatus, ShareTarget } from "./types.js"

/**
 * 多 session 分享状态管理。
 * - targets：本 TUI 进程已分享会话（Map 保持分享顺序）
 * - externals：其他 TUI 进程（follower）经中继注册的会话——只做路由/列表，不承载本地状态
 * - activeSessionID：飞书指令（prompt、/status、/stop…）的当前作用对象，可指向本进程或 external 会话
 *   - 第一个分享的 session 自动成为 active
 *   - 后续分享不改变 active（新会话接入只提醒、不抢占）
 *   - active 被停止时回退到分享顺序里最早剩余的会话
 * - stop 解除远程访问，不影响本地 Agent；最后一个会话停止后上层才关 transport
 */
export class ShareStateManager {
  private targets = new Map<string, ShareTarget>()
  /** 其他 TUI 实例（follower）经中继注册的会话：sessionID → { chatID, ownerID, pid, sharedAt } */
  private externals = new Map<string, { chatID: string; ownerID: string; pid: number; sharedAt: number }>()
  private activeID: string | null = null

  get status(): ShareStatus {
    return this.targets.size + this.externals.size > 0 ? "shared" : "unshared"
  }

  /** 当前 active 目标（仅本进程会话；external 会话返回 null，上层用 activeSessionID 判断） */
  get current(): Readonly<ShareTarget> | null {
    return this.activeID ? this.targets.get(this.activeID) ?? null : null
  }

  get activeSessionID(): string | null {
    return this.activeID
  }

  get count(): number {
    return this.targets.size + this.externals.size
  }

  /** 全局已分享目标（本进程 + external，按 sharedAt 排序 = /session 序号顺序，稳定不漂移） */
  list(): Readonly<ShareTarget>[] {
    const merged: ShareTarget[] = [
      ...this.targets.values(),
      ...[...this.externals].map(([sessionID, e]) => ({
        sessionID,
        chatID: e.chatID,
        sharedAt: e.sharedAt,
      })),
    ]
    return merged.sort((a, b) => a.sharedAt - b.sharedAt)
  }

  /** /session 序号（1-based，按分享顺序）；未分享返回 0 */
  indexOf(sessionID: string): number {
    return this.list().findIndex((t) => t.sessionID === sessionID) + 1
  }

  targetOf(sessionID: string): Readonly<ShareTarget> | null {
    const own = this.targets.get(sessionID)
    if (own) return own
    const ext = this.externals.get(sessionID)
    return ext ? { sessionID, chatID: ext.chatID, sharedAt: ext.sharedAt } : null
  }

  /** external 会话归属实例 ID（中继路由用）；本进程会话返回 undefined */
  externalOwnerOf(sessionID: string): string | undefined {
    return this.externals.get(sessionID)?.ownerID
  }

  isShared(sessionID: string): boolean {
    return this.targets.has(sessionID) || this.externals.has(sessionID)
  }

  /**
   * 绑定一个会话。
   * - 首个分享 → 自动成为 active（isActive: true）
   * - 后续分享 → 仅加入，不改变 active（isActive: false）
   * - 同一会话重复 share 幂等（chatID 变化时更新绑定）
   */
  share(sessionID: string, chatID: string): { ok: true; already: boolean; isActive: boolean } | { ok: false; reason: string } {
    const existing = this.targets.get(sessionID)
    if (existing) {
      if (existing.chatID !== chatID) this.targets.set(sessionID, { ...existing, chatID })
      return { ok: true, already: true, isActive: this.activeID === sessionID }
    }
    this.targets.set(sessionID, { sessionID, chatID, sharedAt: Date.now() })
    if (!this.activeID) this.activeID = sessionID
    return { ok: true, already: false, isActive: this.activeID === sessionID }
  }

  /** follower 会话注册（leader 收编 external 会话）；首个全局会话自动成为 active */
  addExternal(sessionID: string, chatID: string, ownerID: string, pid: number): void {
    const existing = this.externals.get(sessionID)
    if (existing?.ownerID === ownerID) return
    this.externals.set(sessionID, { chatID, ownerID, pid, sharedAt: existing?.sharedAt ?? Date.now() })
    if (!this.activeID) this.activeID = sessionID
  }

  /** follower 会话移除；active 指向它时按全局分享顺序回退 */
  removeExternal(sessionID: string): void {
    const wasActive = this.activeID === sessionID
    this.externals.delete(sessionID)
    if (wasActive) this.activeID = this.list()[0]?.sessionID ?? null
  }

  /** 切换 active 会话（仅允许已分享的会话，含 external）；返回是否成功 */
  setActive(sessionID: string): boolean {
    if (!this.isShared(sessionID)) return false
    this.activeID = sessionID
    return true
  }

  /** 停止单个会话（external 走 removeExternal）；返回剩余数量，供上层决定是否关闭 transport */
  stopOne(sessionID: string): { ok: true; was: ShareTarget | null; remaining: number; wasActive: boolean } {
    if (this.externals.has(sessionID)) {
      const ext = this.externals.get(sessionID)!
      const wasActive = this.activeID === sessionID
      this.externals.delete(sessionID)
      if (wasActive) this.activeID = this.list()[0]?.sessionID ?? null
      return {
        ok: true,
        was: { sessionID, chatID: ext.chatID, sharedAt: ext.sharedAt },
        remaining: this.count,
        wasActive,
      }
    }
    const was = this.targets.get(sessionID) ?? null
    if (!was) return { ok: true, was: null, remaining: this.count, wasActive: false }
    const wasActive = this.activeID === sessionID
    this.targets.delete(sessionID)
    if (wasActive) {
      // 回退到分享顺序里最早剩余的会话（序号稳定语义）
      this.activeID = this.list()[0]?.sessionID ?? null
    }
    return { ok: true, was, remaining: this.count, wasActive }
  }

  /** 清除全部 external（follower 全体离开时） */
  clearExternals(): void {
    for (const sessionID of [...this.externals.keys()]) this.removeExternal(sessionID)
  }

  /** 全部停止（TUI 退出/整体断开）；was 为停止前的 active 目标 */
  stopAll(): { ok: true; was: ShareTarget | null } {
    const was = this.current
    this.targets.clear()
    this.externals.clear()
    this.activeID = null
    return { ok: true, was }
  }

  /** 0.1.x 兼容：无参 stop = 全部停止 */
  stop(): { ok: true; was: ShareTarget | null } {
    return this.stopAll()
  }

  /** 远程命令只允许操作被分享的会话（含 external） */
  routeCommand(sessionID: string): boolean {
    return this.isShared(sessionID)
  }
}

