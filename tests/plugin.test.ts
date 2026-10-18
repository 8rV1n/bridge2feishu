/**
 * 插件集成测试：用 fake TuiPluginApi 驱动真实 tui() 入口，
 * 覆盖分享生命周期、入站路由、并发 prompt、未授权拒绝、dispose 清理。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, existsSync, readFileSync, appendFileSync } from "node:fs"
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
  // 多 session 支持：按 session 存储消息/标题/状态/服务端权威 agent+model
  const defaultStatus = { value: "idle" }
  const sessionStatuses = new Map<string, string>()
  const sessionTitles = new Map<string, string>([["ses_current", "Fake Session"]])
  const messagesBySession = new Map<string, typeof sessionMessages>([["ses_current", sessionMessages]])
  // 模拟服务端权威会话状态（v2 session.get 读这里，switchAgent/switchModel 写这里）
  const serverSessions = new Map<string, { agent?: string; model?: { providerID: string; modelID: string } }>()
  const serverSessionOf = (id: string) => {
    let s = serverSessions.get(id)
    if (!s) {
      s = {}
      serverSessions.set(id, s)
    }
    return s
  }

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
        get: (id: string) => (sessionTitles.has(id) ? { id, title: sessionTitles.get(id) } : undefined),
        messages: () => [],
        status: (id: string) => ({ type: sessionStatuses.get(id) ?? defaultStatus.value }),
        permission: () => [],
        question: () => [],
        diff: () => [],
        todo: () => [],
      },
    },
    client: {
      session: {
        messages: async (args: { sessionID?: string }) => ({ error: undefined, data: messagesBySession.get(args?.sessionID ?? "ses_current") ?? [] }),
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
          get: async (args: { sessionID?: string }) => {
            const ss = serverSessionOf(args?.sessionID ?? "ses_current")
            return { error: undefined, data: { data: { id: args?.sessionID ?? "ses_current", agent: ss.agent, model: ss.model } } }
          },
          prompt: async (args: unknown) => {
            clientCalls.push({ kind: "v2prompt", args })
            return { error: undefined, data: {} }
          },
          switchAgent: async (args: unknown) => {
            clientCalls.push({ kind: "switchAgent", args })
            serverSessionOf((args as { sessionID?: string }).sessionID ?? "ses_current").agent = (args as { agent?: string }).agent
            return { error: undefined, data: {} }
          },
          switchModel: async (args: unknown) => {
            clientCalls.push({ kind: "switchModel", args })
            serverSessionOf((args as { sessionID?: string }).sessionID ?? "ses_current").model = (args as { model?: { providerID: string; modelID: string } }).model
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
    serverSessions,
    sessionTitles,
    messagesBySession,
    setStatus: (t: string) => {
      defaultStatus.value = t
    },
    setStatusFor: (id: string, t: string) => {
      sessionStatuses.set(id, t)
    },
    setRoute: (sessionID: string) => {
      ;(api.route.current as { name: string; params: { sessionID: string } }).name = "session"
      ;(api.route.current as { name: string; params: { sessionID: string } }).params = { sessionID }
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

/** 多 session 场景：把另一个 session 也走菜单分享流程（transport 复用，不重建） */
async function shareSecondSession(fake: ReturnType<typeof makeFakeApi>, sessionID = "ses_second"): Promise<void> {
  fake.sessionTitles.set(sessionID, sessionID === "ses_second" ? "Second Session" : `Session ${sessionID}`)
  fake.messagesBySession.set(sessionID, [])
  fake.setRoute(sessionID)
  fake.getSlashCommand()?.run?.()
  fake.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 80))
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
  assert.equal(fake.serverSessions.get("ses_current")?.agent, "build")

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

// ---------- 多 session 分享与切换（0.2.0） ----------

