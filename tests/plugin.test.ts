/**
 * 插件集成测试：用 fake TuiPluginApi 驱动真实 tui() 入口，
 * 覆盖分享生命周期、入站路由、并发 prompt、未授权拒绝、dispose 清理。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tui as pluginTui } from "../dist/index.js"
import type { InboundCommand, InboundContext, OutboundEvent } from "../dist/types.js"

type ToastCall = { variant?: string; message: string }

function makeFakeApi(env: Record<string, string> = {}) {
  const toasts: ToastCall[] = []
  const eventHandlers = new Map<string, Array<(e: any) => void>>()
  let menuCommand: { name?: string; slashName?: string; run?: () => void } | null = null
  const clientCalls: Array<{ kind: string; args: unknown }> = []
  const dialogState = {
    open: false,
    title: "",
    options: [] as Array<{ title: string; value: string }>,
    onSelect: null as null | ((o: { value: string }) => void),
  }
  const disposers: Array<() => void | Promise<void>> = []
  const sessionMessages: Array<{ info: { role: string }; parts: Array<{ type: string; text: string }> }> = [
    { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "READY" }] },
  ]

  const api = {
    app: { version: "1.18.35" },
    route: {
      current: { name: "session", params: { sessionID: "ses_current" } } as never,
      register: () => () => {},
      navigate: () => {},
    },
    ui: {
      toast: (input: ToastCall) => toasts.push(input),
      DialogSelect: (props: { title: string; options: Array<{ title: string; value: string }>; onSelect: (o: { value: string }) => void }) => {
        dialogState.open = true
        dialogState.title = props.title
        dialogState.options = props.options
        dialogState.onSelect = props.onSelect
        return null as never
      },
      dialog: { replace: (r: () => unknown) => r(), clear: () => {} },
    },
    keymap: {
      registerLayer: (layer: { commands: Array<{ name?: string; slashName?: string; run?: () => void }> }) => {
        for (const c of layer.commands) menuCommand = c
        return () => {}
      },
    },
    event: {
      on: (type: string, handler: (e: any) => void) => {
        const list = eventHandlers.get(type) ?? []
        list.push(handler)
        eventHandlers.set(type, list)
        return () => {}
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: () => void | Promise<void>) => {
        disposers.push(fn)
      },
    },
    state: {
      path: { directory: "/tmp/fake", config: "/tmp/fake/.opencode/tui.json" },
      session: {
        get: (id: string) => (id === "ses_current" ? { id, title: "Fake Session" } : undefined),
        messages: () => [],
        status: () => ({ type: "idle" }),
        permission: () => [],
        question: () => [],
      },
    },
    client: {
      session: {
        messages: async () => ({ error: undefined, data: sessionMessages }),
        abort: async (args: unknown) => {
          clientCalls.push({ kind: "abort", args })
          return { error: undefined, data: {} }
        },
        prompt: async (args: unknown) => {
          clientCalls.push({ kind: "prompt", args })
          return { error: undefined, data: {} }
        },
      },
      v2: {
        session: {
          prompt: async (args: unknown) => {
            clientCalls.push({ kind: "v2prompt", args })
            return { error: undefined, data: {} }
          },
        },
      },
      permission: {
        reply: async (args: unknown) => {
          clientCalls.push({ kind: "permission.reply", args })
          return { error: undefined, data: {} }
        },
      },
      question: {
        reply: async (args: unknown) => {
          clientCalls.push({ kind: "question.reply", args })
          return { error: undefined, data: {} }
        },
        reject: async (args: unknown) => {
          clientCalls.push({ kind: "question.reject", args })
          return { error: undefined, data: {} }
        },
      },
    },
  }

  const envVars = { ...env }
  const savedEnv: Record<string, string | undefined> = {}
  for (const k of Object.keys(envVars)) {
    savedEnv[k] = process.env[k]
    process.env[k] = envVars[k]
  }

  return {
    api: api as never,
    toasts,
    eventHandlers,
    clientCalls,
    dialogState,
    disposers,
    getSlashCommand: () => menuCommand,
    triggerEvent: (type: string, e: unknown) => {
      for (const h of eventHandlers.get(type) ?? []) h(e)
    },
    restoreEnv: () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}

function makeCtx(senderID = "ou_tester", chatID = "mock-chat"): InboundContext {
  return { senderID, chatID, messageID: `m${Math.random().toString(16).slice(2)}` }
}

async function setup(env: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const fake = makeFakeApi({ ...env, FEISHU_SHARE_STATE_DIR: stateDir, FEISHU_ALLOWED_OPEN_IDS: "*", FEISHU_ALLOWED_CHAT_IDS: "*" })
  await pluginTui(fake.api, undefined, undefined as never)
  // 触发菜单 share
  const cmd = fake.getSlashCommand()
  cmd?.run?.()
  fake.dialogState.onSelect?.({ value: "share" })
  // onSelect 是 async fire-and-forget，等一拍
  await new Promise((r) => setTimeout(r, 60))
  return { fake, stateDir }
}

function readOutbox(stateDir: string): OutboundEvent[] {
  const p = join(stateDir, "outbox.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OutboundEvent)
}

test("integration: share lifecycle emits open/close and unbinds", async () => {
  const { fake, stateDir } = await setup()
  const events = readOutbox(stateDir)
  assert.equal(events[0]?.kind, "share_open")
  assert.equal((events[0] as { session?: { title?: string } }).session?.title, "Fake Session")

  // 菜单 stop
  fake.getSlashCommand()?.run?.()
  fake.dialogState.onSelect?.({ value: "stop" })
  await new Promise((r) => setTimeout(r, 80))
  const after = readOutbox(stateDir)
  assert.equal(after[after.length - 1]?.kind, "share_close")
  fake.restoreEnv()
})

test("integration: inbound prompt routes to shared session via durable v2 prompt", async () => {
  const { fake, stateDir } = await setup()
  // 从 outbox 拿 chatID（transport 已绑定）；直接注入 inbound 到已创建的 transport —— 通过 outbox 无法拿到 inbound 入口，
  // 因此使用菜单 share 时创建的 transport。这里通过再次发送 inbox 文件验证。
  const { appendFileSync, writeFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "i1", command: { action: "prompt", text: "run tests" } })}\n`)
  await new Promise((r) => setTimeout(r, 700)) // mock 轮询间隔 400ms
  const v2 = fake.clientCalls.filter((c) => c.kind === "v2prompt")
  assert.equal(v2.length, 1)
  assert.deepEqual((v2[0]!.args as { sessionID: string }).sessionID, "ses_current")
  assert.equal((v2[0]!.args as { delivery?: string }).delivery, "queue")
  fake.restoreEnv()
})

test("integration: concurrent prompts are both forwarded (server serializes)", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "c1", command: { action: "prompt", text: "one" } })}\n`)
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "c2", command: { action: "prompt", text: "two" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const v2 = fake.clientCalls.filter((c) => c.kind === "v2prompt")
  assert.equal(v2.length, 2)
  const texts = v2.map((c) => (c.args as { prompt?: { text?: string } }).prompt?.text)
  assert.deepEqual(texts.sort(), ["one", "two"])
  fake.restoreEnv()
})

test("integration: unauthorized sender is rejected (default deny)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const fake = makeFakeApi({ FEISHU_SHARE_STATE_DIR: stateDir, FEISHU_ALLOWED_OPEN_IDS: "ou_boss", FEISHU_ALLOWED_CHAT_IDS: "*" })
  await pluginTui(fake.api, undefined, undefined as never)
  fake.getSlashCommand()?.run?.()
  fake.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 60))
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_attacker", chatID: "mock-chat", messageID: "a1", command: { action: "prompt", text: "rm -rf /" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(fake.clientCalls.filter((c) => c.kind === "v2prompt").length, 0)
  const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
  assert.ok(audit.includes("not allowed"))
  fake.restoreEnv()
})

test("integration: permission reply only allowed for pending requests (binding)", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  // 未经 permission.asked 事件，直接回复 → 应拒绝
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "p0", command: { action: "permission_reply", requestID: "#latest", reply: "once" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(fake.clientCalls.filter((c) => c.kind === "permission.reply").length, 0)

  // 模拟 pending permission
  fake.triggerEvent("permission.asked", {
    properties: { id: "per_1", sessionID: "ses_current", permission: "bash", patterns: [], metadata: {}, always: [] },
  })
  await new Promise((r) => setTimeout(r, 100))
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "p1", command: { action: "permission_reply", requestID: "#latest", reply: "once" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const replies = fake.clientCalls.filter((c) => c.kind === "permission.reply")
  assert.equal(replies.length, 1)
  assert.deepEqual((replies[0]!.args as { requestID: string }).requestID, "per_1")

  // 回复后不再允许复用同一 requestID（过期审批防复用）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "p2", command: { action: "permission_reply", requestID: "per_1", reply: "once" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(fake.clientCalls.filter((c) => c.kind === "permission.reply").length, 1)
  fake.restoreEnv()
})

test("integration: task events only forwarded for shared session", async () => {
  const { fake, stateDir } = await setup()
  const before = readOutbox(stateDir).length
  // 非分享 session 的事件 → 不转发
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_other", status: { type: "busy" } } })
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_other", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(readOutbox(stateDir).length, before)
  // 分享 session 的 busy → task_started
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 100))
  const events = readOutbox(stateDir)
  assert.equal(events[events.length - 1]?.kind, "task_started")
  // busy 期间重复 busy → 去重，不重复通知
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(readOutbox(stateDir).length, events.length)
  // idle → task_completed
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 150))
  const done = readOutbox(stateDir)
  assert.equal(done[done.length - 1]?.kind, "task_completed")
  assert.equal((done[done.length - 1] as { summary?: string }).summary, "READY")
  fake.restoreEnv()
})

test("integration: dispose stops transport and emits share_close", async () => {
  const { fake, stateDir } = await setup()
  for (const d of fake.disposers) await d()
  const events = readOutbox(stateDir)
  assert.equal(events[events.length - 1]?.kind, "share_close")
  assert.equal((events[events.length - 1] as { reason?: string }).reason, "tui exit")
  fake.restoreEnv()
})

test("integration: abort command calls session.abort", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "s1", command: { action: "abort" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const aborts = fake.clientCalls.filter((c) => c.kind === "abort")
  assert.equal(aborts.length, 1)
  assert.deepEqual((aborts[0]!.args as { sessionID: string }).sessionID, "ses_current")
  fake.restoreEnv()
})
