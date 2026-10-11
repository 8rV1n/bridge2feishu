import { test } from "node:test"
import assert from "node:assert/strict"
import { parseFeishuCommand } from "../dist/router.js"
import { renderCards as renderCardMulti, renderOutbound as renderOutboundText, convertMarkdownTables, HELP_TEXT } from "../dist/renderer.js"
import { ReplayGuard } from "../dist/transport/lark.js"
import type { OutboundEvent } from "../dist/types.js"

// ---------- parseFeishuCommand ----------

test("router: /status /recent /stop /disconnect", () => {
  assert.deepEqual(parseFeishuCommand("/status"), { action: "status" })
  assert.deepEqual(parseFeishuCommand("/recent"), { action: "recent" })
  assert.deepEqual(parseFeishuCommand("/stop"), { action: "abort" })
  assert.deepEqual(parseFeishuCommand("/disconnect"), { action: "stop" })
  assert.deepEqual(parseFeishuCommand("/HELP"), { action: "help" })
})

test("router: /run and /steer with text and delivery", () => {
  assert.deepEqual(parseFeishuCommand("/run fix the bug"), { action: "prompt", text: "fix the bug", delivery: "queue" })
  assert.deepEqual(parseFeishuCommand("/steer fix now"), { action: "prompt", text: "fix now", delivery: "steer" })
  assert.equal(parseFeishuCommand("/run"), null)
  assert.equal(parseFeishuCommand("/run   "), null)
})

test("router: mention stripping", () => {
  const mentions = [{ key: "@_user_1", id: { open_id: "ou_x" } }]
  assert.deepEqual(parseFeishuCommand("@_user_1 /status", mentions), { action: "status" })
  assert.deepEqual(parseFeishuCommand("@_user_1 /run do it", mentions), { action: "prompt", text: "do it", delivery: "queue" })
})

test("router: plain text is treated as a prompt (like typing in TUI)", () => {
  assert.deepEqual(parseFeishuCommand("hello world"), { action: "prompt", text: "hello world", delivery: "queue" })
  assert.deepEqual(parseFeishuCommand("  fix the login bug  "), { action: "prompt", text: "fix the login bug", delivery: "queue" })
  assert.equal(parseFeishuCommand(""), null)
  assert.equal(parseFeishuCommand("   "), null)
})

test("router: unknown slash commands are ignored", () => {
  assert.equal(parseFeishuCommand("/unknowncmd"), null)
  assert.equal(parseFeishuCommand("/run2 hi"), null)
})

test("router: /approve and /deny variants", () => {
  assert.deepEqual(parseFeishuCommand("/approve"), { action: "permission_reply", requestID: "#latest", reply: "once" })
  assert.deepEqual(parseFeishuCommand("/approve always"), { action: "permission_reply", requestID: "#latest", reply: "always" })
  assert.deepEqual(parseFeishuCommand("/approve 2"), { action: "permission_reply", requestID: "#2", reply: "once" })
  assert.deepEqual(parseFeishuCommand("/approve 3 always"), { action: "permission_reply", requestID: "#3", reply: "always" })
  assert.deepEqual(parseFeishuCommand("/deny"), { action: "permission_reply", requestID: "#latest", reply: "reject" })
  assert.deepEqual(parseFeishuCommand("/deny 1"), { action: "permission_reply", requestID: "#1", reply: "reject" })
})

test("router: /answer", () => {
  assert.deepEqual(parseFeishuCommand("/answer Option A"), { action: "question_reply", requestID: "#latest", answers: ["Option A"] })
  assert.equal(parseFeishuCommand("/answer"), null)
})

// ---------- outbound text rendering (compat wrapper) ----------

test("renderer: share_open includes snapshot", () => {
  const text = renderOutboundText({
    kind: "share_open",
    sessionID: "s1",
    chatID: "c1",
    session: { id: "s1", title: "T", messageCount: 3, status: "idle" },
  })
  assert.ok(text.includes("已开启分享"))
  assert.ok(text.includes("T"))
})

test("renderer: task states", () => {
  assert.ok(renderOutboundText({ kind: "task_started", sessionID: "s", chatID: "c" }).includes("任务开始"))
  assert.ok(renderOutboundText({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "done" }).includes("done"))
  assert.ok(renderOutboundText({ kind: "task_failed", sessionID: "s", chatID: "c", error: "boom" }).includes("boom"))
})

