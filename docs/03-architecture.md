# 架构设计

## 1. 总体结构

```
┌─────────────────────────── OpenCode TUI 进程（1.18.35, 内嵌 Bun） ───────────────────────────┐
│                                                                                              │
│  用户在 TUI 输入 /feishu                                                                      │
│        │                                                                                     │
│  ┌─────▼──────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────┐    │
│  │ Plugin 入口 │──▶│ ShareState   │──▶│ Transport    │──▶│ OpenCode 本地 Server（既有）  │    │
│  │ (index.ts)  │   │ Manager      │   │ (mock|lark)  │   │  session.prompt / abort /    │    │
│  └─────▲──────┘   └──────────────┘   └──────┬───────┘   │  permission.reply / ...      │    │
│        │                                    │           └──────────────────────────────┘    │
│  ┌─────┴────────────┐                       │                                                │
│  │ TUI Event Bus    │                       ▼                                                │
│  │ session.status   │               ┌──────────────┐                                        │
│  │ session.error    │               │ 飞书开放平台   │                                        │
│  │ permission.asked │◀──────────────│ (WS 长连接)   │◀── 用户在飞书发指令/审批                 │
│  │ question.asked   │    通知（渲染/节流）└──────────────┘                                        │
│  └──────────────────┘                                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

关键点：插件运行在 TUI 进程内，通过 TUI 注入的 `api.client`（连接本地 OpenCode server 的官方 v2 SDK client）
操作**当前已存在的 session**——不新建 session、不启动平行实例。飞书通信是唯一外联，走官方 SDK 的
WebSocket 长连接（出站主动连接飞书，无需公网端口/回调服务）。

## 2. 模块职责

| 模块 | 职责 | 关键接口 |
|---|---|---|
| Plugin 入口 `index.ts` | 注册 `/feishu` 命令与菜单、订阅 TUI 事件、编排分享生命周期、流式任务卡状态机、入站命令处理（含 prompt 排队、`#latest/#n` 选择器解析）、组装其余模块 | `export const tui: TuiPlugin` |
| `share-state.ts` | 会话级分享状态机：默认 unshared；share 绑定 (sessionID, chatID)；stop 解绑；`routeCommand` 保证远程命令只作用于被分享 session | `share/stop/isShared/current` |
| `config.ts` | 环境变量加载（stateDir、白名单、传输层、凭证） | `loadConfig(env)` |
| `security.ts` | 发送者/会话白名单（默认拒绝）+ 审计日志 | `checkInbound/audit` |
| `router.ts` | 飞书消息/卡片按钮 → `InboundCommand`：**纯文本直接作为 prompt**，斜杠指令解析，`cardActionToCommand` 白名单解析按钮 value | `parseFeishuCommand/cardActionToCommand` |
| `renderer.ts` | `OutboundEvent` → 飞书 JSON 2.0 交互卡片（markdown/原生 table/按钮/表单；超长分段、超大表格回退代码块；不发敏感内容，不调用 LLM） | `renderCards/renderStreamingCard/renderProcessedCard` |
| `session.ts` | session 消息摘要（lastAssistantText / summarize） | 纯函数 |
| `transport/mock.ts` | JSONL 收发，自动化测试用；offset 起点天然防旧积压；支持模拟卡片点击 | `FeishuTransport` |
| `transport/lark.ts` | 飞书官方 SDK **LarkChannel**（WS 长连接）；ReplayGuard LRU 防重放；卡片回调 3s 内同步应答 | `FeishuTransport` |

`FeishuTransport` 统一接口：
```ts
start(): Promise<void>          // 建立连接（mock: 标记 offset；lark: LarkChannel WS 长连接）
stop(): Promise<void>
send(event: OutboundEvent): Promise<string | undefined>   // TUI → 飞书；返回 message_id（流式更新用）
updateCard(messageID, card): Promise<void>                // 原地更新已发卡片（流式刷新/点击后置灰）
onInbound(handler): void                                   // 飞书 → TUI 文本指令
onCardAction(handler): void                                // 飞书 → TUI 卡片按钮/表单回调
```

## 3. 关键数据流

### 3.1 开启分享（TUI → 飞书）
1. `/feishu` → DialogSelect 菜单 → `share`
2. 校验 `api.route.current` 处于 session 路由，取 sessionID
3. `ShareStateManager.share(sessionID, chatID)`（幂等；已有其他绑定则拒绝）
4. `transport.start()` + `send(share_open, session快照)` —— 先同步当前状态再接续事件

### 3.2 任务事件（TUI → 飞书，流式任务卡）
- `session.status: busy` → 若去重集合未记录 → 发 `task_started` 卡片并开始**流式刷新**（≥1.2s 节流）：
  - `message.part.updated`（text）→ 正文流式（尾部 `▌`）
  - （tool）→ 活动时间线（最近 6 条：✓/⟳/✗/…），question 工具只显示「等待你的回答」
  - （reasoning 且尚无正文）→ 「🤔 思考中…」
  - 远程 prompt 排队时显示「📥 排队 prompt：N 条」
- `session.status: retry` → 原地在流式卡上提示限流重试（无流式卡时发一次性 `task_retry` 通知）
- `session.status: idle` → 流式卡**原地定格**为绿色「✅ 任务完成」（承担完成通知，不再重复发消息）
- `session.error` → 流式卡原地变红「❌ 执行失败」（无流式卡时发 `task_failed`）
- `permission.asked` → 记入 pending（带序号）→ `permission_requested` 卡片（带三个审批按钮）
- `question.asked` → `question_asked` 卡片（单问题+少选项=按钮直答；多问题/多选=表单；「✍️ 其他答案」= 原地输入表单）
- `message.part.updated`（用户消息文本 part）→ `tui_input` 镜像卡片（把 TUI 本地输入同步到飞书；60s 内插件注入的 prompt 回声会被抑制）
- 提问被回答后 agent 继续产出：旧流式卡定格，后续回复自动开**新流式卡**（`task_resumed`），保证回复在消息流底部可见
- 只转发**被分享 session** 的事件；`share.stop()` 后静默

