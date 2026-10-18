import type { InboundCommand, InboundContext, OutboundEvent } from "./types.js"
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  appendFileSync,
} from "node:fs"
import { join } from "node:path"
import { pidAlive } from "./lock.js"

/**
 * 跨 TUI 进程中继协议（同一机器、共享 stateDir，无额外进程/端口）：
 *
 *   follower（非 leader 的 TUI）                      leader（持锁的 TUI）
 *   ─────────────────────────                        ─────────────────────
 *   <pid>-up.jsonl  ──────── op 泵送 ──────────────►  真实 transport（飞书 WS）
 *   <pid>-down.jsonl ◄──── 指令/回执 派发 ──────────  hub（按 active 路由）
 *   <pid>-meta.json  = 注册表 + 会话快照（原子重写）
 *
 * - meta 文件即注册表：leader 扫描 relay 目录发现/摘除 follower（PID 存活检测）
 * - up/down 为 JSONL 追加文件，消费方按字节偏移读增量；offset 由 hub 持久化在 hub-cursor.json，
 *   leader 更替后新 leader 从上次游标继续，不会重放旧卡片
 * - send/sendCard 需要回执（messageID 是后续 updateCard 的句柄）：up-op 带 id，
 *   leader 把 {replyTo, messageID} 写回 down 文件
 */

export type SwitchSnapshot = {
  title?: string
  messageCount?: number
  status?: string
  /** /status 风格的会话概览（模型/Agent/费用/待办…），切换卡直接引用 */
  statusText?: string
  lastUserText?: string
  lastAssistantText?: string
}

export type FollowerSessionInfo = {
  sessionID: string
  chatID: string
  title?: string
  snapshot?: SwitchSnapshot
}

/** follower 注册表条目（meta.json，原子重写） */
export type FollowerMeta = {
  instanceID: string
  pid: number
  startedAt: number
  updatedAt: number
  sessions: FollowerSessionInfo[]
}

/** follower → leader 操作 */
export type RelayUpOp =
  | { id: string; type: "send"; event: OutboundEvent }
  | { id: string; type: "sendCard"; card: unknown }
  | { id: string; type: "updateCard"; messageID: string; card: unknown }

/** leader → follower 消息 */
export type RelayDownMsg =
  | { type: "reply"; replyTo: string; messageID?: string }
  | { type: "command"; command: InboundCommand; ctx: InboundContext; targetSessionID?: string }
  | { type: "cardAction"; value: unknown; ctx: InboundContext; clickedMessageID?: string }
  | { type: "leaderExit"; reason: string }

export function relayDir(stateDir: string): string {
  return join(stateDir, "relay")
}

export function relayPaths(stateDir: string, instanceID: string): { up: string; down: string; meta: string } {
  const dir = relayDir(stateDir)
  return {
    up: join(dir, `${instanceID}-up.jsonl`),
    down: join(dir, `${instanceID}-down.jsonl`),
    meta: join(dir, `${instanceID}-meta.json`),
  }
}

export function readFollowerMeta(stateDir: string, instanceID: string): FollowerMeta | null {
  try {
    const meta = JSON.parse(readFileSync(relayPaths(stateDir, instanceID).meta, "utf8")) as FollowerMeta
    return meta.instanceID === instanceID ? meta : null
  } catch {
    return null
  }
}

export function writeFollowerMeta(meta: FollowerMeta, stateDir: string): void {
  mkdirSync(relayDir(stateDir), { recursive: true })
  atomicWriteJson(relayPaths(stateDir, meta.instanceID).meta, meta)
}

export function removeFollowerFiles(stateDir: string, instanceID: string): void {
  const { up, down, meta } = relayPaths(stateDir, instanceID)
  for (const p of [up, down, meta]) {
    try {
      unlinkSync(p)
    } catch {
      // 不存在则忽略
    }
  }
}

/** 存活的 follower meta 列表（按注册时间排序）；崩溃残留直接清理 */
export function scanFollowerMetas(stateDir: string, excludeInstanceID: string): FollowerMeta[] {
  let files: string[] = []
  try {
    files = readdirSync(relayDir(stateDir))
  } catch {
    return []
  }
  const out: FollowerMeta[] = []
  for (const f of files) {
    if (!f.endsWith("-meta.json")) continue
    let meta: FollowerMeta
    try {
      meta = JSON.parse(readFileSync(join(relayDir(stateDir), f), "utf8")) as FollowerMeta
    } catch {
      // 损坏文件：清掉
      try {
        unlinkSync(join(relayDir(stateDir), f))
      } catch {
        // 忽略
      }
      continue
    }
    if (meta.instanceID === excludeInstanceID) continue
    if (!pidAlive(meta.pid)) {
      removeFollowerFiles(stateDir, meta.instanceID)
      continue
    }
    if (meta.sessions.length > 0) out.push(meta)
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

export function appendLine(path: string, value: unknown): void {
  appendFileSync(path, JSON.stringify(value) + "\n")
}

/** 原子写 JSON（tmp + rename） */
export function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value))
  try {
    renameSync(tmp, path)
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // 忽略
    }
    writeFileSync(path, JSON.stringify(value))
  }
}

/** JSONL 增量读取：从 offset 读到文件尾（行可能不完整时以文件大小为新 offset，下次续读） */
export function readNewLines(path: string, offset: number): { lines: string[]; size: number } {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return { lines: [], size: offset }
  }
  if (size <= offset) return { lines: [], size }
  const len = size - offset
  const buf = Buffer.alloc(len)
  const fd = openSync(path, "r")
  try {
    readSync(fd, buf, 0, len, offset)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString("utf8")
  const lines: string[] = []
  let consumed = 0
  const parts = text.split("\n")
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!
    if (i === parts.length - 1) break // 最后一段可能不完整（未落 \n），留给下次
    if (line.trim()) lines.push(line)
    consumed += Buffer.byteLength(line, "utf8") + 1
  }
  return { lines, size: offset + consumed }
}

// ---------- hub 游标（跨 leader 更替不重放） ----------

export type HubCursor = Record<string, number>

export function readHubCursor(stateDir: string): HubCursor {
  try {
    return JSON.parse(readFileSync(join(relayDir(stateDir), "hub-cursor.json"), "utf8")) as HubCursor
  } catch {
    return {}
  }
}

export function writeHubCursor(stateDir: string, cursor: HubCursor): void {
  mkdirSync(relayDir(stateDir), { recursive: true })
  atomicWriteJson(join(relayDir(stateDir), "hub-cursor.json"), cursor)
}
