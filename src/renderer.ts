import type { OutboundEvent, SessionSnapshot } from "./types.js"

/**
 * 通知渲染：OutboundEvent → 飞书消息（纯文本版）。
 * 设计约束：
 * - 状态类通知不调用任何 LLM，直接格式化事件数据
 * - 默认不上传敏感内容：摘要截断、不含环境变量/文件内容
 */
export const HELP_TEXT = [
  "OpenCode Feishu Share 指令：",
  "/status — 当前任务状态",
  "/recent — 最近执行结果",
  "/run <文本> — 发送新 prompt（busy 时排队）",
  "/steer <文本> — 插话（busy 时立即送达）",
  "/stop — 停止当前执行",
  "/approve [n] [always] — 批准待审批权限（默认最新）",
  "/deny [n] — 拒绝待审批权限",
  "/answer <选项> — 回答 Agent 提问",
  "/disconnect — 断开分享（不中止本地任务）",
].join("\n")

function truncate(text: string | undefined, max = 800): string {
  if (!text) return ""
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function snapshotLine(s: SessionSnapshot): string {
  return [
    `会话：${s.title ?? s.id}`,
    `消息数：${s.messageCount ?? "?"}`,
    s.lastAssistantText ? `最近回复：${truncate(s.lastAssistantText, 200)}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

export function renderOutbound(event: OutboundEvent): string {
  switch (event.kind) {
    case "share_open":
      return ["🟢 已开启分享", snapshotLine(event.session ?? { id: event.sessionID })].join("\n")
    case "share_close":
      return `⚪ 已断开分享（${event.reason}）`
    case "session_snapshot":
      return snapshotLine(event.snapshot)
    case "task_started":
      return "▶️ 任务开始执行"
    case "task_completed":
      return event.summary ? `✅ 任务完成\n${truncate(event.summary)}` : "✅ 任务完成"
    case "task_failed":
      return `❌ 执行失败\n${truncate(event.error ?? "unknown")}`
    case "permission_requested":
      return [
        "⚠️ 等待权限审批",
        `权限：${event.permission}${event.title ? `（${event.title}）` : ""}`,
        `回复 /approve 批准一次，/approve always 永久，/deny 拒绝`,
        `requestID: ${event.requestID}`,
      ].join("\n")
    case "question_asked": {
      const qs = event.questions as Array<{ question?: string; options?: Array<{ label: string }> }> | undefined
      const lines: string[] = ["❓ Agent 需要你的回答"]
      for (const q of qs ?? []) {
        if (q.question) lines.push(q.question)
        const opts = (q.options ?? []).map((o) => o.label).filter(Boolean)
        if (opts.length) lines.push(`选项：${opts.join(" / ")}`)
      }
      lines.push(`回复 /answer <选项文本>`)
      lines.push(`requestID: ${event.requestID}`)
      return lines.join("\n")
    }
    case "status":
      return truncate(event.text) || "(empty)"
  }
}

export function renderSnapshot(s: SessionSnapshot): string {
  return snapshotLine(s)
}
