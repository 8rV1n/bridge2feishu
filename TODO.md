# TODO — 多 Session 分享与切换（已完成并发布）

> 状态：**已完成 & 已发布 v0.2.0**（2026-10-18 提交 2f3b85b + tag，`*.tgz` 已产出）
> 目标版本：0.2.0（同 TUI 多会话 + 跨 TUI leader/follower 中继一并交付）
> 背景_issue：单 session 分享已稳定（0.1.x）；需支持同 TUI 多 session 与跨 TUI 进程并行分享，并在飞书端统一切换。

## 1. 需求（用户原话归纳）

1. 支持多 session 连接与切换。
2. 当没有 session 连接时，**第一个分享的 session 自动成为默认 session**（飞书指令的作用对象）。
3. 已有多个 session 分享时，**新 session 分享要在飞书端明确提醒**（不打断当前）。
4. 飞书端新增 **`/session` 指令**：查看列表 + 切换当前 session；**切换时附带**：简要历史 summary、最新一次交互记录、明确的"已切换"提醒（细节见 D3 三段式）。
5. **非破坏性**：已有 session 分享时，新 session 的分享**不影响正在进行的飞书 session**（会有提示）。

## 2. 现状与差距（改动前必读）

| 现状（0.1.x） | 差距 |
|---|---|
| `ShareStateManager` 单目标 `current: ShareTarget \| null`，第二次 `share()` 直接拒绝 | 需改为多目标：`Map<sessionID, ShareTarget>` + `activeSessionID` |
| `sharedSession()` = `share.current?.sessionID`，所有入站指令都路由到它 | 需路由到 active session；`routeCommand` 校验逻辑随之调整 |
| `streaming` 是单个全局对象（流式卡状态机） | 需按 session 隔离：`Map<sessionID, Streaming>` |
| `promptQueue` 全局一个数组 | 需按 session 隔离：`Map<sessionID, string[]>` |
| `stopSharing` 连人带transport全部拆除 | 多 session 下停止单个 session 不应关 WS；最后一个才关 |
| 卡片标题已带 `sessionTag`（会话摘要） | 继续沿用；非当前 session 的卡片需要更明显的归属标记 |
| 飞书文本指令解析（router.ts）无 `/session` | 新增 `/session`、`/session <n>` |

## 3. 设计决策（全部已定案并实施）

- [x] **D1 默认/active 语义**：`activeSessionID` = 飞书指令（prompt、/status、/stop、/approve…）的作用对象。
  - 第一个分享 → 自动成为 active（满足需求 2）。
  - 后续分享 → **不改变 active**（满足需求 5），只发提醒卡。
- [x] **D2 提醒卡样式**：新 session 分享时发 `multi_session_new` 卡：列出全部已分享 session（当前 active 加 ★ 标记），含「切换到此会话」按钮（behaviors callback，值由渲染器写入）。
- [x] **D3 `/session` 语法**：`/session` = 列表（含序号、标题、★当前）；`/session <n>` = 切换到第 n 个（分享顺序，切换后不漂移）。切换卡三段式（标题即提醒 + 会话概览 + 最近一次交互，任一缺失显示"（无）"）。**增强**：列表卡 ≤4 会话给一键按钮行、>4 给下拉表单。
- [x] **D4 停止语义**：`/disconnect` = 断开当前 active（可为跨实例会话，定向转发）；`/disconnect all` = 全部断开；零残留才关 transport。TUI 菜单 Stop 只停本进程 active。
- [x] **D5 多 session 事件并发**：所有已分享 session 的事件都到飞书；流式卡按 session 隔离并发；非 active 会话卡标题带「（后台）」前缀。
- [x] **D6 chatID 模型**：每 target 自带 chatID；入站指令按 `ctx.chatID → sessionID` 精确路由（比 active 优先级高），多会话同 chat 时取 active。
- [x] **D7 忙时排队**：`promptQueues` per-session；跨实例 prompt 允许直达属主 session（经中继转发）。

## 4. 实施步骤

1. **types.ts**：`OutboundEvent` 新增 `multi_session_new`（新 session 提醒）、`session_list`、`session_switched`；`ShareTarget` 不变。
2. **share-state.ts**（核心）：
   - `targets: Map<sessionID, ShareTarget>`、`activeSessionID`、`shareOrder: sessionID[]`
   - `share()`：首个→active；后续→仅加入+返回 `{ already: false, isActive: false }`
   - `routeCommand(sessionID)`：改为「该 session 是否已分享」
   - `stop(sessionID?)`：单 session 停止；返回剩余数量，供上层决定是否关 transport
   - `active` getter / `setActive(sessionID)`