test("renderer: long summaries are segmented into multiple cards (lossless)", () => {
  const cards = renderCardMulti({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "x".repeat(2000), sessionTitle: "S" })
  assert.ok(cards.length >= 2)
  // 无损：所有分段拼接还原原文
  const joined = cards
    .map((c) => (c.elements[0] as { content: string }).content)
    .join("")
  assert.equal(joined.replace(/\n/g, ""), "x".repeat(2000))
  for (let i = 0; i < cards.length; i++) {
    assert.ok(cards[i]!.header.title.content.includes(`(${i + 1}/${cards.length})`))
    assert.ok(cards[i]!.header.title.content.includes("S"))
  }
})

test("renderer: permission card mentions approve/deny and ordinal", () => {
  const text = renderOutboundText({
    kind: "permission_requested",
    sessionID: "s",
    chatID: "c",
    requestID: "per_1",
    permission: "bash",
    title: "rm -rf /",
    ordinal: 2,
  })
  assert.ok(text.includes("/approve"))
  assert.ok(text.includes("/deny"))
  assert.ok(text.includes("bash"))
})

test("renderer: question card renders option buttons (<=6) or text fallback (>6)", () => {
  const cards = renderCardMulti({
    kind: "question_asked",
    sessionID: "s",
    chatID: "c",
    requestID: "q_1",
    questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
  })
  const actions = cards[0]!.elements.find((e) => e.tag === "action") as
    | { actions: Array<{ text: { content: string }; value: { kind: string; requestID: string; label: string } }> }
    | undefined
  assert.ok(actions, "should have button row")
  assert.equal(actions.actions.length, 2)
  assert.equal(actions.actions[0]!.text.content, "A")
  assert.equal(actions.actions[0]!.value.kind, "question")
  assert.equal(actions.actions[0]!.value.requestID, "q_1")
  assert.ok(JSON.stringify(cards[0]).includes("/answer"))

  const cards2 = renderCardMulti({
    kind: "question_asked",
    sessionID: "s",
    chatID: "c",
    requestID: "q_2",
    questions: [{ question: "Pick", options: Array.from({ length: 8 }, (_, i) => ({ label: `opt${i}` })) }],
  })
  const text2 = renderOutboundText({ ...cards2, kind: "question_asked", sessionID: "s", chatID: "c", requestID: "q_2", questions: [] } as never)
  const fallback = cards2[0]!.elements.find((e) => e.tag === "action")
  assert.equal(fallback, undefined, ">6 options should fall back to text")
})

test("renderer: no secrets in output", () => {
  const text = renderOutboundText({
    kind: "share_open",
    sessionID: "s1",
    chatID: "c1",
    session: { id: "s1", title: "t" },
  })
  assert.ok(!text.toLowerCase().includes("app_secret"))
  assert.ok(!text.toLowerCase().includes("api_key"))
  assert.ok(HELP_TEXT.includes("/status"))
})

// ---------- ReplayGuard ----------

test("replay guard: dedups repeated ids", () => {
  const g = new ReplayGuard()
  assert.equal(g.first("e1"), true)
  assert.equal(g.first("e1"), false)
  assert.equal(g.first("e2"), true)
  assert.equal(g.first(undefined), true)
})

// ---------- Card rendering ----------

test("renderer: card carries header template and markdown body", () => {
  const cards = renderCardMulti({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "# 结果\n- ok" })
  assert.equal(cards.length, 1)
  const card = cards[0]!
  assert.equal(card.header.template, "green")
  const md = card.elements[0] as { tag: string; content: string }
  assert.equal(md.tag, "markdown")
  assert.ok(md.content.includes("结果"))
})

test("renderer: failure card is red, permission card is orange", () => {
  assert.equal(renderCardMulti({ kind: "task_failed", sessionID: "s", chatID: "c", error: "boom" })[0]!.header.template, "red")
  assert.equal(
    renderCardMulti({ kind: "permission_requested", sessionID: "s", chatID: "c", requestID: "p1", permission: "bash" })[0]!.header.template,
    "orange",
  )
})

test("renderer: escapes {{ to avoid card variable injection", () => {
  const cards = renderCardMulti({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "{{ x }}" })
  const md = cards[0]!.elements[0] as { content: string }
  assert.ok(!md.content.includes("{{"))
  assert.ok(md.content.includes("{ {"))
})

test("renderer: oversized body is hard-split, each card within limit", () => {
  const cards = renderCardMulti({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "x".repeat(5000) })
  assert.ok(cards.length >= 3)
  for (const c of cards) {
    const md = c.elements[0] as { content: string }
    assert.ok(md.content.length <= 1700)
  }
})

test("replay guard: LRU eviction at capacity", () => {
  const g = new ReplayGuard(3)
  g.first("a")
  g.first("b")
  g.first("c")
  g.first("d") // evicts "a"
  assert.equal(g.size, 3)
  assert.equal(g.first("a"), true) // a was evicted -> allowed again
  // re-adding "a" evicts "b", so "c" and "d" are still remembered
  assert.equal(g.first("c"), false)
  assert.equal(g.first("d"), false)
})

