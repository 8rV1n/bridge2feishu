import type { OutboundEvent, SessionSnapshot } from "./types.js"

/**
 * 通知渲染：OutboundEvent → 飞书卡片（JSON 2.0，可能多张）。
 * - 原生 markdown / table 组件（表格真渲染）/ action 按钮（behaviors: callback）
 * - 超长内容自动分段为多张卡片，标题带 (x/x)；卡片标题尾部附加会话摘要
 * - 超大表格（>40 行）回退为对齐代码块
 * - 状态类通知不调用任何 LLM；默认不上传敏感内容（截断、不含环境变量/文件内容）
 */

export type FeishuButton = {
  tag: "button"
  text: { tag: "plain_text"; content: string }
  type?: string
  size?: string
  behaviors: Array<{ type: "callback" }>
  value: unknown
}

export type FeishuCardElement =
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | FeishuButton
  | {
      tag: "table"
      page_size: number
      row_height: string
      columns: Array<{ name: string; display_name: string; data_type: string }>
      rows: Array<Record<string, string>>
    }

export type FeishuCard = {
  schema: "2.0"
  config: { update_multi: boolean }
  header: { title: { tag: "plain_text"; content: string }; template: string }
  body: { elements: FeishuCardElement[] }
}

/** 单张卡片 markdown 正文上限（字符） */
const BODY_LIMIT = 1600
/** 卡片标题中会话摘要的最大长度 */
const SESSION_TAG_MAX = 28
/** 超过该行数的表格回退为代码块 */
const TABLE_MAX_ROWS = 40
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

// ---------- 表格解析（markdown → 原生 table 组件 / 超大回退代码块） ----------

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

type Segment = { type: "md"; content: string } | { type: "table"; rows: string[][] }

/** 把正文切分为 markdown 段与表格段 */
function splitTableSegments(body: string): Segment[] {
  const lines = body.split("\n")
  const out: Segment[] = []
  let md: string[] = []
  const flushMd = () => {
    if (md.length > 0) {
      out.push({ type: "md", content: md.join("\n") })
      md = []
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      flushMd()
      const rows: string[][] = [parseTableRow(line)]
      i += 2
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!))
        i++
      }
      out.push({ type: "table", rows })
      continue
    }
    md.push(line)
    i++
  }
  flushMd()
  return out
}

/** 超大表格回退：等宽对齐代码块（CJK=2） */
function tableToCodeBlock(rows: string[][]): string {
  const colCount = Math.max(...rows.map((r) => r.length))
  const widths: number[] = Array.from({ length: colCount }, (_, c) =>
    Math.max(...rows.map((r) => displayWidth(r[c] ?? ""))),
  )
  const fmt = (row: string[]): string => row.map((cell, c) => (cell ?? "") + " ".repeat(Math.max(0, (widths[c] ?? 0) - displayWidth(cell ?? "")))).join("  ").trimEnd()
  return ["```text", fmt(rows[0] ?? []), ...rows.slice(1).map((r) => fmt(r)), "```"].join("\n")
}

/** 代码块内的 `{{` 同样需要转义，避免触发卡片变量 */
function codeBlock(text: string): string {
  return ["```text", escapeLarkMd(text), "```"].join("\n")
}

function segmentToElements(seg: Segment): FeishuCardElement[] {
  if (seg.type === "md") {
    const content = escapeLarkMd(seg.content.trim())
    return content ? [{ tag: "markdown", content }] : []
  }
  const rows = seg.rows
  if (rows.length < 2) {
    // 只有表头（流式中常见）或空表 → 单行 markdown
    return rows.length === 1 ? [{ tag: "markdown", content: codeBlock(rows[0]!.join("  ")) }] : []
  }
  if (rows.length - 1 > TABLE_MAX_ROWS) {
    return [{ tag: "markdown", content: codeBlock(tableToCodeBlock(rows)) }]
  }
  const header = rows[0]!
  const columns = header.map((h, i) => ({ name: `c${i}`, display_name: h || `列 ${i + 1}`, data_type: "text" }))
  const dataRows = rows.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? ""])))
  return [
    {
      tag: "table",
      page_size: 10,
      row_height: "low",
      columns,
      rows: dataRows,
    },
  ]
}

