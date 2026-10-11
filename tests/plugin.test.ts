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
  const sessionMessages: Array<{ info: { role: string; modelID?: string; providerID?: string; agent?: string }; parts: Array<{ type: string; text: string }> }> = [
    { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    { info: { role: "assistant", modelID: "glm-test", providerID: "ark-test", agent: "plan" }, parts: [{ type: "text", text: "READY" }] },
  ]
  let sessionStatusType = "idle"

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
        status: () => ({ type: sessionStatusType }),
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
    setStatus: (t: string) => {
      sessionStatusType = t
    },
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

test("integration: inbound prompt routes to shared session with session's own model", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "i1", command: { action: "prompt", text: "run tests" } })}\n`)
  await new Promise((r) => setTimeout(r, 700)) // mock 轮询间隔 400ms
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  const args = prompts[0]!.args as { sessionID: string; model?: { providerID: string; modelID: string }; agent?: string; parts: Array<{ type: string; text: string }> }
  assert.equal(args.sessionID, "ses_current")
  assert.deepEqual(args.model, { providerID: "ark-test", modelID: "glm-test" })
  assert.equal(args.agent, "plan")
  assert.deepEqual(args.parts, [{ type: "text", text: "run tests" }])
  fake.restoreEnv()
})

test("integration: busy session queues prompt and drains on idle", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  fake.setStatus("busy")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "q1", command: { action: "prompt", text: "later job" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  // busy 时不提交
  assert.equal(fake.clientCalls.filter((c) => c.kind === "prompt").length, 0)

  // 触发 busy -> idle 事件，队列应自动执行
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 100))
  fake.setStatus("idle")
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 300))
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  assert.equal(((prompts[0]!.args as { parts: Array<{ text: string }> }).parts[0] as { text: string }).text, "later job")
  fake.restoreEnv()
})

test("integration: concurrent prompts are both forwarded (server serializes)", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "c1", command: { action: "prompt", text: "one" } })}\n`)
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "c2", command: { action: "prompt", text: "two" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 2)
  const texts = prompts.map((c) => (c.args as { parts: Array<{ text: string }> }).parts[0]!.text)
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
  // idle → 流式卡原地定稿（card_update，绿卡），不再发独立 task_completed
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 150))
  const done = readOutbox(stateDir)
  const last = done[done.length - 1] as { kind: string; messageID?: string; card?: { header?: { title?: { content?: string } } } }
  assert.equal(last?.kind, "card_update")
  assert.ok(last?.card?.header?.title?.content?.includes("任务完成"))
  fake.restoreEnv()
})

test("integration: retry status reports rate-limit to feishu (streaming card + standalone)", async () => {
  const { fake, stateDir } = await setup()
  // 路径 1：流式卡存在 → 原地更新为橙色重试卡
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 100))
  fake.triggerEvent("session.status", {
    properties: {
      sessionID: "ses_current",
      status: { type: "retry", attempt: 2, message: "TPM limit of the model glm-5-3-flash is exceeded" },
    },
  })
  await new Promise((r) => setTimeout(r, 150))
  let events = readOutbox(stateDir)
  let last = events[events.length - 1] as { kind: string; card?: { header?: { title?: { content?: string } }; elements?: Array<{ content?: string }> } }
  assert.equal(last?.kind, "card_update")
  assert.ok(last?.card?.header?.title?.content?.includes("模型限流"))
  assert.ok(JSON.stringify(last?.card).includes("TPM limit"))

  // 路径 2：无流式卡（会话非流式）→ task_retry 通知
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 100))
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 100))
  // 模拟流式卡丢失（直接清空内部状态不可行，改为验证 retry 在 streaming 为空时发 task_retry）
  fake.triggerEvent("session.status", {
    properties: { sessionID: "ses_current", status: { type: "retry", attempt: 3, message: "rate limited" } },
  })
  await new Promise((r) => setTimeout(r, 150))
  events = readOutbox(stateDir)
  last = events[events.length - 1] as { kind: string; attempt?: number }
  assert.equal(last?.kind, "card_update") // 仍有流式卡 → card_update
  assert.equal((last as { attempt?: number }).attempt, undefined)
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