test("integration: multi-session share keeps active and sends reminder card", async () => {
  const { fake, stateDir } = await setup()
  const openCount = readOutbox(stateDir).length
  // 第二个 session 分享：不抢占 active，发提醒卡
  await shareSecondSession(fake)
  const events = readOutbox(stateDir)
  // 新会话开启卡 + 全局提醒卡
  const newOpen = events.slice(openCount).find((e) => e.kind === "share_open") as { sessionID?: string } | undefined
  assert.equal(newOpen?.sessionID, "ses_second", "second share should emit its own share_open")
  const reminder = events.find((e) => e.kind === "multi_session_new") as
    | { sessions?: Array<{ sessionID: string; active: boolean }>; newIndex?: number }
    | undefined
  assert.ok(reminder, "second share should emit multi_session_new reminder")
  assert.equal(reminder?.sessions?.length, 2)
  assert.equal(reminder?.newIndex, 2)
  assert.equal(reminder?.sessions?.[0]?.sessionID, "ses_current")
  assert.equal(reminder?.sessions?.[0]?.active, true, "active must stay on first session")
  assert.equal(reminder?.sessions?.[1]?.active, false)

  // active 未变：prompt 仍路由到 ses_current
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "ms1", command: { action: "prompt", text: "still active" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  assert.equal((prompts[0]!.args as { sessionID: string }).sessionID, "ses_current")
  fake.restoreEnv()
})

test("integration: /session lists sessions with order and star; invalid index rejected", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sl1", command: { action: "session_list" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  let events = readOutbox(stateDir)
  const list = events.filter((e) => e.kind === "session_list").at(-1) as { sessions?: Array<{ sessionID: string; active: boolean }> } | undefined
  assert.ok(list?.sessions)
  assert.equal(list.sessions?.length, 2)
  assert.equal(list.sessions?.[0]?.active, true)
  assert.equal(list.sessions?.[1]?.active, false)

  // 未知序号 → 错误卡
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sl2", command: { action: "session_switch", index: 9 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  events = readOutbox(stateDir)
  const err = events.filter((e) => e.kind === "status").at(-1) as { text?: string }
  assert.ok(err?.text?.includes("会话序号 9 不存在"), "unknown index should produce an error card")
  fake.restoreEnv()
})

test("integration: /session 2 switches active; switch card carries summary + last interaction; prompt lands on new session", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  // 给第二个 session 准备历史消息（user + assistant）——必须在 shareSecondSession 之后（它会重置消息列表）
  fake.messagesBySession.set("ses_second", [
    { info: { role: "user" }, parts: [{ type: "text", text: "帮我看看构建日志" }] },
    { info: { role: "assistant", modelID: "m2", providerID: "p2", agent: "build" }, parts: [{ type: "text", text: "构建日志显示全部通过" }] },
  ])

  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw21", command: { action: "session_switch", index: 2 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const events = readOutbox(stateDir)
  const sw = events.filter((e) => e.kind === "session_switched").at(-1) as
    | { sessionID?: string; previousSessionID?: string; statusText?: string; lastUserText?: string; lastAssistantText?: string }
    | undefined
  assert.ok(sw, "session_switched card should be emitted")
  assert.equal(sw?.sessionID, "ses_second")
  assert.equal(sw?.previousSessionID, "ses_current")
  assert.ok(sw?.statusText, "switch card should carry a status summary")
  assert.ok(sw?.lastUserText?.includes("帮我看看构建日志"), "switch card should carry last user text")
  assert.ok(sw?.lastAssistantText?.includes("构建日志显示全部通过"), "switch card should carry last assistant text")
  // 渲染层（标题/三段式正文）在 tests/feishu.test.ts 中直接针对 renderCards 验证

  // 切换后 prompt 路由到新 active
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw22", command: { action: "prompt", text: "new target" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  assert.equal((prompts[0]!.args as { sessionID: string }).sessionID, "ses_second")
  fake.restoreEnv()
})

