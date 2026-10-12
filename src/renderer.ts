import type { OutboundEvent, SessionSnapshot } from "./types.js"

/**
 * 通知渲染：OutboundEvent → 飞书卡片（JSON 2.0，可能多张）。
 * - 原生 markdown / table 组件（表格真渲染）/ action 按钮（behaviors: callback + 内嵌 value）
 * - 超长内容自动分段为多张卡片，标题带 (x/x)；卡片标题尾部附加会话摘要
 * - 超大表格（>40 行）回退为对齐代码块
 * - 状态类通知不调用任何 LLM；默认不上传敏感内容（截断、不含环境变量/文件内容）
 */

export type FeishuButton = {
  tag: "button"
  text: { tag: "plain_text"; content: string }
  type?: string
  size?: string
  /**
   * JSON 2.0 官方写法：回调数据 value 必须内嵌在 behaviors 的 callback 声明里。
   * 顶层 value 是历史属性——一旦声明 behaviors，顶层 value 不再生效（点击无回调，实测确认）。
   */
  behaviors: Array<{ type: "callback"; value?: unknown }>
}

export type FeishuCardElement =
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | FeishuButton
  | FeishuForm
  | {
      tag: "table"
      page_size: number
      row_height: string
      columns: Array<{ name: string; display_name: string; data_type: string }>
      rows: Array<Record<string, string>>
    }

/** 表单容器（JSON 2.0）：只能置于卡片根级 body.elements；内嵌展示组件（markdown）+ 交互组件 */
export type FeishuForm = {
  tag: "form"
  name: string
  elements: Array<FeishuFormInput | FeishuFormSubmitButton | FeishuSelectStatic | { tag: "markdown"; content: string }>
}

/** 表单内输入框组件 */
export type FeishuFormInput = {
  tag: "input"
  /** 表单内唯一标识；提交回调的 form_value 以此为键 */
  name: string
  required?: boolean
  placeholder?: { tag: "plain_text"; content: string }
  max_length?: number
}

/** 表单内提交按钮（action_type: form_submit，无 behaviors） */
export type FeishuFormSubmitButton = {
  tag: "button"
  name: string
  action_type: "form_submit"
  text: { tag: "lark_md"; content: string }
  type?: string
  /** 随表单提交回调带回，用于识别业务 */
  value?: unknown
}

/** 表单内下拉选择组件（单选 select_static / 多选 multi_select_static；form_value 分别为 string / string[]） */
export type FeishuSelectStatic = {
  tag: "select_static" | "multi_select_static"
  /** 表单内唯一标识；提交回调的 form_value 以此为键 */
  name: string
  options: Array<{ text: { tag: "plain_text"; content: string }; value: string }>
  placeholder?: { tag: "plain_text"; content: string }
}

export type FeishuCard = {
  schema: "2.0"
  config: { update_multi: boolean }
  header: { title: { tag: "plain_text"; content: string }; template: string }
  body: { elements: FeishuCardElement[] }
}

/** 单张卡片 markdown 正文上限（字符） */
export const BODY_LIMIT = 1600
/** 单张卡片 markdown 正文上限（UTF-8 字节）：飞书按字节截断超长内容（实测纯中文 ~1K+ 字后截为 "…"） */
export const BODY_BYTE_LIMIT = 3000
/** 卡片标题中会话摘要的最大长度 */
const SESSION_TAG_MAX = 28
/** 超过该行数的表格回退为代码块 */
const TABLE_MAX_ROWS = 40
/** 表格按钮化的最大选项数 */
const QUESTION_BUTTON_MAX = 6
/** 表单下拉的最大选项数（超过则回退为输入框） */
const QUESTION_SELECT_MAX = 20

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
  extraElement?: FeishuCardElement,
): FeishuCard {
  // md 段内容内再做一次表格切分（上游按字符分段可能把表格留在 md 段里）
  const elements = bodySegments.flatMap((s) =>
    s.type === "md" ? segmentListToElements(splitTableSegments(s.content)) : segmentToElements(s),
  )
  if (extraElement) elements.push(extraElement)
  if (actions) elements.push(...actions)
  if (note) elements.push({ tag: "hr" }, { tag: "markdown", content: escapeLarkMd(note) })
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  }
}

/** 点击后把原卡片替换为已处理状态（按钮/表单不可再提交）；detail 为精简结果，operator 可选 */
export function renderProcessedCard(kind: string, detail: string, operator?: string): FeishuCard {
  return makeCard("grey", `✅ 已处理 · ${kind}`, [{ type: "md", content: operator ? `${detail}\n\n处理人：${operator}` : detail }])
}

/**
 * 「✍️ 其他答案」表单卡：点击其他答案按钮后，由卡片回调同步应答原地替换显示。
 * 用户在卡片输入框里填写回答并提交，form_value 随 card.action.trigger 回调带回，
 * 等效于发送 /answer <回答>（飞书不允许机器人预填用户聊天输入框，此为官方等效交互）。
 */
