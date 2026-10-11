import type { OutboundEvent, SessionSnapshot } from "./types.js"

/**
 * 通知渲染：OutboundEvent → 飞书卡片（可能多张）。
 * - interactive 卡片（lark_md）：支持 markdown 渲染（代码块、加粗、链接），彩色标题栏
 * - 超长内容自动分段为多张卡片，标题带 (x/x)
 * - 卡片标题尾部附加会话摘要（sessionTitle，由 emit 层注入）
 * - 状态类通知不调用任何 LLM；默认不上传敏感内容（截断、不含环境变量/文件内容）
 */

export type FeishuCard = {
  config: { wide_screen_mode: boolean }
  header: { template: string; title: { tag: "plain_text"; content: string } }
  elements: Array<
    | { tag: "markdown"; content: string }
    | { tag: "hr" }
    | { tag: "note"; elements: Array<{ tag: "plain_text"; content: string }> }
    | { tag: "action"; actions: Array<{ tag: "button"; text: { tag: "plain_text"; content: string }; type?: string; value: unknown }> }
  >
}

/** 单张卡片 markdown 正文上限（字符） */
const BODY_LIMIT = 1600
/** 卡片标题中会话摘要的最大长度 */
const SESSION_TAG_MAX = 28

export const HELP_TEXT = [
  "直接发文本 = 发送 prompt（像在 TUI 里输入一样）",
  "",
  "`/status` — 上下文信息（模型/Agent/Context/文件/待办）",
  "`/recent` — 最近执行结果",
  "`/model` — 查看模型列表；`/model <n>` — 切换模型",
  "`/agent` — 查看 Agent 列表；`/agent <n>` — 切换 Agent",
  "`/stop` — 停止当前执行",
  "`/approve [n] [always]` — 批准待审批权限（默认最新）",
  "`/deny [n]` — 拒绝待审批权限",
  "`/answer <选项>` — 回答 Agent 提问",
  "`/disconnect` — 断开分享（不中止本地任务）",
].join("\n")

/** 飞书卡片 markdown 中 `{{ }}` 是变量语法，注入前转义 */
function escapeLarkMd(text: string): string {
  return text.replace(/\{\{/g, "{ {")
}

/** 按行聚合分段；单行超限做字符硬切；保证每段不超过 limit */
export function splitContent(body: string, limit = BODY_LIMIT): string[] {
  if (body.length <= limit) return [body]
  const chunks: string[] = []
  let cur = ""
  const push = () => {
    if (cur) chunks.push(cur)
    cur = ""
  }
  for (const line of body.split("\n")) {
    if (line.length > limit) {
      push()
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit))
      continue
    }
    if (cur.length + line.length + 1 > limit) push()
    cur = cur ? `${cur}\n${line}` : line
  }
  push()
  return chunks.length > 0 ? chunks : [body.slice(0, limit)]
}

function card(template: string, title: string, body: string, note?: string): FeishuCard {
  const elements: FeishuCard["elements"] = [{ tag: "markdown", content: escapeLarkMd(body) }]
  if (note) elements.push({ tag: "hr" }, { tag: "note", elements: [{ tag: "plain_text", content: note }] })
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: "plain_text", content: title } },
    elements,
  }
}

/** 点击后把原卡片替换为已处理状态（按钮不可再点） */
export function renderProcessedCard(kind: string, detail: string, operator: string): FeishuCard {
  return card("grey", `✅ 已处理 · ${kind}`, `${detail}\n\n处理人：${operator}`)
}

/** 权限审批按钮行 */
function permissionButtons(requestID: string): FeishuCard["elements"][number] {
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "批准一次" },
        type: "primary",
        value: { kind: "permission", requestID, reply: "once" },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "永久批准" },
        type: "default",
        value: { kind: "permission", requestID, reply: "always" },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "拒绝" },
        type: "danger",
        value: { kind: "permission", requestID, reply: "reject" },
      },
    ],
  }
}

function sessionTag(event: OutboundEvent): string {
  const t = event.sessionTitle?.trim()
  if (!t) return ""
  const short = t.length > SESSION_TAG_MAX ? `${t.slice(0, SESSION_TAG_MAX)}…` : t
  return ` · ${short}`
}