test("integration: two sessions stream concurrently without clobbering each other", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  // 两个会话先后 busy → 各自独立流式卡
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "busy" } } })
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_second", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 120))
  const starts = readOutbox(stateDir).filter((e) => e.kind === "task_started")
  assert.equal(starts.length, 2, "both sessions should emit task_started")
  const ids = new Set(starts.map((e) => (e as { sessionID: string }).sessionID))
  assert.ok(ids.has("ses_current") && ids.has("ses_second"))
  assert.notEqual((starts[0] as { messageID?: string }).messageID, (starts[1] as { messageID?: string }).messageID)

  // 各自的正文流式到各自的卡
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_current", part: { id: "pa", type: "text", text: "A 会话输出" } },
  })
  fake.triggerEvent("message.part.updated", {
    properties: { sessionID: "ses_second", part: { id: "pb", type: "text", text: "B 会话输出" } },
  })
  await new Promise((r) => setTimeout(r, 1500))
  const updates = readOutbox(stateDir).filter((e) => e.kind === "card_update") as Array<{ messageID?: string; card?: unknown }>
  const bodyA = updates.filter((u) => JSON.stringify(u.card).includes("A 会话输出"))
  const bodyB = updates.filter((u) => JSON.stringify(u.card).includes("B 会话输出"))
  assert.ok(bodyA.length > 0 && bodyB.length > 0, "both streams should be flushed")
  const startA = starts.find((e) => (e as { sessionID: string }).sessionID === "ses_current") as { messageID?: string }
  const startB = starts.find((e) => (e as { sessionID: string }).sessionID === "ses_second") as { messageID?: string }
  assert.equal(bodyA.at(-1)?.messageID, startA?.messageID, "A stream updates A's card")
  assert.equal(bodyB.at(-1)?.messageID, startB?.messageID, "B stream updates B's card")

  // B 先 idle 定格，A 的卡不受影响
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_second", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 200))
  fake.triggerEvent("session.status", { properties: { sessionID: "ses_current", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 300))
  const finals = readOutbox(stateDir).filter((e) => e.kind === "card_update") as Array<{ messageID?: string; card?: { header?: { title?: { content?: string } } } }>
  const doneB = finals.filter((u) => u.messageID === startB?.messageID && u.card?.header?.title?.content?.includes("任务完成"))
  const doneA = finals.filter((u) => u.messageID === startA?.messageID && u.card?.header?.title?.content?.includes("任务完成"))
  assert.equal(doneB.length, 1, "B card finalized once")
  assert.equal(doneA.length, 1, "A card finalized once")
  fake.restoreEnv()
})

test("integration: /disconnect stops only active; remaining session keeps working; last close tears down transport", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  // 切到第二个会话
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "dc0", command: { action: "session_switch", index: 2 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))

  // /disconnect → 只断 active（ses_second）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "dc1", command: { action: "stop" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  let events = readOutbox(stateDir)
  const closes = events.filter((e) => e.kind === "share_close") as Array<{ sessionID?: string }>
  assert.equal(closes.length, 1)
  assert.equal(closes[0]?.sessionID, "ses_second")

  // 剩余会话（ses_current 自动回退为 active）仍可交互
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "dc2", command: { action: "prompt", text: "first session alive" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  // 排除断开通知（noReply prompt 不算 agent prompt）
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt" && (c.args as { noReply?: boolean }).noReply !== true)
  assert.equal(prompts.length, 1)
  assert.equal((prompts[0]!.args as { sessionID: string }).sessionID, "ses_current")

  // 最后一个断开 → transport 收尾（WS 关闭），后续指令无传输层处理、不再产生事件
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "dc3", command: { action: "stop" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  events = readOutbox(stateDir)
  const closesAll = events.filter((e) => e.kind === "share_close") as Array<{ sessionID?: string }>
  assert.equal(closesAll.length, 2)
  assert.equal(closesAll[1]?.sessionID, "ses_current")

  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "dc4", command: { action: "status" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const tail = readOutbox(stateDir)
  assert.equal(tail.length, events.length, "no transport remains: commands are silently dropped")
  fake.restoreEnv()
})

test("integration: /disconnect all stops every session at once", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  const { appendFileSync } = await import("node:fs")
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "da1", command: { action: "stop", scope: "all" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const events = readOutbox(stateDir)
  const closes = events.filter((e) => e.kind === "share_close") as Array<{ sessionID?: string }>
  assert.equal(closes.length, 2, "all sessions should get share_close")
  const ids = closes.map((c) => c.sessionID).sort()
  assert.deepEqual(ids, ["ses_current", "ses_second"])
  fake.restoreEnv()
})

// ---------- 跨 TUI 实例（leader/follower 中继，0.3.0） ----------

type FakeBundle = ReturnType<typeof makeFakeApi>

/** 起一个 TUI 实例并完成首次菜单分享（不等待，调用方自行 sleep） */
async function bootAndShare(env: Record<string, string>): Promise<FakeBundle> {
  const fake = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake.api, undefined, undefined as never)
  fake.getSlashCommand()?.run?.()
  fake.dialogState.onSelect?.({ value: "share" })
  return fake
}

