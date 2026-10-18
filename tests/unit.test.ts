import { test } from "node:test"
import assert from "node:assert/strict"
import { ShareStateManager } from "../dist/share-state.js"
import { Security } from "../dist/security.js"
import { MockTransport } from "../dist/transport/mock.js"
import { lastAssistantText, summarize, textOfMessage } from "../dist/session.js"
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../dist/config.js"
import type { InboundCommand } from "../dist/types.js"

// ---------- ShareStateManager（多 session 语义） ----------

test("share state: default unshared", () => {
  const s = new ShareStateManager()
  assert.equal(s.status, "unshared")
  assert.equal(s.current, null)
  assert.equal(s.count, 0)
})

test("share state: first share becomes active", () => {
  const s = new ShareStateManager()
  const r = s.share("ses_a", "chat_1")
  assert.equal(r.ok, true)
  assert.equal((r as { isActive: boolean }).isActive, true)
  assert.equal(s.status, "shared")
  assert.equal(s.current?.sessionID, "ses_a")
  assert.equal(s.isShared("ses_a"), true)
  assert.equal(s.isShared("ses_b"), false)
})

test("share state: duplicate share of same target is idempotent", () => {
  const s = new ShareStateManager()
  s.share("ses_a", "chat_1")
  const r = s.share("ses_a", "chat_1")
  assert.equal(r.ok, true)
  assert.equal((r as { already: boolean }).already, true)
  assert.equal((r as { isActive: boolean }).isActive, true)
  assert.equal(s.count, 1)
})

test("share state: second share does not steal active", () => {
  const s = new ShareStateManager()
  s.share("ses_a", "chat_1")
  const r = s.share("ses_b", "chat_1")
  assert.equal(r.ok, true)
  assert.equal((r as { isActive: boolean }).isActive, false)
  assert.equal(s.current?.sessionID, "ses_a", "active must stay on first shared session")
  assert.equal(s.count, 2)
  assert.deepEqual(s.list().map((t) => t.sessionID), ["ses_a", "ses_b"], "list keeps share order")
  assert.equal(s.indexOf("ses_b"), 2)
})

test("share state: setActive switches active among shared sessions", () => {
  const s = new ShareStateManager()
  s.share("ses_a", "chat_1")
  s.share("ses_b", "chat_1")
  assert.equal(s.setActive("ses_b"), true)
  assert.equal(s.current?.sessionID, "ses_b")
  assert.equal(s.setActive("ses_unknown"), false)
  assert.equal(s.current?.sessionID, "ses_b")
})

test("share state: stopOne removes one and active falls back by share order", () => {
  const s = new ShareStateManager()
  s.share("ses_a", "chat_1")
  s.share("ses_b", "chat_1")
  s.share("ses_c", "chat_1")
  s.setActive("ses_c")
  const r = s.stopOne("ses_c")
  assert.equal((r as { wasActive: boolean }).wasActive, true)
  assert.equal((r as { remaining: number }).remaining, 2)
  assert.equal(s.current?.sessionID, "ses_a", "active falls back to earliest remaining in share order")
  assert.equal(s.isShared("ses_c"), false)
  // 停止非 active 会话不影响 active
  s.stopOne("ses_b")
  assert.equal(s.current?.sessionID, "ses_a")
  const r2 = s.stopOne("ses_unknown")
  assert.equal((r2 as { was: unknown }).was, null)
})

test("share state: stopAll clears everything", () => {
  const s = new ShareStateManager()
  s.share("ses_a", "chat_1")
  s.share("ses_b", "chat_1")
  const r = s.stopAll()
  assert.equal(r.ok, true)
  assert.equal((r as { was: unknown }).was !== null, true)
  assert.equal(s.status, "unshared")
  assert.equal(s.count, 0)
  assert.equal(s.current, null)
})

test("share state: routeCommand allows any shared session", () => {
  const s = new ShareStateManager()
  s.share("ses_a", "chat_1")
  s.share("ses_b", "chat_1")
  assert.equal(s.routeCommand("ses_a"), true)
  assert.equal(s.routeCommand("ses_b"), true)
  assert.equal(s.routeCommand("ses_c"), false)
  s.stopAll()
  assert.equal(s.routeCommand("ses_a"), false)
})

// ---------- Security ----------

function securityWith(senders: string[], chats: string[]): Security {
  return new Security({ stateDir: "/tmp/x", allowedSenderIDs: senders, allowedChatIDs: chats })
}

test("security: deny unknown sender by default (default deny)", () => {
  const sec = securityWith([], [])
  const r = sec.checkInbound({ senderID: "ou_attacker", chatID: "oc_chat" })
  assert.equal(r.ok, false)
})

test("security: allow listed sender + chat", () => {
  const sec = securityWith(["ou_me"], ["oc_chat"])
  const r = sec.checkInbound({ senderID: "ou_me", chatID: "oc_chat" })
  assert.equal(r.ok, true)
})

test("security: deny listed sender in unlisted chat", () => {
  const sec = securityWith(["ou_me"], ["oc_chat"])
  const r = sec.checkInbound({ senderID: "ou_me", chatID: "oc_other" })
  assert.equal(r.ok, false)
})

