import type { InboundCommand, InboundContext, FeishuTransport } from "./types.js"
import type { FollowerMeta, FollowerSessionInfo, RelayUpOp } from "./relay.js"
import {
  appendLine,
  readNewLines,
  readHubCursor,
  writeHubCursor,
  scanFollowerMetas,
  relayPaths,
  relayDir,
} from "./relay.js"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Leader 侧中继枢纽（跑在持锁 TUI 的插件里，非独立进程）：
 * - 扫描 relay 目录发现/摘除 follower（meta 即注册表，PID 存活检测）
 * - 泵送 follower 的卡片操作到真实 transport（send/sendCard 回执 messageID）
 * - 记录 messageID → follower 归属（卡片按钮回调路由）与 requestID → follower 归属（/approve /answer 转发）
 * - 指令派发由 index.ts 决策（安全校验/active 解析在 leader），hub 只负责投递
 */
export type LeaderHubOptions = {
  pollMs?: number
  dbg?: (msg: string) => void
  onSessionsAdded: (sessions: Array<FollowerSessionInfo & { pid: number }>, ownerID: string) => void
  onSessionsRemoved: (sessions: Array<FollowerSessionInfo & { pid: number }>, ownerID: string) => void
}

export class LeaderHub {
  private timer: ReturnType<typeof setInterval> | null = null
  private followers = new Map<string, FollowerMeta>()
  private cursors: Record<string, number> = {}
  /** 已发送卡片（含 follower 的）→ 归属 follower pid；卡片按钮回调据此转发 */
  private messageOwners = new Map<string, string>()
  /** follower 的待审批/待提问 requestID → pid（转发 /approve /answer 用，按出现序） */
  private requestOrder: string[] = []
  private requestOwnerMap = new Map<string, string>()

  constructor(
    private stateDir: string,
    private excludeInstanceID: string,
    private transport: Pick<FeishuTransport, "send" | "sendCard" | "updateCard">,
    private opts: LeaderHubOptions,
  ) {}

  start(): void {
    this.cursors = readHubCursor(this.stateDir)
    mkdirSync(relayDir(this.stateDir), { recursive: true })
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 200)
    this.timer.unref?.()
    this.tick() // 立即扫一轮，接管场景能马上收编现存 follower
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** follower 会话清单（供 /session 聚合） */
  listSessions(): Array<FollowerSessionInfo & { ownerID: string; pid: number }> {
    const out: Array<FollowerSessionInfo & { ownerID: string; pid: number }> = []
    for (const meta of this.followers.values()) {
      for (const s of meta.sessions) out.push({ ...s, ownerID: meta.instanceID, pid: meta.pid })
    }
    return out
  }

  followerSession(sessionID: string): (FollowerSessionInfo & { ownerID: string; pid: number }) | undefined {
    for (const meta of this.followers.values()) {
      const s = meta.sessions.find((x) => x.sessionID === sessionID)
      if (s) return { ...s, ownerID: meta.instanceID, pid: meta.pid }
    }
    return undefined
  }

  ownerOfMessageID(messageID: string): string | undefined {
    return this.messageOwners.get(messageID)
  }

  /** 显式 requestID 的归属；选择器（#latest/#n）返回最近/第 n 个 follower 请求的属主 */
  ownerOfRequest(selector: string): string | undefined {
    if (!selector.startsWith("#")) return this.requestOwnerMap.get(selector)
    if (selector === "#latest") {
      const last = this.requestOrder[this.requestOrder.length - 1]
      return last ? this.requestOwnerMap.get(last) : undefined
    }
    const n = Number(selector.slice(1))
    if (!Number.isInteger(n) || n < 1) return undefined
    const rid = this.requestOrder[n - 1]
    return rid ? this.requestOwnerMap.get(rid) : undefined
  }

  forwardCommand(ownerID: string, command: InboundCommand, ctx: InboundContext, targetSessionID?: string): void {
    const { down } = relayPaths(this.stateDir, ownerID)
    appendLine(down, { type: "command", command, ctx, targetSessionID })
  }

  forwardCardAction(ownerID: string, value: unknown, ctx: InboundContext, clickedMessageID?: string): void {
    const { down } = relayPaths(this.stateDir, ownerID)
    appendLine(down, { type: "cardAction", value, ctx, clickedMessageID })
  }

  /** leader 优雅退出：通知所有 follower（它们会尝试接管） */
  notifyLeaderExit(reason: string): void {
    for (const ownerID of this.followers.keys()) {
      const { down } = relayPaths(this.stateDir, ownerID)
      try {
        appendLine(down, { type: "leaderExit", reason })
      } catch {
        // 通知失败不阻塞退出
      }
    }
  }

  // ---------- 内部 ----------