export const CUSTOM_ANSWER_INPUT_NAME = "custom_answer"

export function renderCustomAnswerFormCard(requestID: string): FeishuCard {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "✍️ 自定义回答" }, template: "grey" },
    body: {
      elements: [
        { tag: "markdown", content: "请输入你的回答并点击**提交回答**（等同发送 `/answer <回答>`）" },
        {
          tag: "form",
          name: `answer_form_${requestID}`,
          elements: [
            {
              tag: "input",
              name: CUSTOM_ANSWER_INPUT_NAME,
              required: true,
              placeholder: { tag: "plain_text", content: "请输入你的回答" },
              max_length: 1000,
            },
            {
              tag: "button",
              name: "submit_answer",
              action_type: "form_submit",
              text: { tag: "lark_md", content: "提交回答" },
              type: "primary",
              value: { kind: "question_form", requestID },
            },
          ],
        },
      ],
    },
  }
}

/** 权限审批按钮（JSON 2.0：button 直接作为 body 元素，不再使用 action 容器） */
function permissionButtons(requestID: string): FeishuCardElement[] {
  const btn = (content: string, type: string, reply: string): FeishuButton => ({
    tag: "button",
    text: { tag: "plain_text", content },
    type,
    size: "medium",
    behaviors: [{ type: "callback", value: { kind: "permission", requestID, reply } }],
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

/** 单个事件的（标题, 颜色, 正文, note, 额外按钮行, 额外表单元素） */
function cardParts(event: OutboundEvent): {
  title: string
  template: string
  body: string
  note?: string
  actions?: FeishuCardElement[]
  extraElement?: FeishuCardElement
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
    case "task_resumed":
      return { title: "💬 继续处理中", template: "blue", body: "已收到你的回答，agent 正在继续…" }
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
          event.patterns?.length ? `**路径**：${event.patterns.map((p) => `\`${p}\``).join("  ")}` : null,
          event.title ? `**内容**：${event.title}` : null,
          event.detail ? codeBlock(event.detail) : null,
          "",
          `也可回复 **/approve**（一次）/ **/approve always** / **/deny**`,
        ]
          .filter(Boolean)
          .join("\n"),
        note: `requestID ${event.requestID}`,
        actions: permissionButtons(event.requestID),
      }
    case "question_asked": {
      const qs = event.questions as
        | Array<{
            question?: string
            header?: string
            options?: Array<{ label?: string }>
            multiple?: boolean
            custom?: boolean
          }>
        | undefined
      const lines: string[] = []
      let actions: FeishuCardElement[] | undefined
      let extraElement: FeishuCardElement | undefined
      const normQs = (qs ?? []).map((q) => ({
        ...q,
        opts: (q.options ?? []).map((o) => o.label ?? "").filter(Boolean),
      }))
      const singleButtonable =
        normQs.length === 1 && !normQs[0]!.multiple && normQs[0]!.opts.length >= 1 && normQs[0]!.opts.length <= QUESTION_BUTTON_MAX
      if (singleButtonable) {
        // 单问题 + 单选 + 选项少：直接按钮（点即答，最快路径）
        const opts = normQs[0]!.opts
        if (normQs[0]!.question) lines.push(normQs[0]!.question)
        const mkBtn = (content: string, type: string, value: { kind: string; requestID: string; label?: string }): FeishuButton => ({
          tag: "button",
          text: { tag: "plain_text", content },
          type,
          size: "medium",
          behaviors: [{ type: "callback", value }],
        })
        const buttons: FeishuButton[] = opts.map((label, oi) =>
          mkBtn(label, oi === 0 ? "primary" : "default", { kind: "question", requestID: event.requestID, label }),
        )
        // 自定义答案入口：点击后原地变输入表单
        buttons.push(mkBtn("✍️ 其他答案", "default", { kind: "question_custom", requestID: event.requestID }))
        actions = buttons
      } else if (normQs.length > 0) {
        // 多问题 / 多选：表单（Q 题目与对应选择框交替排列，一次提交回答全部）
        const formElements: Array<FeishuFormInput | FeishuFormSubmitButton | FeishuSelectStatic | { tag: "markdown"; content: string }> = []
        for (let qi = 0; qi < normQs.length; qi++) {
          const q = normQs[qi]!
          const header = q.question || q.header || `问题 ${qi + 1}`
          formElements.push({ tag: "markdown", content: `**Q${qi + 1}. ${escapeLarkMd(header)}**${q.multiple === true ? "（可多选）" : ""}` })
          if (q.opts.length >= 1 && q.opts.length <= QUESTION_SELECT_MAX) {
            formElements.push({
              tag: q.multiple === true ? "multi_select_static" : "select_static",
              name: `q_${qi}`,
              options: q.opts.map((label) => ({ text: { tag: "plain_text", content: label }, value: label })),
              placeholder: { tag: "plain_text", content: q.multiple === true ? "可多选" : "请选择" },
            })
          } else if (q.opts.length > QUESTION_SELECT_MAX) {
            formElements.push({
              tag: "input",
              name: `q_${qi}`,
              placeholder: { tag: "plain_text", content: `选项过多，请直接输入：${q.opts.slice(0, 5).join(" / ")}…` },
            })
          }
        }
        formElements.push({
          tag: "button",
          name: "submit_answers",
          action_type: "form_submit",
          text: { tag: "lark_md", content: "提交回答" },
          type: "primary",
          value: { kind: "question_form_multi", requestID: event.requestID, count: normQs.length },
        })
        extraElement = { tag: "form", name: `answers_form_${event.requestID}`, elements: formElements }
        lines.push("下拉选择后点**提交回答**，可留空跳过；或回复 **/answer <选项>**")
      } else {
        lines.push("(无问题内容)", "", "回复 **/answer <答案>**")
      }
      if (!extraElement) lines.push("", "点击按钮回答，或回复 **/answer <选项文本>**")
      return {
        title: "❓ Agent 需要你的回答",
        template: "orange",
        body: lines.join("\n"),
        note: `requestID ${event.requestID}`,
        actions,
        extraElement,
      }
    }
    case "status":
      return { title: "ℹ️ 状态", template: "turquoise", body: event.text || "(empty)" }
    case "tui_input":
      return { title: "👤 TUI 输入", template: "turquoise", body: event.text || "(empty)" }
    default:
      return { title: "ℹ️ 通知", template: "grey", body: "" }
  }
}

/** 按码点切字符串，保证每段 UTF-8 字节数不超过 maxBytes（不切断多字节字符） */
function sliceByBytes(s: string, maxBytes: number): string[] {
  if (maxBytes <= 0) return [s]
  const parts: string[] = []
  let cur = ""
  let curBytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8")
    if (curBytes + b > maxBytes && cur) {
      parts.push(cur)
      cur = ""
      curBytes = 0
    }
    cur += ch
    curBytes += b
  }
  if (cur) parts.push(cur)
  return parts.length > 0 ? parts : [s]
}

/** 先按字符上限切，再对超字节的段按字节细分 */
function sliceHard(text: string, limit: number, byteLimit: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += limit) {
    out.push(...sliceByBytes(text.slice(i, i + limit), byteLimit))
  }
  return out.length > 0 ? out : [text]
}

/** 按行聚合分段；单行超限做字符硬切；保证每段不超过字符与字节上限 */
export function splitContent(body: string, limit = BODY_LIMIT): string[] {
  if (body.length <= limit && Buffer.byteLength(body, "utf8") <= BODY_BYTE_LIMIT) return [body]
  const chunks: string[] = []
  let cur = ""
  const push = () => {
    if (cur) chunks.push(cur)
    cur = ""
  }
  for (const line of body.split("\n")) {
    if (line.length > limit || Buffer.byteLength(line, "utf8") > BODY_BYTE_LIMIT) {
      push()
      chunks.push(...sliceHard(line, limit, BODY_BYTE_LIMIT))
      continue
    }
    const nextLen = cur.length + line.length + 1
    const nextBytes = Buffer.byteLength(cur, "utf8") + Buffer.byteLength(line, "utf8") + 1
    if (nextLen > limit || nextBytes > BODY_BYTE_LIMIT) push()
    cur = cur ? `${cur}\n${line}` : line
  }
  push()
  return chunks.length > 0 ? chunks : [body.slice(0, limit)]
}

/** 流式卡中间刷新用：超长时保留尾部、以省略号标记前文略（整卡不超上限） */
export function cardTail(text: string): string {
  if (text.length <= BODY_LIMIT && Buffer.byteLength(text, "utf8") <= BODY_BYTE_LIMIT) return text
  const tail = sliceByBytes(text, BODY_BYTE_LIMIT - 4).at(-1) ?? text
  return `…\n${tail}`
}

/** 渲染为一张或多张卡片（超长正文分段，标题带 (x/x) 与会话摘要） */
export function renderCards(event: OutboundEvent): FeishuCard[] {
  const { title, template, body, note, actions, extraElement } = cardParts(event)
  const chunks = splitContent(body)
  const tag = sessionTag(event)
  return chunks.map((c, i) => {
    const page = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""
    // 按钮行/表单只放在最后一张分段卡上，保证点击时内容已完整
    return makeCard(
      template,
      `${title}${page}${tag}`,
      [{ type: "md", content: c }],
      i === chunks.length - 1 ? note : undefined,
      i === chunks.length - 1 ? actions : undefined,
      i === chunks.length - 1 ? extraElement : undefined,
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