// ---------- segmentation & session tag ----------

import { splitContent } from "../dist/renderer.js"
import type { OutboundEvent as OutboundEventT } from "../dist/types.js"

test("renderer: splitContent aggregates lines and hard-splits oversized lines", () => {
  const body = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n")
  const chunks = splitContent(body, 500)
  assert.equal(chunks.join("\n"), body) // 无损
  for (const c of chunks) assert.ok(c.length <= 520)
  assert.ok(chunks.length > 1)
})

test("renderer: hard-splits a single line longer than limit", () => {
  const chunks = splitContent("y".repeat(3000), 1000)
  assert.equal(chunks.join(""), "y".repeat(3000))
  for (const c of chunks) assert.ok(c.length <= 1000)
})

test("renderer: long summary produces multiple cards with (x/x) and session tag", () => {
  const ev: OutboundEventT = {
    kind: "task_completed",
    sessionID: "s1",
    chatID: "c1",
    summary: Array.from({ length: 400 }, (_, i) => `段落第 ${i} 行的内容补充说明文字`).join("\n\n"),
    sessionTitle: "Test message check-in",
  }
  const cards = renderCardMulti(ev)
  assert.ok(cards.length >= 2)
  for (let i = 0; i < cards.length; i++) {
    assert.ok(cards[i]!.header.title.content.includes(`(${i + 1}/${cards.length})`))
    assert.ok(cards[i]!.header.title.content.includes("Test message check-in"))
  }
})

test("renderer: short events keep single card without (x/x) but with session tag", () => {
  const cards = renderCardMulti({
    kind: "task_started",
    sessionID: "s1",
    chatID: "c1",
    sessionTitle: "My Session",
  })
  assert.equal(cards.length, 1)
  assert.ok(!cards[0]!.header.title.content.includes("(1/1)"))
  assert.ok(cards[0]!.header.title.content.includes("My Session"))
})

test("renderer: share_open card keeps sessionID note", () => {
  const cards = renderCardMulti({ kind: "share_open", sessionID: "ses_abc", chatID: "c1", session: { id: "ses_abc", title: "T" } })
  const noteEl = cards[0]!.elements.find((e) => e.tag === "note") as { elements: Array<{ content: string }> } | undefined
  assert.ok(noteEl?.elements[0]!.content.includes("ses_abc"))
})

// ---------- markdown table conversion ----------

test("renderer: markdown tables convert to aligned code blocks (lark_md has no table support)", () => {
  const body = [
    "前置说明",
    "",
    "| 模型 | 费用 | 状态 |",
    "|---|---|---|",
    "| glm-5-3-flash | $0.0037 | idle |",
    "| gpt-x | $0.12 | busy |",
    "",
    "后置说明",
  ].join("\n")
  const out = convertMarkdownTables(body)
  assert.ok(out.includes("```text"))
  assert.ok(out.includes("模型"), "header preserved")
  assert.ok(out.includes("glm-5-3-flash"))
  assert.ok(out.includes("─"), "header separator line added")
  assert.ok(!out.includes("|---|"), "separator row removed")
  // 对齐：同一列的单元格起点一致（用显示宽度验证）
  const blockLines = out.split("\n").filter((l) => l.includes("glm-5-3-flash") || l.includes("gpt-x"))
  const g1 = blockLines[0]!.indexOf("$0.0037")
  const g2 = blockLines[1]!.indexOf("$0.12")
  assert.equal(g1, g2, "columns aligned")
  // 非表格行不受影响
  assert.ok(out.includes("前置说明"))
  assert.ok(out.includes("后置说明"))
})

test("renderer: CJK cells are double-width padded", () => {
  const out = convertMarkdownTables(["| 名称 | 值 |", "|---|---|", "| 长名称单元格 | 1 |", "| 短 | 22 |"].join("\n"))
  const dataLines = out.split("\n").filter((l) => l.includes("长名称单元格") || l.startsWith("短"))
  assert.equal(dataLines.length, 2)
  // 第二列在"显示宽度"上对齐（CJK 记 2）：第二列内容的显示宽度起点一致
  const prefixWidth = (line: string, marker: string): number => {
    const idx = line.indexOf(marker)
    const prefix = line.slice(0, idx)
    let w = 0
    for (const ch of prefix) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1
    return w
  }
  assert.equal(prefixWidth(dataLines[0]!, "1"), prefixWidth(dataLines[1]!, "22"))
})
