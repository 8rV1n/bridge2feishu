import type {
  AssistantMessage,
  Message,
  Part,
  Session,
  TextPart,
} from "@opencode-ai/sdk/v2"

/** 从消息数组中提取最后一条 assistant 文本（截断） */
export function lastAssistantText(messages: Array<{ info: Message; parts: Array<Part> }>, max = 600): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.info.role !== "assistant") continue
    const text = m.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (!text) continue
    return text.length > max ? `${text.slice(0, max)}…` : text
  }
  return undefined
}

export function textOfMessage(m: { info: Message; parts: Array<Part> }): string {
  return m.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

export type SessionSummary = {
  id: string
  title?: string
  messageCount: number
  lastUserText?: string
  lastAssistantText?: string
}

export function summarize(
  session: Session | undefined,
  messages: Array<{ info: Message; parts: Array<Part> }>,
): SessionSummary {
  const lastUser = [...messages].reverse().find((m) => m.info.role === "user")
  return {
    id: session?.id ?? "",
    title: session?.title,
    messageCount: messages.length,
    lastUserText: lastUser ? lastAssistantText([lastUser]) : undefined,
    lastAssistantText: lastAssistantText(messages),
  }
}

/** 判断 assistant 消息是否处于未完成状态（用于完成通知判断，PoC 备用） */
export function isAssistantFinished(m: AssistantMessage): boolean {
  return m.time?.completed !== undefined
}
