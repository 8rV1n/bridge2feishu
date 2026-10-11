import type { InboundCommand, InboundContext } from "./types.js"

/**
 * 飞书消息 → InboundCommand。
 * 默认行为：**纯文本直接作为 prompt**（像在 TUI 里直接输入一样，busy 时排队）。
 * 斜杠指令（大小写不敏感，@机器人 mention 自动剥离）：
 *   /help
 *   /status                      查看任务状态
 *   /recent                      查看最近执行结果
 *   /run <text>                  发送新 prompt（busy 时排队 queue）
 *   /steer <text>                发送 prompt（busy 时插话 steer）
 *   /stop                        停止当前执行（abort）
 *   /approve [n] [always]        批准待审批权限（默认最新一个；n 为通知序号）
 *   /deny [n]                    拒绝待审批权限
 *   /answer <选项文本>            回答最近的交互式问题
 *   /disconnect                  断开分享（不中止本地任务）
 * 未知斜杠指令返回 null（忽略）。
 * requestID 使用 "#latest"/"#n" 占位，由 SessionController 按待处理顺序解析。
 */
export function parseFeishuCommand(
  raw: string,
  mentions?: Array<{ key: string; id: { open_id?: string } }>,
): InboundCommand | null {
  let text = raw ?? ""
  if (mentions) {
    for (const m of mentions) {
      text = text.split(m.key).join(" ")
    }
  }
  text = stripMentionPlaceholders(text)
  if (!text) return null

  const spaceIdx = text.indexOf(" ")
  const head = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim()

  switch (head) {
    case "/help":
      return { action: "help" }
    case "/status":
      return { action: "status" }
    case "/recent":
      return { action: "recent" }
    case "/run":
      return rest ? { action: "prompt", text: rest, delivery: "queue" } : null
    case "/steer":
      return rest ? { action: "prompt", text: rest, delivery: "steer" } : null
    case "/stop":
      return { action: "abort" }
    case "/disconnect":
      return { action: "stop" }
    case "/approve":
    case "/deny": {
      const parts = rest.split(" ").filter(Boolean)
      let selector = "#latest"
      let always = false
      if (parts.length > 0 && /^\d+$/.test(parts[0]!)) {
        if (Number(parts[0]) >= 1) selector = `#${parts[0]}`
        parts.shift()
      }
      if (parts[0]?.toLowerCase() === "always") always = true
      if (head === "/deny") return { action: "permission_reply", requestID: selector, reply: "reject" }
      return { action: "permission_reply", requestID: selector, reply: always ? "always" : "once" }
    }
    case "/answer":
      return rest ? { action: "question_reply", requestID: "#latest", answers: [rest] } : null
    case "/model": {
      if (!rest) return { action: "model_list" }
      const n = Number(rest.split(" ")[0])
      return Number.isInteger(n) && n >= 1 ? { action: "model_switch", index: n } : null
    }
    case "/agent": {
      if (!rest) return { action: "agent_list" }
      const n = Number(rest.split(" ")[0])
      return Number.isInteger(n) && n >= 1 ? { action: "agent_switch", index: n } : null
    }
    default:
      // 纯文本 = 直接作为 prompt（像在 TUI 里输入一样）
      if (head.startsWith("/")) return null
      return { action: "prompt", text, delivery: "queue" }
  }
}

export function stripMentionPlaceholders(text: string): string {
  return text.replace(/@\S+/g, " ").replace(/\s+/g, " ").trim()
}

/** 卡片按钮点击 → InboundCommand（value 由渲染时写入，格式受控） */
export function cardActionToCommand(value: unknown): InboundCommand | null {
  if (!value || typeof value !== "object") return null
  const v = value as { kind?: string; requestID?: string; reply?: string; label?: string; text?: string }
  if (v.kind === "permission" && typeof v.requestID === "string") {
    const reply = v.reply === "always" ? "always" : v.reply === "reject" ? "reject" : "once"
    return { action: "permission_reply", requestID: v.requestID, reply }
  }
  if (v.kind === "question" && typeof v.requestID === "string" && typeof v.label === "string" && v.label.trim()) {
    return { action: "question_reply", requestID: v.requestID, answers: [v.label] }
  }
  if (v.kind === "question_custom" && typeof v.requestID === "string") {
    return { action: "question_custom", requestID: v.requestID }
  }
  // 「✍️ 其他答案」表单提交：传输层已把 form_value 的输入文本合并进 value.text
  if (v.kind === "question_form" && typeof v.requestID === "string" && typeof v.text === "string" && v.text.trim()) {
    return { action: "question_reply", requestID: v.requestID, answers: [v.text.trim()] }
  }
  return null
}

export type RouterDeps = {
  parse: typeof parseFeishuCommand
}

export type { InboundCommand, InboundContext }