function snapshotMd(s: SessionSnapshot): string {
  return [
    `**会话**：${s.title ?? s.id}`,
    `**消息数**：${s.messageCount ?? "?"}`,
    s.lastAssistantText ? `**最近回复**：\n${s.lastAssistantText.slice(0, 400)}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

/** 单个事件的（标题, 颜色, 正文, note, 额外按钮行） */
function cardParts(event: OutboundEvent): {
  title: string
  template: string
  body: string
  note?: string
  actions?: FeishuCard["elements"][number]
} {
  switch (event.kind) {
    case "share_open":
      return {
        title: "🟢 已开启分享",
        template: "blue",
        body: snapshotMd(event.session ?? { id: event.sessionID }),
        note: `session ${event.sessionID}`,
      }
    case "share_close":
      return { title: "⚪ 已断开分享", template: "grey", body: `原因：${event.reason}` }
    case "session_snapshot":
      return { title: "📋 会话快照", template: "blue", body: snapshotMd(event.snapshot) }
    case "task_started":
      return { title: "▶️ 任务开始执行", template: "blue", body: "agent 正在处理当前任务" }
    case "task_retry":
      return {
        title: "⏳ 模型限流，自动重试中",
        template: "orange",
        body: `${event.message}\n\n第 **${event.attempt}** 次重试，完成后会继续更新`,
      }
    case "task_completed":
      return { title: "✅ 任务完成", template: "green", body: event.summary ?? "（无文本输出）" }
    case "task_failed":
      return { title: "❌ 执行失败", template: "red", body: event.error ?? "unknown" }
    case "permission_requested":
      return {
        title: "⚠️ 等待权限审批",
        template: "orange",
        body: [
          `**权限**：${event.permission}`,
          event.title ? `**内容**：${event.title}` : null,
          "",
          `也可回复 **/approve**（一次）/ **/approve always** / **/deny**`,
        ]
          .filter(Boolean)
          .join("\n"),
        note: `requestID ${event.requestID}`,
        actions: permissionButtons(event.requestID),
      }
    case "question_asked": {
      const qs = event.questions as Array<{ question?: string; options?: Array<{ label: string }> }> | undefined
      const lines: string[] = []
      let actions: FeishuCard["elements"][number] | undefined
      for (let qi = 0; qi < (qs?.length ?? 0); qi++) {
        const q = qs![qi]!
        if (q.question) lines.push(q.question)
        const opts = (q.options ?? []).map((o) => o.label).filter(Boolean)
        if (opts.length) {
          if (qi === 0 && opts.length <= 6) {
            actions = {
              tag: "action",
              actions: opts.map((label, oi) => ({
                tag: "button",
                text: { tag: "plain_text", content: label },
                type: oi === 0 ? "primary" : "default",
                value: { kind: "question", requestID: event.requestID, label },
              })),
            }
          } else {
            lines.push(`选项：${opts.map((o) => `\`${o}\``).join(" / ")}`)
          }
        }
      }
      lines.push("", "点击按钮回答，或回复 **/answer <选项文本>**")
      return {
        title: "❓ Agent 需要你的回答",
        template: "orange",
        body: lines.join("\n"),
        note: `requestID ${event.requestID}`,
        actions,
      }
    }
    case "status":
      return { title: "ℹ️ 状态", template: "turquoise", body: event.text || "(empty)" }
    default:
      return { title: "ℹ️ 通知", template: "grey", body: "" }
  }
}

/** 渲染为一张或多张卡片（超长正文分段，标题带 (x/x) 与会话摘要） */
export function renderCards(event: OutboundEvent): FeishuCard[] {
  const { title, template, body, note, actions } = cardParts(event)
  const chunks = splitContent(body)
  const tag = sessionTag(event)
  return chunks.map((c, i) => {
    const page = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""
    const el: FeishuCard["elements"] = [{ tag: "markdown", content: escapeLarkMd(c) }]
    // 按钮行只放在最后一张分段卡上，保证点击时内容已完整
    if (actions && i === chunks.length - 1) el.push(actions)
    if (note) el.push({ tag: "hr" }, { tag: "note", elements: [{ tag: "plain_text", content: note }] })
    return {
      config: { wide_screen_mode: true },
      header: { template, title: { tag: "plain_text", content: `${title}${page}${tag}` } },
      elements: el,
    }
  })
}

/** 流式刷新卡（单张、单卡上限、可选光标） */
export function renderStreamingCard(title: string, body: string, template: string): FeishuCard {
  return card(template, title, body || "正在处理…")
}

/** 兼容保留：纯文本投影（标题 + 正文，mock/日志/测试场景） */
export function renderOutbound(event: OutboundEvent): string {
  const cards = renderCards(event)
  return cards
    .map((c) => {
      const body = c.elements
        .map((e) => ("content" in e ? e.content : "elements" in e ? e.elements.map((x) => x.content).join("") : ""))
        .join("\n")
      return [c.header.title.content, body].filter(Boolean).join("\n")
    })
    .join("\n---\n")
}

export function renderSnapshot(s: SessionSnapshot): string {
  return snapshotMd(s)
}