3. **index.ts**：
   - `startSharing`：分享已有 active 时走"新增"分支 → emit 提醒卡（需求 3/5）
   - `streaming` / `promptQueue` / `resumeBuffer` 等 → `Map<sessionID, …>`（最大改动点，注意 `flushStreaming`/`drainPromptQueue`/`onQuestionResolved` 全部带 sessionID）
   - `handleInbound`：新增 `session_list` / `session_switch` 分支；`prompt`、`status`、`abort` 等目标从 `sharedSession()` 改为 `activeSession()`（或按 ctx.chatID 映射，见 D6）；`session_switch` 成功后组装「已切换」卡（D3 三段式：切换提醒 + 历史 summary + 最新交互，历史部分复用 `buildSnapshot`/`buildStatusText`/`summarize`）
   - `stopSharing`：改为 `stopOne`（剩余>0 则只清理该 session 的 pending/streaming 状态）
   - 事件订阅（session.status / part.updated / permission / question / 切换同步）按 session 隔离状态
4. **router.ts**：新增 `/session`、`/session <n>` 解析（未知序号回错误卡）。
5. **renderer.ts**：三种新卡（列表/切换/新 session 提醒），沿用 `sessionTag`；`session_switched` 卡按 D3 三段式渲染（标题即提醒，正文 = 历史 summary 段 + 最新交互段，交互段用引用/分隔线区分 user/assistant）；按钮 value 走 `cardActionToCommand` 白名单。
6. **transport**：无需改动（`sendCard`/`updateCard` 已就绪）。
7. **测试**（`tests/plugin.test.ts` 为主）：
   - 首个分享自动成为 active；第二个分享不改变 active 且发出提醒卡
   - `/session` 列表含序号与 ★；`/session <n>` 切换后 prompt 路由到新 active
   - `/session <n>` 切换卡包含：切换提醒文案、历史 summary（标题/消息数）、最新一次交互（user + assistant 文本，缺失时显示占位）
   - 多 session 并发流式：两个 session 各自独立流式卡（互不覆盖 messageID）
   - `/disconnect` 只断 active；剩余 session 的 transport 仍可用；最后一个断开时 transport 关闭
   - 回归：现有 74 个测试全绿（share 单数语义的旧用例需改写）

## 5. 验收标准

- [x] 需求 1-5 全部有集成测试覆盖
- [x] 切换体验：`/session <n>` 的回复卡能让用户不看 TUI 就知道"切到了哪个会话、这个会话之前聊了什么、最近一次交互是什么"
- [x] `npm run typecheck && npm test` 全绿（最终 100 个测试）
- [x] 真实飞书手测（2026-10-18）：跨 TUI 分享 A/B、B 接入提醒卡、`/session 2` 切换卡含历史与最近交互、prompt 落属主 TUI、`/disconnect` 定向断开、leader 退出 follower 接管——全部通过（含一次"卡在正在处理"的误报，经飞书服务端 API 核实为截图时序，绿卡 0.5s 后已落地）
- [x] README / AGENTS.md / docs 同步更新（AGENTS.md 坑 17/18/19、多 session 语义、发布流程）

## 6. 风险与备注

- **streaming 状态机改造是最大风险点**：resume/提问续段/openResumeCard 与 session 的绑定关系要逐个核对，防止 A/B 会话卡片串台。
- **pendingPermissions/pendingQuestions** 按 requestID 全局唯一，逻辑可不动；但卡片 note 的 requestID 建议附带 session 归属提示。
- **序号稳定性**：`/session <n>` 用分享顺序而非列表渲染顺序，避免切换后序号漂移引起误切。
- 飞书卡片按钮的 callback value 只允许白名单字段（安全规则不变）。

## 7. 实施记录（0.2.0，2026-10-17）