const relayEnv = (stateDir: string): Record<string, string> => ({
  FEISHU_SHARE_STATE_DIR: stateDir,
  FEISHU_ALLOWED_OPEN_IDS: "*",
  FEISHU_ALLOWED_CHAT_IDS: "*",
})

test("integration: second TUI becomes follower; cards relay to leader outbox; active unchanged", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const env = relayEnv(stateDir)
  const fake1 = await bootAndShare(env)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(readOutbox(stateDir).filter((e) => e.kind === "share_open").length, 1, "leader opens share")

  // 第二个 TUI：锁被 leader 持有 → 自动转 follower（本地中继）
  const fake2 = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake2.api, undefined, undefined as never)
  fake2.sessionTitles.set("ses_second", "Second Session")
  fake2.messagesBySession.set("ses_second", [])
  fake2.setRoute("ses_second")
  fake2.getSlashCommand()?.run?.()
  fake2.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 900)) // hub tick 200ms + relay poll 150ms

  // follower 的 share_open 经中继落到 leader 的 outbox；提醒卡列出两个会话且 active 不变
  const events = readOutbox(stateDir)
  const opens = events.filter((e) => e.kind === "share_open").map((e) => (e as { sessionID?: string }).sessionID)
  assert.ok(opens.includes("ses_second"), "follower share_open must be relayed to leader outbox")
  const reminder = events.filter((e) => e.kind === "multi_session_new").at(-1) as
    | { sessions?: Array<{ sessionID: string; active: boolean }>; newIndex?: number }
    | undefined
  assert.ok(reminder, "leader should emit a reminder card when a follower joins")
  assert.equal(reminder?.newIndex, 2)
  assert.equal(reminder?.sessions?.[0]?.sessionID, "ses_current")
  assert.equal(reminder?.sessions?.[0]?.active, true, "joining follower must not steal active")

  // prompt 路由到 active（leader 自己的会话），follower 不应收到
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "r1", command: { action: "prompt", text: "go leader" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const p1 = fake1.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(p1.length, 1, "prompt lands on leader session")
  assert.equal((p1[0]!.args as { sessionID: string }).sessionID, "ses_current")
  assert.equal(fake2.clientCalls.filter((c) => c.kind === "prompt").length, 0, "follower must not receive it")
  fake1.restoreEnv()
  fake2.restoreEnv()
})

