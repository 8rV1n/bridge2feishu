import type { OutboundEvent, SessionSnapshot } from "./types.js"

/**
 * 通知渲染：OutboundEvent → 飞书卡片（**JSON 1.0 结构**，可能多张）。
 *
 * 重要：使用 1.0 而非 2.0 —— 实测（2026-10-11，受控实验）本租户对 2.0 卡片的
 * 按钮回调（behaviors: callback）不推送事件（1.0 正常），因此按钮交互依赖 1.0。
 * - 按钮：action 容器 + value（1.0 回调已验证）
 * - 表格：1.0 无表格组件 → markdown 表格转换为等宽对齐代码块（CJK=2）
 * - note/hr：1.0 支持
 * - 超长内容自动分段多张卡片，标题带 (x/x) 与会话摘要
 * - 状态类通知不调用任何 LLM；默认不上传敏感内容
 */

export type FeishuButton = {
  tag: "button"
  text: { tag: "plain_text"; content: string }
  type?: string
  value: unknown
}

export type FeishuCardElement =
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | { tag: "note"; elements: Array<{ tag: "plain_text"; content: string }> }
  | { tag: "action"; actions: FeishuButton[] }

export type FeishuCard = {
  config: { wide_screen_mode: boolean }
  header: { title: { tag: "plain_text"; content: string }; template: string }
  elements: FeishuCardElement[]
}

/** 单张卡片 markdown 正文上限（字符） */
const BODY_LIMIT = 1600
/** 卡片标题中会话摘要的最大长度 */
const SESSION_TAG_MAX = 28
/** 超过该行数的表格保留为代码块的分段上限（安全值） */
const TABLE_MAX_LINES = 60
/** 表格按钮化的最大选项数 */
const QUESTION_BUTTON_MAX = 6

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

// ---------- 表格：markdown → 等宽对齐代码块（1.0 无表格组件） ----------

function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1
  return w
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line)
const isTableSeparator = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line)

export function convertMarkdownTables(body: string): string {
  const lines = body.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows: string[][] = [parseTableRow(line)]
      i += 2
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!))
        i++
      }
      const colCount = Math.max(...rows.map((r) => r.length))
      const widths: number[] = Array.from({ length: colCount }, (_, c) =>
        Math.max(...rows.map((r) => displayWidth(r[c] ?? ""))),
      )
      const fmt = (row: string[]): string =>
        row.map((cell, c) => (cell ?? "") + " ".repeat(Math.max(0, (widths[c] ?? 0) - displayWidth(cell ?? "")))).join("  ").trimEnd()
      const block = [
        fmt(rows[0] ?? []),
        rows.slice(1).map(() => "─".repeat(Math.max(4, widths.reduce((a, b) => a + b, 0) + (colCount - 1) * 2))).join("  "),
        ...rows.slice(1).map((r) => fmt(r)),
      ]
      out.push("```text", ...block.slice(0, TABLE_MAX_LINES), "```")
      continue
    }
    out.push(line)
    i++
  }
  return out.join("\n")
}

/** 代码块内的 `{{` 同样需要转义 */
function codeBlock(text: string): string {
  return ["```text", escapeLarkMd(text), "```"].join("\n")
}

// ---------- 通用卡片构造 ----------

function card(template: string, title: string, body: string, note?: string, actions?: FeishuButton[]): FeishuCard {
  const elements: FeishuCardElement[] = [{ tag: "markdown", content: escapeLarkMd(convertMarkdownTables(body)) }]
  if (actions) elements.push({ tag: "action", actions })
  if (note) elements.push({ tag: "hr" }, { tag: "note", elements: [{ tag: "plain_text", content: note }] })
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements,
  }
}

/** 点击后把原卡片替换为已处理状态 */
export function renderProcessedCard(kind: string, detail: string, operator: string): FeishuCard {
  return card("grey", `✅ 已处理 · ${kind}`, `${detail}\n\n处理人：${operator}`)
}

/** 权限审批按钮（1.0：value 直接触发回调，无需 behaviors） */
function permissionButtons(requestID: string): FeishuButton[] {
  const btn = (content: string, type: string, reply: string): FeishuButton => ({
    tag: "button",
    text: { tag: "plain_text", content },
    type,
    value: { kind: "permission", requestID, reply },
  })
  return [btn("批准一次", "primary", "once"), btn("永久批准", "default", "always"), btn("拒绝", "danger", "reject")]
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
  actions?: FeishuButton[]
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
      let actions: FeishuButton[] | undefined
      for (let qi = 0; qi < (qs?.length ?? 0); qi++) {
        const q = qs![qi]!
        if (q.question) lines.push(q.question)
        const opts = (q.options ?? []).map((o) => o.label).filter(Boolean)
        if (opts.length) {
          if (qi === 0 && opts.length <= QUESTION_BUTTON_MAX) {
            const buttons: FeishuButton[] = opts.map((label, oi) => ({
              tag: "button",
              text: { tag: "plain_text", content: label },
              type: oi === 0 ? "primary" : "default",
              value: { kind: "question", requestID: event.requestID, label },
            }))
            // 自定义答案入口：点击后提示用 /answer 文本回复
            buttons.push({
              tag: "button",
              text: { tag: "plain_text", content: "✍️ 其他答案" },
              type: "default",
              value: { kind: "question_custom", requestID: event.requestID },
            })
            actions = buttons
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

/** 渲染为一张或多张卡片（超长正文分段，标题带 (x/x) 与会话摘要） */
export function renderCards(event: OutboundEvent): FeishuCard[] {
  const { title, template, body, note, actions } = cardParts(event)
  const chunks = splitContent(body)
  const tag = sessionTag(event)
  return chunks.map((c, i) => {
    const page = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""
    // 按钮行只放在最后一张分段卡上，保证点击时内容已完整
    return card(
      template,
      `${title}${page}${tag}`,
      c,
      i === chunks.length - 1 ? note : undefined,
      i === chunks.length - 1 ? actions : undefined,
    )
  })
}

/** 流式刷新卡（单张） */
export function renderStreamingCard(title: string, body: string, template: string): FeishuCard {
  return card(template, title, body || "正在处理…")
}

/** 兼容保留：纯文本投影（标题 + 正文，mock/日志/测试场景） */
export function renderOutbound(event: OutboundEvent): string {
  const cards = renderCards(event)
  return cards
    .map((c) => {
      const body = c.elements
        .map((e) => {
          if (e.tag === "markdown") return e.content
          if (e.tag === "note") return e.elements.map((x) => x.content).join("")
          if (e.tag === "action") return e.actions.map((b) => b.text.content).join(" / ")
          return ""
        })
        .join("\n")
      return [c.header.title.content, body].filter(Boolean).join("\n")
    })
    .join("\n---\n")
}

export function renderSnapshot(s: SessionSnapshot): string {
  return snapshotMd(s)
}
