import type { PluginConfig } from "./config.js"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"

/**
 * 传输层实例锁（leader 选举）：
 * 同一 stateDir + 传输类型（lark 含 appID）只允许一个 TUI 进程直连飞书。
 * 背景：飞书长连接模式下，同一 App 的多条 WS 连接会把事件/指令随机分流到其中一条——
 * 多个 TUI 各自建连后入站消息随机落点，表现为"回话错乱"。
 * 后来的 TUI 检测到锁被占用时转为 follower（本地中继，见 transport/relay.ts + hub.ts），
 * leader 进程退出/崩溃后 follower 可接管锁升为 leader。
 */
export function transportLockPath(config: PluginConfig): string {
  const lockName =
    config.transport === "lark" && config.feishuAppId
      ? `transport-lark-${config.feishuAppId}.lock`
      : `transport-${config.transport}.lock`
  return join(config.stateDir, lockName)
}

export type LockHolder = { pid?: number; instanceID?: string }

export function readLockHolder(config: PluginConfig): LockHolder | null {
  const lockPath = transportLockPath(config)
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockHolder
  } catch {
    return null
  }
}

/** 进程是否存活（EPERM 视为存活：存在但无权限探测） */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * instanceID：pid + 随机后缀。同一进程可能跑多个插件实例（测试/宿主多次加载），
 * 锁与中继文件的归属判断不能只看 pid。
 */
export function newInstanceID(): string {
  return `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function acquireTransportLock(
  config: PluginConfig,
  instanceID: string,
): { ok: true; release: () => void } | { ok: false; holder: string } {
  const lockPath = transportLockPath(config)
  try {
    mkdirSync(config.stateDir, { recursive: true })
    if (existsSync(lockPath)) {
      let holder: LockHolder | null = null
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8")) as LockHolder
      } catch {
        // 内容损坏视为陈旧锁，接管
      }
      const sameHolder = holder?.pid === process.pid && holder?.instanceID === instanceID
      if (!sameHolder && holder?.pid !== undefined && pidAlive(holder.pid)) {
        return { ok: false, holder: `PID ${holder.pid}` }
      }
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instanceID, startedAt: Date.now() }))
    return {
      ok: true,
      release: () => {
        try {
          // 仅释放自己持有的锁（进程崩溃后陈旧锁由下一次接管清理）
          const cur = JSON.parse(readFileSync(lockPath, "utf8")) as LockHolder
          if (cur.pid === process.pid && cur.instanceID === instanceID) unlinkSync(lockPath)
        } catch {
          // 锁读不出来/已被清理则忽略
        }
      },
    }
  } catch {
    // 锁机制自身故障不阻塞主流程（宁可用，不可挡）
    return { ok: true, release: () => {} }
  }
}