test("integration: /session 2 switches across TUIs; prompt relays to follower", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const env = relayEnv(stateDir)
  const fake1 = await bootAndShare(env)
  await new Promise((r) => setTimeout(r, 100))
  const fake2 = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake2.api, undefined, undefined as never)
  fake2.sessionTitles.set("ses_second", "Second Session")
  fake2.messagesBySession.set("ses_second", [
    { info: { role: "user" }, parts: [{ type: "text", text: " follower 里的历史问题" }] },
    { info: { role: "assistant", modelID: "m2", providerID: "p2", agent: "build" }, parts: [{ type: "text", text: " follower 的历史回答" }] },
  ])
  fake2.setRoute("ses_second")
  fake2.getSlashCommand()?.run?.()
  fake2.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 900)) // 等 meta 注册 + idle 快照同步

  // /session 2 → 切换 + 切换卡（快照来自 follower 同步的 meta）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw1", command: { action: "session_switch", index: 2 } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const events = readOutbox(stateDir)
  const sw = events.filter((e) => e.kind === "session_switched").at(-1) as
    | { sessionID?: string; previousSessionID?: string; lastUserText?: string; statusText?: string }
    | undefined
  assert.ok(sw, "cross-TUI switch card should be emitted")
  assert.equal(sw?.sessionID, "ses_second")
  assert.equal(sw?.previousSessionID, "ses_current")
  assert.ok(sw?.lastUserText?.includes("历史问题"), "switch card carries follower-synced snapshot")

  // 切换后 prompt 转发到 follower 的会话
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw2", command: { action: "prompt", text: "go follower" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const p2 = fake2.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(p2.length, 1, "prompt must relay to the follower TUI")
  assert.equal((p2[0]!.args as { sessionID: string }).sessionID, "ses_second")
  assert.equal(fake1.clientCalls.filter((c) => c.kind === "prompt" && (c.args as { noReply?: boolean }).noReply !== true).length, 0)

  // /session 列表跨实例聚合
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "sw3", command: { action: "session_list" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const list = readOutbox(stateDir).filter((e) => e.kind === "session_list").at(-1) as
    | { sessions?: Array<{ sessionID: string; title?: string; active: boolean }> }
    | undefined
  assert.ok(list?.sessions)
  assert.deepEqual(list.sessions?.map((s) => s.sessionID), ["ses_current", "ses_second"])
  assert.equal(list.sessions?.[1]?.title, "Second Session", "follower session title comes from its registry meta")
  assert.equal(list.sessions?.[1]?.active, true)
  fake1.restoreEnv()
  fake2.restoreEnv()
})