### 3.3 远程命令（飞书 → TUI）
1. WS 收到 `im.message.receive_v1` → ReplayGuard（event_id/message_id 去重）
2. `parseFeishuCommand`（mention 剥离、未知斜杠指令忽略、**纯文本 = prompt**）
3. `Security.checkInbound`（白名单，默认拒绝 + 审计）
4. `ShareStateManager.routeCommand`（必须是被分享的 sessionID）
5. 分发：
   - `prompt` → `client.session.prompt({sessionID, parts, model, agent})`（经典 parts 版；显式沿用会话最后一条
     assistant 消息的模型/Agent，与 TUI 本地提交行为一致）；busy 时进入**插件自管队列**，
     idle 后依次执行（每次启动一个回合，等下个 idle 继续）
   - `permission_reply` → 解析 `#latest/#n` → 必须在 pending 列表 → `client.permission.reply({requestID})`
   - `question_reply` → 同上（`answers: string[][]`，多问题/多选表单一次提交全部）→ `client.question.reply({requestID, answers})`
   - `model_list/model_switch`、`agent_list/agent_switch` → 列表缓存（保证 list 与 switch 编号一致）→ `client.v2.session.switchModel/switchAgent`
   - `abort` → `client.session.abort`；`status/recent` → 查询回发；`stop` → 解绑（不 abort）

### 3.4 卡片按钮/表单回调（飞书 → TUI）
1. LarkChannel `cardAction` 事件（或同步应答路径 `card.action.trigger`）→ ReplayGuard 去重
2. 传输层把表单 `form_value` 合并进按钮 value（自定义答案提升为 `text`）→ `cardActionToCommand` 白名单解析
3. 飞书要求卡片回调 **3s 内应答**：SDK 在 `connect()` 之后注册的 `card.action.trigger` 处理器被替换为
   同步应答版——立即返回「处理中」卡（或「✍️ 其他答案」的输入表单卡，包装为官方 `{card:{type:"raw",data}}` 结构），
   业务逻辑异步执行
4. 经与文本指令相同的安全/路由路径处理后，原卡片被替换为「✅ 已处理」定格卡（按钮/表单不可再提交）

## 4. 生命周期与清理

- 插件随 TUI 加载，但 transport 仅在 share 时启动（默认零外联、零开销）
- `api.lifecycle.onDispose`：TUI 退出（含崩溃前正常清理路径）→ `stopSharing("tui exit")` → transport.stop()
- TUI 崩溃：WS 断开；飞书侧 SDK watchdog 探活后进入重连循环，重连失败则呈现离线
- 重连语义：入站只处理「连接建立之后」的新消息（mock 用 offset；lark 用 ReplayGuard + 飞书事件幂等），
  未确认的远程命令不会积压执行
- 分享状态不持久化：TUI 重启后一律回到 unshared（安全默认）

## 5. 安全设计

| 威胁 | 对策 |
|---|---|
| 未授权用户控制本地 Agent | 用户/chat 白名单 + 默认拒绝 + 审计 |
| 过期审批被复用 | 权限批复必须命中当前 pending 的 requestID；处理后立即移除 |
| 飞书重试导致重复执行 | ReplayGuard LRU（消息 + 卡片回调同键去重）+ mock offset 起点 |
| 伪造卡片按钮 value 执行任意指令 | value 由渲染器写入；`cardActionToCommand` 仅接受已知 kind/字段，解析结果仍走白名单与 pending 校验 |
| 密钥泄露 | 凭证仅经环境变量；渲染器/审计/日志不含密钥；`__help__` 通知无敏感内容 |
| 无鉴权 OpenCode HTTP API 暴露 | 插件不创建任何监听端口；全部为出站连接 |
| 会话串扰 | routeCommand 严格校验 sessionID；切换 session 不自动分享 |
| 敏感内容外泄 | 通知默认截断摘要，不发送文件 diff/环境变量；权限标题仅含 permission 名 |

## 6. 设计取舍

- **交互卡片 + 按钮直批**：权限/提问在卡片上点按钮即完成（等效文本指令，走同一安全路径），
  保留文本指令作为降级路径（`/approve` `/answer`）。卡片为 JSON 2.0 结构，按钮回调数据必须内嵌在
  `behaviors.callback.value`（顶层 value 一旦声明 behaviors 即失效，实测确认）。
- **经典 parts prompt + 插件自管队列**（而非 v2 durable prompt）：durable 版在部分租户/模型配置下会因
  server 默认模型失效返回 401；改为读取会话最后一条 assistant 消息的模型/Agent 显式带上，
  busy 语义由插件队列自行实现（idle 后依次执行），行为与 TUI 本地排队一致。
- **流式单卡而非多条消息**：任务过程原地刷新一张卡（1.2s 节流），完成后定格，避免消息刷屏；
  回答后续段开新卡，保证「回复」在飞书消息流底部可见。
- **不持久化分享状态**：重启即 unshared 比恢复共享更安全，避免「以为没共享其实共享了」。
- **单文件传输接口**：mock/lark 实现同一 `FeishuTransport`，测试与真实平台解耦。
