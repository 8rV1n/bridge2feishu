import { test } from "node:test"
import assert from "node:assert/strict"
import { parseFeishuCommand } from "../dist/router.js"
import { renderCards as renderCardMulti, renderOutbound as renderOutboundText, HELP_TEXT } from "../dist/renderer.js"
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

test("renderer: question card lists options", () => {
  const text = renderOutboundText({
    kind: "question_asked",
    sessionID: "s",
    chatID: "c",
    requestID: "q_1",
    questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
  })
  assert.ok(text.includes("Which?"))
  assert.ok(text.includes("`A` / `B`"))
  assert.ok(text.includes("/answer"))
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
