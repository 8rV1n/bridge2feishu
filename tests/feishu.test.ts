import { test } from "node:test"
import assert from "node:assert/strict"
import { parseFeishuCommand } from "../dist/router.js"
import { renderOutbound, HELP_TEXT } from "../dist/renderer.js"
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

test("router: plain text and unknown slash are ignored", () => {
  assert.equal(parseFeishuCommand("hello world"), null)
  assert.equal(parseFeishuCommand("/unknowncmd"), null)
  assert.equal(parseFeishuCommand(""), null)
  assert.equal(parseFeishuCommand("   "), null)
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

// ---------- renderOutbound ----------

test("renderer: share_open includes snapshot", () => {
  const text = renderOutbound({
    kind: "share_open",
    sessionID: "s1",
    chatID: "c1",
    session: { id: "s1", title: "T", messageCount: 3, status: "idle" },
  })
  assert.ok(text.includes("已开启分享"))
  assert.ok(text.includes("T"))
})

test("renderer: task states", () => {
  assert.ok(renderOutbound({ kind: "task_started", sessionID: "s", chatID: "c" }).includes("任务开始"))
  assert.ok(renderOutbound({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "done" }).includes("done"))
  assert.ok(renderOutbound({ kind: "task_failed", sessionID: "s", chatID: "c", error: "boom" }).includes("boom"))
})

test("renderer: truncates long summaries", () => {
  const text = renderOutbound({ kind: "task_completed", sessionID: "s", chatID: "c", summary: "x".repeat(2000) })
  assert.ok(text.length < 900)
  assert.ok(text.endsWith("…"))
})

test("renderer: permission card mentions approve/deny and ordinal", () => {
  const text = renderOutbound({
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
  const text = renderOutbound({
    kind: "question_asked",
    sessionID: "s",
    chatID: "c",
    requestID: "q_1",
    questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }],
  })
  assert.ok(text.includes("Which?"))
  assert.ok(text.includes("A / B"))
  assert.ok(text.includes("/answer"))
})

test("renderer: no secrets in output", () => {
  const text = renderOutbound({
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