  private tick(): void {
    try {
      this.scanFollowers()
      this.pumpOps()
    } catch (err) {
      this.opts.dbg?.(`hub tick ERROR: ${String(err)}`)
    }
  }

  private scanFollowers(): void {
    const metas = scanFollowerMetas(this.stateDir, this.excludeInstanceID)
    const seen = new Set<string>()
    for (const meta of metas) {
      seen.add(meta.instanceID)
      const prev = this.followers.get(meta.instanceID)
      this.followers.set(meta.instanceID, meta)
      const prevIDs = new Set((prev?.sessions ?? []).map((s) => s.sessionID))
      const added = meta.sessions.filter((s) => !prevIDs.has(s.sessionID))
      const withPid = (arr: FollowerSessionInfo[]) => arr.map((s) => ({ ...s, pid: meta.pid }))
      if (!prev && meta.sessions.length > 0) this.opts.onSessionsAdded(withPid(meta.sessions), meta.instanceID)
      else if (added.length > 0) this.opts.onSessionsAdded(withPid(added), meta.instanceID)
    }
    // 摘除：meta 消失（follower 主动停止）或 sessions 清空（scan 不会返回空 meta）
    for (const [ownerID, prevMeta] of [...this.followers]) {
      if (seen.has(ownerID)) continue
      this.followers.delete(ownerID)
      delete this.cursors[ownerID]
      if (prevMeta.sessions.length > 0) this.opts.onSessionsRemoved(prevMeta.sessions.map((s) => ({ ...s, pid: prevMeta.pid })), ownerID)
    }
    writeHubCursor(this.stateDir, this.cursors)
  }

  private pumpOps(): void {
    let dirty = false
    for (const ownerID of this.followers.keys()) {
      const { up, down } = relayPaths(this.stateDir, ownerID)
      if (!existsSync(up)) continue
      const offset = this.cursors[ownerID] ?? 0
      const { lines, size } = readNewLines(up, offset)
      if (lines.length === 0) {
        // follower 重启会 truncate up 文件：offset 超过文件大小时归零
        if (size < offset) {
          this.cursors[ownerID] = 0
          dirty = true
        }
        continue
      }
      this.cursors[ownerID] = size
      dirty = true
      for (const line of lines) {
        let op: RelayUpOp
        try {
          op = JSON.parse(line) as RelayUpOp
        } catch {
          continue
        }
        try {
          void this.handleOp(ownerID, op, down)
        } catch (err) {
          this.opts.dbg?.(`hub op ERROR: ${String(err)}`)
        }
      }
    }
    if (dirty) writeHubCursor(this.stateDir, this.cursors)
  }

  private async handleOp(ownerID: string, op: RelayUpOp, down: string): Promise<void> {
    if (op.type === "send") {
      const messageID = await this.transport.send(op.event)
      if (messageID) {
        this.trackMessage(messageID, ownerID)
        const ev = op.event as { kind?: string; requestID?: string }
        if ((ev.kind === "permission_requested" || ev.kind === "question_asked") && typeof ev.requestID === "string") {
          this.trackRequest(ev.requestID, ownerID)
        }
      }
      appendLine(down, { type: "reply", replyTo: op.id, messageID })
      return
    }
    if (op.type === "sendCard") {
      const messageID = await this.transport.sendCard(op.card)
      if (messageID) this.trackMessage(messageID, ownerID)
      appendLine(down, { type: "reply", replyTo: op.id, messageID })
      return
    }
    if (op.type === "updateCard") {
      // updateCard 的 messageID 也要记录归属（续页卡可能先 update 后被点击）
      this.trackMessage(op.messageID, ownerID)
      await this.transport.updateCard(op.messageID, op.card)
    }
  }

  private trackMessage(messageID: string, ownerID: string): void {
    if (this.messageOwners.size > 500) {
      const first = this.messageOwners.keys().next().value
      if (first) this.messageOwners.delete(first)
    }
    this.messageOwners.set(messageID, ownerID)
  }

  private trackRequest(requestID: string, ownerID: string): void {
    if (!this.requestOwnerMap.has(requestID)) this.requestOrder.push(requestID)
    this.requestOwnerMap.set(requestID, ownerID)
    if (this.requestOrder.length > 200) {
      const removed = this.requestOrder.shift()
      if (removed) this.requestOwnerMap.delete(removed)
    }
  }

  /** follower 掉线清理（leader 退出场景由 index.ts 调用） */
  dropFollower(ownerID: string): void {
    const meta = this.followers.get(ownerID)
    this.followers.delete(ownerID)
    delete this.cursors[ownerID]
    if (meta && meta.sessions.length > 0) this.opts.onSessionsRemoved(meta.sessions.map((s) => ({ ...s, pid: meta.pid })), ownerID)
  }
}
