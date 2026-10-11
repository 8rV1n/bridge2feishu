import type { TuiPlugin } from "@opencode-ai/plugin/tui"

export const PLUGIN_ID = "opencode-feishu-share"
export const PLUGIN_VERSION = "0.1.0-poc"

export type ShareStatus = "unshared" | "shared"

export type ShareTarget = {
  sessionID: string
  /** 飞书侧会话标识（chat_id / open_id / mock 标识） */
  chatID: string
  sharedAt: number
}

/**
 * 出站事件。所有变体可附带 sessionTitle（由 emit 层自动注入），
 * 用于飞书卡片标题显示会话摘要。
 */
export type OutboundEvent =
  | ((
      | { kind: "share_open"; sessionID: string; chatID: string; session?: SessionSnapshot }
      | { kind: "share_close"; sessionID: string; chatID: string; reason: string }
      | { kind: "session_snapshot"; sessionID: string; chatID: string; snapshot: SessionSnapshot }
      | { kind: "task_started"; sessionID: string; chatID: string }
      | { kind: "task_completed"; sessionID: string; chatID: string; summary?: string }
      | { kind: "task_failed"; sessionID: string; chatID: string; error?: string }
      | { kind: "permission_requested"; sessionID: string; chatID: string; requestID: string; permission: string; title?: string; ordinal?: number }
      | { kind: "question_asked"; sessionID: string; chatID: string; requestID: string; questions: unknown }
      | { kind: "status"; sessionID: string; chatID: string; text: string }
    )
    & { sessionTitle?: string })

export type SessionSnapshot = {
  id: string
  title?: string
  directory?: string
  messageCount?: number
  status?: string
  lastAssistantText?: string
}

export type InboundCommand =
  | { action: "prompt"; text: string; delivery?: "steer" | "queue" }
  | { action: "status" }
  | { action: "recent" }
  | { action: "abort" }
  | { action: "permission_reply"; requestID: string; reply: "once" | "always" | "reject" }
  | { action: "question_reply"; requestID: string; answers: string[] }
  | { action: "stop" }
  | { action: "help" }
  | { action: "model_list" }
  | { action: "model_switch"; index: number }
  | { action: "agent_list" }
  | { action: "agent_switch"; index: number }

/** 飞书（或 Mock）传输层接口：TUI → 飞书 为 send/update，飞书 → TUI 为 inbound 回调 */
export type FeishuTransport = {
  start(): Promise<void>
  stop(): Promise<void>
  send(event: OutboundEvent): Promise<void>
  onInbound(handler: (cmd: InboundCommand, ctx: InboundContext) => void): void
}

export type InboundContext = {
  /** 发送方身份（真实飞书为 open_id；Mock 由配置提供） */
  senderID: string
  /** 接收消息的飞书会话 ID */
  chatID: string
  /** 传输层内部生成的消息唯一 ID，用于防重放 */
  messageID?: string
}