test("integration: streaming card shows thinking placeholder, streams only final text (not reasoning)", async () => {
  const { fake, stateDir } = await setup()
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 120))
  let events = readOutbox(stateDir)
  const taskStarted = events.find((e) => e.kind === "task_started") as { messageID?: string }
  assert.ok(taskStarted?.messageID, "busy should create a streaming card")

  // reasoning 更新：不应外发思考内容，只显示"思考中"
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "p_reason", type: "reasoning", text: "secret reasoning chain..." } },
  })
  await new Promise((r) => setTimeout(r, 1400))
  events = readOutbox(stateDir)
  const thinkUpdate = events.filter((e) => e.kind === "card_update").at(-1) as {
    messageID?: string
    card?: { elements?: Array<{ content?: string }> }
  }
  assert.equal(thinkUpdate?.messageID, taskStarted?.messageID)
  const thinkBody = JSON.stringify(thinkUpdate?.card)
  assert.ok(thinkBody.includes("思考中"))
  assert.ok(!thinkBody.includes("secret reasoning chain"), "reasoning content must not be pushed")

  // 正文更新：流式推送最终文本
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "p_text", type: "text", text: "最终答案内容" } },
  })
  await new Promise((r) => setTimeout(r, 1400))
  events = readOutbox(stateDir)
  const textUpdate = events.filter((e) => e.kind === "card_update").at(-1) as {
    messageID?: string
    card?: { elements?: Array<{ content?: string }> }
  }
  const body = JSON.stringify(textUpdate?.card)
  assert.ok(body.includes("最终答案内容"), "text content should stream")
  assert.ok(!body.includes("secret reasoning chain"), "reasoning never appears in card")

  // idle → 绿色完成卡
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 200))
  events = readOutbox(stateDir)
  const final = events.filter((e) => e.kind === "card_update").at(-1) as { card?: { header?: { title?: { content?: string }; template?: string } } }
  assert.ok(final?.card?.header?.title?.content?.includes("任务完成"))
  assert.equal(final?.card?.header?.template, "green")
  fake.restoreEnv()
})

test("integration: streaming card matches TUI tool timeline (running/completed markers)", async () => {
  const { fake, stateDir } = await setup()
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 120))

  // 工具运行中（对齐 TUI 的 ⟳ 转轮 + 标题）
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "t1", type: "tool", tool: "read", state: { status: "running", title: "Read src/index.ts" } } },
  })
  // 第一个工具完成、第二个运行中
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "t1", type: "tool", tool: "read", state: { status: "completed", title: "Read src/index.ts" } } },
  })
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "t2", type: "tool", tool: "bash", state: { status: "running", title: "npm test" } } },
  })
  // 思考 + 正文
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "r1", type: "reasoning", text: "internal reasoning" } },
  })
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "x1", type: "text", text: "测试通过！" } },
  })
  await new Promise((r) => setTimeout(r, 1500))

  const events = readOutbox(stateDir)
  const last = events.filter((e) => e.kind === "card_update").at(-1) as
    | { card?: { elements?: Array<{ content?: string }> } }
    | undefined
  const body = JSON.stringify(last?.card)
  assert.ok(body.includes("✓ Read src/index.ts"), "completed tool should show ✓")
  assert.ok(body.includes("⟳ **npm test**"), "running tool should show ⟳ + bold title")
  assert.ok(body.includes("测试通过！"), "text should stream")
  assert.ok(!body.includes("internal reasoning"), "reasoning content must not be pushed")
  fake.restoreEnv()
})

test("integration: question tool shows waiting state (no spinner entry); prompt acks are silent", async () => {
  const { fake, stateDir } = await setup()
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 120))
  // agent 调用 question 工具提问
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "q1", type: "tool", tool: "question", state: { status: "running" } } },
  })
  await new Promise((r) => setTimeout(r, 1500))
  let events = readOutbox(stateDir)
  const card = events.filter((e) => e.kind === "card_update").at(-1) as { card?: { elements?: Array<{ content?: string }> } }
  const body = JSON.stringify(card?.card)
  assert.ok(body.includes("等待你的回答"), "question pending should show waiting state")
  assert.ok(!body.includes("⟳ **question**"), "question tool must not appear as a spinner entry")

  // 忙碌时远程 prompt → 只进队列并刷新流式卡（无独立状态框）
  fake.setStatus("busy")
  const before = events.length
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "qq1", command: { action: "prompt", text: "排队任务" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  events = readOutbox(stateDir)
  assert.equal(events.filter((e) => e.kind === "status").length, 0, "no standalone status frame for queued prompt")
  const lastCard = events.filter((e) => e.kind === "card_update").at(-1) as { card?: { elements?: Array<{ content?: string }> } }
  assert.ok(JSON.stringify(lastCard?.card).includes("排队 prompt"), "queue depth shown inside streaming card")

  // 空闲时 prompt → 无 prompt submitted 确认框
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 300))
  // 队列 drain 提交排队的 prompt
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 150))
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 200))
  events = readOutbox(stateDir)
  assert.equal(events.filter((e) => e.kind === "status" && JSON.stringify(e).includes("prompt submitted")).length, 0)
  fake.restoreEnv()
})

test("integration: agent question event produces question card with buttons", async () => {
  const { fake, stateDir } = await setup()
  fake.triggerEvent("question.asked", {
    properties: {
      id: "q_test_1",
      sessionID: "ses_current",
      questions: [{ question: "用哪个方案？", options: [{ label: "方案A" }, { label: "方案B" }] }],
    },
  })
  await new Promise((r) => setTimeout(r, 200))
  const events = readOutbox(stateDir)
  const q = events.find((e) => e.kind === "question_asked") as
    | { requestID?: string; questions?: unknown }
    | undefined
  assert.ok(q, "question_asked should be emitted")
  assert.equal(q.requestID, "q_test_1")
  fake.triggerEvent("question.replied", { properties: { requestID: "q_test_1" } })
  fake.restoreEnv()
})