test("security: wildcard sender still restricted by chat", () => {
  const sec = securityWith(["*"], ["oc_chat"])
  const ok = sec.checkInbound({ senderID: "ou_anyone", chatID: "oc_chat" })
  const bad = sec.checkInbound({ senderID: "ou_anyone", chatID: "oc_other" })
  assert.equal(ok.ok, true)
  assert.equal(bad.ok, false)
})

// ---------- MockTransport ----------

test("mock transport: outbox receives events as JSONL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-poc-"))
  const t = new MockTransport({ stateDir: dir })
  await t.start()
  await t.send({ kind: "share_open", sessionID: "s1", chatID: "c1" })
  await t.send({ kind: "task_started", sessionID: "s1", chatID: "c1" })
  await t.stop()
  const lines = readFileSync(join(dir, "outbox.jsonl"), "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0]!)
  assert.equal(first.kind, "share_open")
  assert.equal(first.sessionID, "s1")
})

test("mock transport: inbox delivers new lines only (no backlog replay)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-poc-"))
  writeFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ senderID: "ou_old", chatID: "c", command: { action: "status" } }) + "\n")
  const t = new MockTransport({ stateDir: dir, pollIntervalMs: 20 })
  const received: Array<{ cmd: InboundCommand; senderID: string }> = []
  t.onInbound((cmd, ctx) => received.push({ cmd, senderID: ctx.senderID }))
  await t.start()
  // 旧行不应触发
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(received.length, 0)
  appendFileSync(join(dir, "inbox.jsonl"), JSON.stringify({ senderID: "ou_me", chatID: "c", command: { action: "prompt", text: "hi" } }) + "\n")
  await new Promise((r) => setTimeout(r, 120))
  await t.stop()
  assert.equal(received.length, 1)
  assert.equal(received[0]!.cmd.action, "prompt")
  assert.equal(received[0]!.senderID, "ou_me")
})

test("mock transport: malformed inbox lines are skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feishu-poc-"))
  const t = new MockTransport({ stateDir: dir, pollIntervalMs: 20 })
  const received: InboundCommand[] = []
  t.onInbound((cmd) => received.push(cmd))
  await t.start()
  appendFileSync(join(dir, "inbox.jsonl"), "not-json\n" + JSON.stringify({ command: { action: "status" } }) + "\n")
  await new Promise((r) => setTimeout(r, 120))
  await t.stop()
  assert.equal(received.length, 1)
  assert.equal(received[0]!.action, "status")
})

test("mock transport: creates state dir on start", async () => {
  const dir = join(tmpdir(), `feishu-poc-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const t = new MockTransport({ stateDir: dir })
  await t.start()
  await t.stop()
  assert.equal(existsSync(dir), true)
})

// ---------- session helpers ----------

const msg = (role: "user" | "assistant", text: string) => ({
  info: { role, id: `m_${Math.random().toString(16).slice(2)}`, sessionID: "s", time: { created: 1 } },
  parts: [{ type: "text", text, id: "p", sessionID: "s", messageID: "m" }],
})

test("session: lastAssistantText returns latest assistant text", () => {
  const msgs = [msg("user", "hello"), msg("assistant", "first"), msg("user", "again"), msg("assistant", "second")]
  assert.equal(lastAssistantText(msgs as never), "second")
})

test("session: lastAssistantText skips empty assistant parts", () => {
  const msgs = [msg("assistant", ""), msg("assistant", "real")]
  assert.equal(lastAssistantText(msgs as never), "real")
})

test("session: lastAssistantText truncates long text", () => {
  const msgs = [msg("assistant", "x".repeat(1000))]
  const out = lastAssistantText(msgs as never, 100)
  assert.equal(out?.length, 101) // 100 + ellipsis
  assert.ok(out?.endsWith("…"))
})

test("session: lastAssistantText returns undefined when no assistant", () => {
  const msgs = [msg("user", "hi")]
  assert.equal(lastAssistantText(msgs as never), undefined)
})

test("session: textOfMessage joins text parts", () => {
  const m = { info: { role: "user" }, parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  assert.equal(textOfMessage(m as never), "a\nb")
})

test("session: summarize builds snapshot fields", () => {
  const s = summarize({ id: "ses1", title: "T" } as never, [msg("user", "q"), msg("assistant", "a")] as never)
  assert.equal(s.id, "ses1")
  assert.equal(s.title, "T")
  assert.equal(s.messageCount, 2)
  assert.equal(s.lastAssistantText, "a")
})

// ---------- config ----------

test("config: env overrides state dir and whitelists", () => {
  const cfg = loadConfig({
    FEISHU_SHARE_STATE_DIR: "/tmp/custom",
    FEISHU_ALLOWED_OPEN_IDS: " ou_a , ou_b ",
    FEISHU_ALLOWED_CHAT_IDS: "oc_x",
  } as NodeJS.ProcessEnv)
  assert.equal(cfg.stateDir, "/tmp/custom")
  assert.deepEqual(cfg.allowedSenderIDs, ["ou_a", "ou_b"])
  assert.deepEqual(cfg.allowedChatIDs, ["oc_x"])
})

test("config: default deny when no whitelist configured", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv)
  assert.deepEqual(cfg.allowedSenderIDs, [])
  assert.deepEqual(cfg.allowedChatIDs, [])
})