function segmentListToElements(segments: Segment[]): FeishuCardElement[] {
  return segments.flatMap((s) => segmentToElements(s))
}

// ---------- 通用卡片构造 ----------

function makeCard(
  template: string,
  title: string,
  bodySegments: Segment[],
  note?: string,
  actions?: FeishuCardElement[],
): FeishuCard {
  // md 段内容内再做一次表格切分（上游按字符分段可能把表格留在 md 段里）
  const elements = bodySegments.flatMap((s) =>
    s.type === "md" ? segmentListToElements(splitTableSegments(s.content)) : segmentToElements(s),
  )
  if (actions) elements.push(...actions)
  if (note) elements.push({ tag: "hr" }, { tag: "markdown", content: escapeLarkMd(note) })
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  }
}

/** 点击后把原卡片替换为已处理状态（按钮不可再点） */
export function renderProcessedCard(kind: string, detail: string, operator: string): FeishuCard {
  return makeCard("grey", `✅ 已处理 · ${kind}`, [{ type: "md", content: `${detail}\n\n处理人：${operator}` }])
}

/** 权限审批按钮（JSON 2.0：button 直接作为 body 元素，不再使用 action 容器） */
function permissionButtons(requestID: string): FeishuCardElement[] {
  const btn = (content: string, type: string, reply: string): FeishuButton => ({
    tag: "button",
    text: { tag: "plain_text", content },
    type,
    size: "medium",
    behaviors: [{ type: "callback" }],
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
  actions?: FeishuCardElement[]
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
      const qs = event.questions as Array<{ question?: string; options?: Array<{ label: string }>; custom?: boolean }> | undefined
      const lines: string[] = []
      let actions: FeishuCardElement[] | undefined
      for (let qi = 0; qi < (qs?.length ?? 0); qi++) {
        const q = qs![qi]!
        if (q.question) lines.push(q.question)
        const opts = (q.options ?? []).map((o) => o.label).filter(Boolean)
        if (opts.length) {
          if (qi === 0 && opts.length <= QUESTION_BUTTON_MAX) {
            const mkBtn = (content: string, type: string, value: { kind: string; requestID: string; label?: string }): FeishuButton => ({
              tag: "button",
              text: { tag: "plain_text", content },
              type,
              size: "medium",
              behaviors: [{ type: "callback" }],
              value,
            })
            const buttons: FeishuButton[] = opts.map((label, oi) =>
              mkBtn(label, oi === 0 ? "primary" : "default", { kind: "question", requestID: event.requestID, label }),
            )
            // 自定义答案入口：点击后提示用 /answer 文本回复
            buttons.push(mkBtn("✍️ 其他答案", "default", { kind: "question_custom", requestID: event.requestID }))
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
    return makeCard(
      template,
      `${title}${page}${tag}`,
      [{ type: "md", content: c }],
      i === chunks.length - 1 ? note : undefined,
      i === chunks.length - 1 ? actions : undefined,
    )
  })
}

/** 流式刷新卡（单张） */
export function renderStreamingCard(title: string, body: string, template: string): FeishuCard {
  return makeCard(template, title, [{ type: "md", content: body || "正在处理…" }])
}

/** 兼容保留：纯文本投影（标题 + 正文，mock/日志/测试场景） */
export function renderOutbound(event: OutboundEvent): string {
  const cards = renderCards(event)
  return cards
    .map((c) => {
      const body = c.body.elements
        .map((e) => {
          if (e.tag === "markdown") return e.content
          if (e.tag === "table") return e.columns.map((col) => col.display_name).join(" | ")
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