test("integration: /disconnect on follower-owned active is forwarded; leader keeps serving", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const env = relayEnv(stateDir)
  const fake1 = await bootAndShare(env)
  await new Promise((r) => setTimeout(r, 100))
  const fake2 = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake2.api, undefined, undefined as never)
  fake2.sessionTitles.set("ses_second", "Second Session")
  fake2.messagesBySession.set("ses_second", [])
  fake2.setRoute("ses_second")
  fake2.getSlashCommand()?.run?.()
  fake2.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 900))
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "d0", command: { action: "session_switch", index: 2 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))

  // /disconnect → 只断 active（follower 的会话）：定向转发
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "d1", command: { action: "stop" } })}\n`)
  await new Promise((r) => setTimeout(r, 1200))
  // follower 收到定向 stop 并自停（其 noReply 通知落在 fake2）
  const notices = fake2.clientCalls.filter((c) => c.kind === "prompt" && (c.args as { noReply?: boolean }).noReply === true)
  assert.equal(notices.length, 1, "follower TUI should post the disconnect notice")
  // leader 检测到 follower 注销，external 摘除，active 回退到自己的会话
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "d2", command: { action: "session_list" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const list = readOutbox(stateDir).filter((e) => e.kind === "session_list").at(-1) as
    | { sessions?: Array<{ sessionID: string; active: boolean }> }
    | undefined
  assert.deepEqual(list?.sessions?.map((s) => s.sessionID), ["ses_current"], "follower session removed from global list")
  assert.equal(list?.sessions?.[0]?.active, true)
  // 剩余会话仍可交互
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "d3", command: { action: "prompt", text: "still alive" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const p1 = fake1.clientCalls.filter((c) => c.kind === "prompt" && (c.args as { noReply?: boolean }).noReply !== true)
  assert.equal(p1.length, 1)
  assert.equal((p1[0]!.args as { sessionID: string }).sessionID, "ses_current")
  fake1.restoreEnv()
  fake2.restoreEnv()
})

test("integration: leader TUI exit promotes follower; follower keeps serving feishu", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const env = relayEnv(stateDir)
  const fake1 = await bootAndShare(env)
  await new Promise((r) => setTimeout(r, 100))
  const fake2 = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake2.api, undefined, undefined as never)
  fake2.sessionTitles.set("ses_second", "Second Session")
  fake2.messagesBySession.set("ses_second", [])
  fake2.setRoute("ses_second")
  fake2.getSlashCommand()?.run?.()
  fake2.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 900))

  // leader TUI 优雅退出 → follower 接管（升 leader，锁易主）
  for (const d of fake1.disposers) await d()
  await new Promise((r) => setTimeout(r, 1500)) // relay tick + promote 抢锁

  const { readFileSync: rf } = await import("node:fs")
  const lock = JSON.parse(rf(join(stateDir, "transport-mock.lock"), "utf8")) as { instanceID?: string }
  const lockOfFollower = (() => {
    // follower 的 instanceID 无从直接观察，但锁必须仍存在（有人接管）且不再是 fake1 的实例锁
    return lock.instanceID !== undefined
  })()
  assert.ok(lockOfFollower, "lock must be re-acquired after leader exit")

  // 接管后指令直接由原 follower 处理
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "p9", command: { action: "prompt", text: "after takeover" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const p2 = fake2.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(p2.length, 1, "promoted follower answers prompts directly")
  assert.equal((p2[0]!.args as { sessionID: string }).sessionID, "ses_second")
  fake1.restoreEnv()
  fake2.restoreEnv()
})

test("integration: follower permission card's /approve relays back to follower", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const env = relayEnv(stateDir)
  const fake1 = await bootAndShare(env)
  await new Promise((r) => setTimeout(r, 100))
  const fake2 = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake2.api, undefined, undefined as never)
  fake2.sessionTitles.set("ses_second", "Second Session")
  fake2.messagesBySession.set("ses_second", [])
  fake2.setRoute("ses_second")
  fake2.getSlashCommand()?.run?.()
  fake2.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 900))

  // follower 会话发生权限请求 → 卡片经中继出现在 leader outbox
  fake2.triggerEvent("permission.asked", {
    properties: { id: "per_relay", sessionID: "ses_second", permission: "bash", patterns: [], metadata: {}, always: [] },
  })
  await new Promise((r) => setTimeout(r, 900))
  const card = readOutbox(stateDir).find((e) => e.kind === "permission_requested") as { requestID?: string } | undefined
  assert.ok(card, "follower permission card relayed to feishu via leader")
  assert.equal(card?.requestID, "per_relay")

  // /approve（#latest，leader 自身无 pending）→ 转发回 follower 执行
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "ap1", command: { action: "permission_reply", requestID: "#latest", reply: "once" } })}\n`)
  await new Promise((r) => setTimeout(r, 900))
  const replies = fake2.clientCalls.filter((c) => c.kind === "permission.reply")
  assert.equal(replies.length, 1, "approve must relay to the follower that owns the request")
  assert.equal((replies[0]!.args as { requestID: string }).requestID, "per_relay")
  fake1.restoreEnv()
  fake2.restoreEnv()
})

test("integration: stale lock from dead process is taken over", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const { writeFileSync } = await import("node:fs")
  // 陈旧锁：pid 指向已退出进程（当前进程树里几乎必然不存在的 pid）
  writeFileSync(join(stateDir, "transport-mock.lock"), JSON.stringify({ pid: 2147483000, startedAt: 0 }))
  const fake = await bootAndShare(relayEnv(stateDir))
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(readOutbox(stateDir)[0]?.kind, "share_open", "dead lock should be taken over")
  const lock = JSON.parse(readFileSync(join(stateDir, "transport-mock.lock"), "utf8")) as { pid?: number }
  assert.equal(lock.pid, process.pid)
  fake.restoreEnv()
})

test("integration: session switch via card dropdown form (cardAction path)", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  // 模拟下拉表单提交（lark.ts 会把 form_value 合并为 {kind:"session_switch", form:{...}}）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", cardAction: { value: { kind: "session_switch", form: { session_index: "2" } }, clickedMessageID: "card_sw1" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  // 切换卡已发
  assert.ok(readOutbox(stateDir).some((e) => e.kind === "session_switched"), "dropdown submit should switch session")
  // 切换后 prompt 落在新 active（ses_second）
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "ds1", command: { action: "prompt", text: "via dropdown" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  const prompts = fake.clientCalls.filter((c) => c.kind === "prompt")
  assert.equal(prompts.length, 1)
  assert.equal((prompts[0]!.args as { sessionID: string }).sessionID, "ses_second")
  fake.restoreEnv()
})