- `npm run typecheck && npm test` 全绿（99 个测试，含 6 个新增多 session 集成测试 + 改写的 share-state 单测 + 渲染/路由单测）。
- 实现要点：`share-state.ts` 重写为多目标（`targets` Map 即分享顺序 + `activeSessionID` + `stopOne`/`stopAll`）；`index.ts` 的 `streaming`/`promptQueues`/`resumeStates` 全部 `Map<sessionID, …>`；`resolveTargetSession` 按来源 chat 精确路由（D6）；`session_switch` 三段式卡（D3）；`stopSharing(reason, scope)`（D4）；`multi_session_new`/`session_list`/`session_switched` 三种新卡（D2/D5 的（后台）标记走 sessionTitle 注入）。
- 顺手修的存量 bug：`summarize().lastUserText` 原来走 `lastAssistantText`（只认 assistant 角色）永远返回 undefined，改为 `textOfMessage` 提取（AGENTS.md 坑 17）。
- 与计划的差异：D2 的「切换到此会话」按钮放在 `multi_session_new` 提醒卡上；`session_switched` 卡标题直接承载 D3 第一段的「明确提醒」。

## 8. 实施记录（二）：跨 TUI 进程并行分享（0.2.0 同版交付，2026-10-18）

真实飞书首测发现：用户先后开**多个 TUI 进程**各分享一个 session → 同一 App 多条 WS 连接被飞书随机分流指令 → "回话错乱"（lark-sdk.log 实锤：两条不同 device_id 的连接）。用户确认需求就是跨 TUI 进程并行 + 飞书端统一切换。实施「leader/follower 本地中继」：

- `lock.ts`：实例锁（`instanceID` = pid+随机，陈旧锁接管）
- `relay.ts`：中继协议——follower 注册表（`<stateDir>/relay/<instanceID>-meta.json`，含会话+切换卡快照）+ up/down JSONL（卡片操作/指令派发/回执）+ hub 游标（leader 更替不重放）
- `transport/relay.ts`：follower 传输层（实现 `FeishuTransport`，卡片渲染/流式/队列逻辑零改动）；leader 存活监视，死亡自动抢锁接管升 leader
- `hub.ts`：leader 侧枢纽——扫描注册表收编 external 会话、泵 follower 卡片到真实 transport、记录 messageID/requestID 归属（卡片按钮与 `/approve`/`/answer` 回送属主）
- `share-state.ts`：`externals`（跨 TUI 会话入全局列表/序号/active 回退）；跨实例指令带 `targetSessionID` 定向转发
- `index.ts`：角色选举（锁空闲=leader/被占=follower）、跨实例路由、`/session` 聚合列表与切换（external 快照渲染切换卡）、busy 未就绪期 parts 缓冲（`pendingParts`，中继延迟不丢正文）
- 测试 94 个全绿（新增 6 个跨 TUI 集成：follower 接入/跨实例切换与路由/定向断开/leader 退出接管/权限转发/陈旧锁接管）
- 后续增强（同日）：`/session` 列表卡支持卡片直接切换——≤4 个会话给一键按钮行（当前会话 ★ 不高亮），>4 个给下拉表单（select_static + 切换按钮，复用 question_form 的 form_value 合并机制，`cardActionToCommand` 解析 `form.session_index`）；共 99 个测试全绿
- 约束：同机共享 `FEISHU_SHARE_STATE_DIR`；跨机器需各配不同 `FEISHU_APP_ID`

## 9. 发布记录

- **v0.2.0**（2026-10-18）：提交 2f3b85b（含 0.2.0 全部功能：同 TUI 多会话 + 跨 TUI 中继 + 卡片切换交互 + 空文本防回退等修复）；`npm run typecheck && npm test` 100/100 全绿；`npm pack` 出 `opencode-feishu-share-0.2.0.tgz`（53K）；tag `v0.2.0`。最后一步：修复空 text part 回退与同步应答文案后终验 100 个测试。

## 10. 下一步候选（未排期）

- **流式刷新延迟**：中继链路下卡片刷新 ~1.2s 间隔 + ~0.4s 跳转，长回合观感偏慢；可评估飞书 cardkit 流式接口
- **移动端卡片更新渲染滞后**：已打开的聊天里更新卡有时不即时重绘（飞书客户端行为，进出聊天可见新内容）——关注飞书端改进或换 cardkit
- **requestID 选择器跨实例歧义**：`#latest`/`#n` 在 leader 自身有 pending 时优先解析 leader，follower 的选择器需用卡片上的显式 requestID；可改为全局统一序号
- **跨机器多 TUI**：当前同机共享 stateDir 才能组队；跨机器方案（如经飞书群消息自举/第二 App）待定
- **会话级指令前缀**：`/s2 <text>` 之类直达指定会话的语法（D7 尾注）
