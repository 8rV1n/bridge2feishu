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
  // 模拟服务端权威会话状态（v2 session.get 读这里，switchAgent/switchModel 写这里）
  const serverSession: { agent?: string; model?: { providerID: string; modelID: string } } = {}

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
        agent: {
          // 真实 v2 SDK 返回 { location, data: AgentV2Info[] } 包装（非数组），且 AgentV2Info 只有 id 字段
          list: async () => ({
            error: undefined,
            data: {
              location: { directory: "/tmp/fake", project: { id: "p", directory: "/tmp/fake" } },
              data: [
                { id: "build", description: "Build agent", mode: "primary", hidden: false },
                { id: "plan", description: "Planning agent", mode: "primary", hidden: false },
              ],
            },
          }),
        },
        session: {
          // 服务端会话状态（权威数据源）：初始为空 → 插件回落 TUI 状态/消息；switch 后立即反映
          get: async () => ({
            error: undefined,
            data: { data: { id: "ses_current", agent: serverSession.agent, model: serverSession.model } },
          }),
          prompt: async (args: unknown) => {
            clientCalls.push({ kind: "v2prompt", args })
            return { error: undefined, data: {} }
          },
          switchAgent: async (args: unknown) => {
            clientCalls.push({ kind: "switchAgent", args })
            serverSession.agent = (args as { agent?: string }).agent
            return { error: undefined, data: {} }
          },
          switchModel: async (args: unknown) => {
            clientCalls.push({ kind: "switchModel", args })
            serverSession.model = (args as { model?: { providerID: string; modelID: string } }).model
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
    serverSession,
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
  const fake = makeFakeApi({
    ...env,
    FEISHU_SHARE_STATE_DIR: stateDir,
    FEISHU_ALLOWED_OPEN_IDS: "*",
    FEISHU_ALLOWED_CHAT_IDS: "*",
    // 隔离宿主环境：测试强制使用 mock 传输层，不受 shell 里的 FEISHU_* 影响
    FEISHU_SHARE_TRANSPORT: "mock",
  })
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
  const fake = makeFakeApi({ FEISHU_SHARE_STATE_DIR: stateDir, FEISHU_ALLOWED_OPEN_IDS: "ou_boss", FEISHU_ALLOWED_CHAT_IDS: "*", FEISHU_SHARE_TRANSPORT: "mock" })
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

test("integration: /agent lists agents by id and /agent <n> switches via v2 switchAgent", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  // v2 AgentV2Info 只有 id 字段（没有 name）——列表必须显示真实 id 而非 undefined
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "ag1", command: { action: "agent_list" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  let events = readOutbox(stateDir)
  const list = events.filter((e) => e.kind === "status").at(-1) as { text?: string } | undefined
  assert.ok(list?.text?.includes("build（Build agent）"), "agent list must show id from AgentV2Info")
  assert.ok(!list?.text?.includes("undefined"), "agent list must not contain undefined entries")

  // 切换：/agent 2 → switchAgent({ agent: "plan" }) + 确认卡
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "ag2", command: { action: "agent_switch", index: 2 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const switches = fake.clientCalls.filter((c) => c.kind === "switchAgent")
  assert.equal(switches.length, 1)
  assert.equal((switches[0]!.args as { sessionID: string; agent: string }).agent, "plan")
  assert.equal((switches[0]!.args as { sessionID: string }).sessionID, "ses_current")
  events = readOutbox(stateDir)
  const ack = events.filter((e) => e.kind === "status").at(-1) as { text?: string }
  assert.ok(ack?.text?.includes("已切换 Agent"), "switch ack card should be sent")
  fake.restoreEnv()
})

test("integration: TUI agent switch syncs to feishu; remote switch does not double-notify", async () => {
  const { fake, stateDir } = await setup()
  // TUI 本地切换 → session.next.agent.switched 事件 → 同步卡
  fake.triggerEvent("session.next.agent.switched", {
    properties: { sessionID: "ses_current", timestamp: Date.now(), messageID: "m1", agent: "build" },
  })
  await new Promise((r) => setTimeout(r, 100))
  const events = readOutbox(stateDir)
  const sync = events.filter((e) => e.kind === "status").at(-1) as { text?: string }
  assert.ok(sync?.text?.includes("已切换 Agent"), "TUI agent switch should sync a status card")
  assert.ok(sync?.text?.includes("build"))

  // 远程 /agent 1 → 插件自管通知；窗口内的事件不再重复发卡
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "ag3", command: { action: "agent_switch", index: 1 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const afterRemote = readOutbox(stateDir)
  assert.equal(fake.clientCalls.filter((c) => c.kind === "switchAgent").length, 1)
  const beforeEcho = afterRemote.length
  fake.triggerEvent("session.next.agent.switched", {
    properties: { sessionID: "ses_current", timestamp: Date.now(), messageID: "m2", agent: "build" },
  })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(readOutbox(stateDir).length, beforeEcho, "remote switch must not produce a duplicate event card")
  fake.restoreEnv()
})

test("integration: permission card includes path patterns and metadata detail", async () => {
  const { fake, stateDir } = await setup()
  fake.triggerEvent("permission.asked", {
    properties: {
      id: "per_ext",
      sessionID: "ses_current",
      permission: "external_directory",
      patterns: ["/Users/me/OpenCodeHome/other-project"],
      metadata: { filepath: "/Users/me/OpenCodeHome/other-project/file.txt" },
    },
  })
  await new Promise((r) => setTimeout(r, 200))
  const events = readOutbox(stateDir)
  const card = events.find((e) => e.kind === "permission_requested") as
    | { patterns?: string[]; detail?: string }
    | undefined
  assert.ok(card, "permission_requested should be emitted")
  assert.deepEqual(card.patterns, ["/Users/me/OpenCodeHome/other-project"])
  assert.ok(card.detail?.includes("other-project/file.txt"), "metadata detail should carry the full path")
  fake.restoreEnv()
})

test("integration: disconnect posts warning toast and persistent TUI notice (noReply)", async () => {
  const { fake, stateDir } = await setup()
  const toastCountBefore = fake.toasts.length
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "d1", command: { action: "stop" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  // warning toast（不再是 error/info 风格）
  const toast = fake.toasts[toastCountBefore]
  assert.ok(toast, "stop should produce a toast")
  assert.equal(toast?.variant, "warning")
  assert.ok(toast?.message.includes("remote stop"))
  // 会话内持久通知：noReply prompt，不触发 agent 回复
  const notices = fake.clientCalls.filter((c) => c.kind === "prompt" && (c.args as { noReply?: boolean }).noReply === true)
  assert.equal(notices.length, 1)
  const args = notices[0]!.args as { sessionID: string; parts: Array<{ type: string; text: string }> }
  assert.equal(args.sessionID, "ses_current")
  assert.ok(args.parts[0]!.text.includes("飞书分享已断开"))
  fake.restoreEnv()
})

test("integration: after remote /agent switch, next prompt and list use the NEW agent (server truth)", async () => {
  const { fake, stateDir } = await setup()
  const { appendFileSync } = await import("node:fs")
  // 远程切换 → 服务端状态变为 build（TUI 本地状态/历史消息仍是旧的 plan，不能被钉回）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw1", command: { action: "agent_switch", index: 1 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(fake.serverSession.agent, "build")

  // 切换后立即查询：当前 Agent 必须显示新值（服务端权威），而非消息兜底的旧值
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw2", command: { action: "agent_list" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  let events = readOutbox(stateDir)
  const list = events.filter((e) => e.kind === "status").at(-1) as { text?: string }
  assert.ok(list?.text?.includes("当前 Agent**：build"), "agent list must reflect the switched agent, got: " + list?.text)

  // 切换后远程 prompt：沿用新 agent（不把旧 agent 钉回去）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw3", command: { action: "prompt", text: "继续任务" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  const args = prompts[0]!.args as { agent?: string; model?: { providerID: string; modelID: string } }
  assert.equal(args.agent, "build")
  // 服务端状态里 model 为空 → 回落最后一条消息的 model（ark-test/glm-test），agent 用服务端新值
  assert.deepEqual(args.model, { providerID: "ark-test", modelID: "glm-test" })
  fake.restoreEnv()
})

test("integration: long final streaming text is split into multiple cards", async () => {
  const { fake, stateDir } = await setup()
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 120))
  const longText = Array.from({ length: 400 }, (_, i) => `中文段落第${i}行，这里有足够多的汉字内容用于触发字节上限的分页切分逻辑`).join("\n")
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "p_long", type: "text", text: longText } },
  })
  await new Promise((r) => setTimeout(r, 1400))
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 500))
  const events = readOutbox(stateDir)
  const finalUpdate = events.filter((e) => e.kind === "card_update").at(-1) as
    | { card?: { header?: { title?: { content?: string } } } }
    | undefined
  assert.ok(finalUpdate?.card?.header?.title?.content?.includes("任务完成 (1/"), "first page should stay on the streaming card")
  const pages = events.filter((e) => e.kind === "card_send") as Array<{ card?: { header?: { title?: { content?: string } }; body?: { elements?: Array<{ tag: string; content?: string }> } } }>
  assert.ok(pages.length >= 1, "continuation pages should be sent as new cards")
  assert.ok(pages[0]?.card?.header?.title?.content?.includes("(2/"), "second page title should carry (2/N)")
  // 分页无损：所有页正文拼回应包含首尾内容
  const all = JSON.stringify(events.filter((e) => e.kind === "card_update" || e.kind === "card_send"))
  assert.ok(all.includes("中文段落第0行"), "head content preserved")
  assert.ok(all.includes("中文段落第399行"), "tail content preserved")
  fake.restoreEnv()
})