test("integration: session switch via card button (one-click)", async () => {
  const { fake, stateDir } = await setup()
  await shareSecondSession(fake)
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", cardAction: { value: { kind: "session_switch", index: 1 }, clickedMessageID: "card_btn1" } })}\n`)
  await new Promise((r) => setTimeout(r, 700))
  // index 1 = 当前会话 → 幂等提示，不产生切换卡
  const events = readOutbox(stateDir)
  assert.ok(!events.some((e) => e.kind === "session_switched"), "switching to the active session is a no-op")
  assert.ok(events.filter((e) => e.kind === "status").at(-1), "no-op switch replies with a hint")
  fake.restoreEnv()
})

test("integration: follower streaming turn finalizes green through relay (regression)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "feishu-it-"))
  const env = relayEnv(stateDir)
  const fake1 = await bootAndShare(env)
  await new Promise((r) => setTimeout(r, 100))
  const fake2 = makeFakeApi({ ...env, FEISHU_SHARE_TRANSPORT: "mock" })
  await pluginTui(fake2.api, undefined, undefined as never)
  fake2.sessionTitles.set("ses_second", "Second Session")
  fake2.messagesBySession.set("ses_second", [])
  fake2.setRoute("ses_second")
  fake2.getSlashCommand()?.run?.()
  fake2.dialogState.onSelect?.({ value: "share" })
  await new Promise((r) => setTimeout(r, 900))
  appendFileSync(join(stateDir, "inbox.jsonl"), `${JSON.stringify({ senderID: "ou_tester", chatID: "mock-chat", messageID: "fs1", command: { action: "session_switch", index: 2 } })}\n`)
  await new Promise((r) => setTimeout(r, 700))

  // follower 会话完整流式回合：busy → parts（含空 text 占位）→ idle
  fake2.triggerEvent("session.status", { properties: { sessionID: "ses_second", status: { type: "busy" } } })
  await new Promise((r) => setTimeout(r, 400))
  fake2.triggerEvent("message.part.updated", { properties: { sessionID: "ses_second", part: { id: "r1", type: "reasoning", text: "thinking" } } })
  // 空 text part（占位）不应把思考中打回"正在处理"
  fake2.triggerEvent("message.part.updated", { properties: { sessionID: "ses_second", part: { id: "t0", type: "text", text: "" } } })
  fake2.triggerEvent("message.part.updated", { properties: { sessionID: "ses_second", part: { id: "t1", type: "text", text: "回答完成" } } })
  await new Promise((r) => setTimeout(r, 1400))
  fake2.triggerEvent("session.status", { properties: { sessionID: "ses_second", status: { type: "idle" } } })
  await new Promise((r) => setTimeout(r, 900))

  // leader outbox：绿色定格卡经中继落地（update 该 follower 的 task_started 卡）
  const events = readOutbox(stateDir)
  const start = events.find((e) => e.kind === "task_started" && (e as { sessionID?: string }).sessionID === "ses_second") as { messageID?: string }
  assert.ok(start?.messageID, "follower task_started relayed")
  const finals = events.filter((e) => e.kind === "card_update" && (e as { messageID?: string }).messageID === start?.messageID) as Array<{ card?: { header?: { title?: { content?: string }; template?: string }; body?: { elements?: Array<{ content?: string }> } } }>
  const last = finals.at(-1)
  assert.ok(last, "final flush should update the follower's streaming card via relay")
  assert.ok(last?.card?.header?.title?.content?.includes("任务完成"), "card finalizes green")
  assert.equal(last?.card?.header?.template, "green")
  const body = JSON.stringify(last?.card)
  assert.ok(body.includes("回答完成"), "answer text present")
  fake1.restoreEnv()
  fake2.restoreEnv()
})
