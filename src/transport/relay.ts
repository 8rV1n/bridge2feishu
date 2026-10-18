import type { FeishuTransport, InboundCommand, InboundContext, OutboundEvent } from "../types.js"
import type { FollowerSessionInfo, RelayDownMsg, RelayUpOp } from "../relay.js"
import type { PluginConfig } from "../config.js"
import {
  appendLine,
  readNewLines,
  readFollowerMeta,
  writeFollowerMeta,
  removeFollowerFiles,
  relayPaths,
  relayDir,
} from "../relay.js"
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { transportLockPath, pidAlive, acquireTransportLock } from "../lock.js"

/**
 * Follower 传输层：不直连飞书，经本地中继文件与 leader（持锁 TUI）交换数据。
 * - 出站（send/sendCard/updateCard）→ 追加 <pid>-up.jsonl，send/sendCard 等待 leader 回执拿 messageID
 * - 入站（command/cardAction/leaderExit）← 轮询 <pid>-down.jsonl
 * - meta.json 由 publishSessions 原子重写（leader 用它发现 follower、渲染 /session 列表与切换卡）
 * - leader 存活监视：锁文件消失或持锁 PID 死亡 → 尝试接管锁升为 leader（onPromote 回调）
 */
export type RelayTransportOptions = {
  pollMs?: number
  sendTimeoutMs?: number
  onPromote?: (releaseLock: () => void) => void
}

export class RelayTransport implements FeishuTransport {
  private handler: ((cmd: InboundCommand, ctx: InboundContext, opts?: { targetSessionID?: string }) => void) | null = null
  private cardHandler: ((value: unknown, ctx: InboundContext, messageID?: string) => void) | null = null
  private exitHandler: ((reason: string) => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private offset = 0
  private pending = new Map<string, { resolve: (messageID?: string) => void; timer: ReturnType<typeof setTimeout> }>()
  private seq = 0
  private stopped = true
  private promoting = false

  constructor(
    private config: PluginConfig,
    private instanceID: string,
    private opts: RelayTransportOptions = {},
  ) {}

  async start(): Promise<void> {
    mkdirSync(relayDir(this.config.stateDir), { recursive: true })
    const { up, down } = relayPaths(this.config.stateDir, this.instanceID)
    // 重开分享：truncate 自己的 up 文件（down 保持增量语义，读 offset 从尾部开始）
    try {
      writeFileSync(up, "")
    } catch {
      // 忽略
    }
    this.offset = fileSize(down)
    this.stopped = false
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 150)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    removeFollowerFiles(this.config.stateDir, this.instanceID)
  }

  /** 注册/刷新自己在 leader 注册表里的会话与快照（meta 即注册表） */
  publishSessions(sessions: FollowerSessionInfo[]): void {
    const prev = readFollowerMeta(this.config.stateDir, this.instanceID)
    writeFollowerMeta(
      {
        instanceID: this.instanceID,
        pid: process.pid,
        startedAt: prev?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        sessions,
      },
      this.config.stateDir,
    )
  }

  onInbound(handler: (cmd: InboundCommand, ctx: InboundContext, opts?: { targetSessionID?: string }) => void): void {
    this.handler = handler
  }

  onCardAction(handler: (value: unknown, ctx: InboundContext, messageID?: string) => void): void {
    this.cardHandler = handler
  }

  /** leader 优雅退出通知（TUI 关闭但想让 follower 接管时由 index.ts 决定行为） */
  onLeaderExit(handler: (reason: string) => void): void {
    this.exitHandler = handler
  }

  async send(event: OutboundEvent): Promise<string | undefined> {
    return this.upAwait({ id: this.nextID(), type: "send", event })
  }

  async sendCard(card: unknown): Promise<string | undefined> {
    return this.upAwait({ id: this.nextID(), type: "sendCard", card })
  }

  async updateCard(messageID: string, card: unknown): Promise<void> {
    const { up } = relayPaths(this.config.stateDir, this.instanceID)
    appendLine(up, { id: this.nextID(), type: "updateCard", messageID, card } satisfies RelayUpOp)
  }

  // ---------- 内部 ----------

  private nextID(): string {
    return `op_${this.instanceID}_${Date.now().toString(36)}_${++this.seq}`
  }

  /** 追加 up-op 并等待 leader 回执（超时返回 undefined，不阻塞主流程） */
  private upAwait(op: { id: string; type: "send" | "sendCard"; event?: OutboundEvent; card?: unknown }): Promise<string | undefined> {
    const { up, down } = relayPaths(this.config.stateDir, this.instanceID)
    mkdirSync(relayDir(this.config.stateDir), { recursive: true })
    appendLine(up, op)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(op.id)
        resolve(undefined)
      }, this.opts.sendTimeoutMs ?? 8000)
      this.pending.set(op.id, { resolve, timer })
      // 回执可能在追加前就已写入（竞态）：立即探一次 down 尾部
      this.drainDown(down, true)
    })
  }

  private tick(): void {
    if (this.stopped) return
    const { down } = relayPaths(this.config.stateDir, this.instanceID)
    this.drainDown(down, false)
    this.watchLeader()
  }

  private drainDown(down: string, _catchUp: boolean): void {
    const { lines, size } = readNewLines(down, this.offset)
    this.offset = size
    for (const line of lines) {
      let msg: RelayDownMsg
      try {
        msg = JSON.parse(line) as RelayDownMsg
      } catch {
        continue
      }
      if (msg.type === "reply") {
        const p = this.pending.get(msg.replyTo)
        if (p) {
          clearTimeout(p.timer)
          this.pending.delete(msg.replyTo)
          p.resolve(msg.messageID)
        }
        continue
      }
      if (msg.type === "command") {
        this.handler?.(msg.command, msg.ctx, msg.targetSessionID ? { targetSessionID: msg.targetSessionID } : undefined)
        continue
      }
      if (msg.type === "cardAction") {
        this.cardHandler?.(msg.value, msg.ctx, msg.clickedMessageID)
        continue
      }
      if (msg.type === "leaderExit") {
        this.exitHandler?.(msg.reason)
      }
    }
  }

  /** leader 存活监视：锁没了或持锁进程死亡 → 尝试接管升为 leader */
  private watchLeader(): void {
    if (this.promoting) return
    const lockPath = transportLockPath(this.config)
    let holder: { pid?: number } | null = null
    let exists = false
    try {
      exists = true
      holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }
    } catch {
      exists = false
    }
    const alive = exists && holder?.pid !== undefined && pidAlive(holder.pid)
    if (alive) return
    void this.promote()
  }

  private async promote(): Promise<void> {
    this.promoting = true
    try {
      // leader 可能正在退出（锁将释放），带重试抢锁
      let lock: { ok: true; release: () => void } | { ok: false; holder: string } | null = null
      for (let i = 0; i < 20; i++) {
        lock = acquireTransportLock(this.config, this.instanceID)
        if (lock.ok) break
        await new Promise((r) => setTimeout(r, 150))
      }
      if (!lock?.ok) {
        this.promoting = false
        return // 抢不到：另一个 TUI 成了 leader，继续当 follower
      }
      const release = lock.release
      // 升级：清 follower 足迹，让 index.ts 换真 transport
      this.stopped = true
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
      removeFollowerFiles(this.config.stateDir, this.instanceID)
      this.opts.onPromote?.(release)
    } finally {
      this.promoting = false
    }
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
