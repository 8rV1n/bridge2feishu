# AGENTS.md — opencode-feishu-share 开发指南

给 AI agent / 新维护者的仓库速览：项目是什么、怎么构建测试、改代码前必须知道的坑。
README.md 面向使用者；本文面向改动本仓库代码的人。

## 项目概述

OpenCode 原生 TUI 插件（不改 OpenCode 内核、无额外进程、无公网端口）：
把当前 OpenCode session 分享到飞书，双向交互。

- **TUI → 飞书**：分享开启/关闭、流式任务卡（开始→刷新→完成/失败定格）、权限审批卡（按钮直批）、Agent 提问卡（按钮/表单直答）、TUI 本地输入镜像、agent/model 切换同步
- **飞书 → TUI**：纯文本=prompt（busy 时排队）、`/status` `/recent` `/stop` `/approve` `/deny` `/answer` `/model` `/agent` `/disconnect`；卡片按钮/表单等效指令
- 适配 OpenCode **1.18.35** TUI Plugin API（`@opencode-ai/plugin` + `@opencode-ai/sdk`，版本锁在 devDependencies）

## 常用命令

```bash
npm run build        # tsc 编译 src/ → dist/（测试从 dist 导入，改完 src 必须先 build）
npm run typecheck    # tsc --noEmit
npm test             # build + node --test tests/*.test.ts（node:test，非 jest/vitest）
npm pack             # 出包 opencode-feishu-share-x.y.z.tgz（*.tgz 已 gitignore）
```

无 lint 配置；`npm run typecheck` + `npm test` 是合入前的最小验证。

## 架构与数据流

```
飞书(WS) ←→ transport/{lark,mock}.ts ←→ index.ts(tui 插件入口) ←→ OpenCode TUI api.*
                                  ↓
            router.ts(入站解析) / renderer.ts(出站卡片) / share-state.ts(分享状态机)
            security.ts(白名单+审计) / session.ts(消息摘要) / config.ts(环境变量)
```

| 文件 | 职责 | 关键点 |
|---|---|---|
| `src/index.ts` | 插件入口 `tui()`：事件订阅、流式卡状态机、入站命令分发 | 一切时序逻辑都在这里 |
| `src/router.ts` | 飞书文本/按钮 value → `InboundCommand`（纯函数） | 纯文本默认为 prompt；未知斜杠指令返回 null |
| `src/renderer.ts` | `OutboundEvent` → 飞书 JSON 2.0 卡片（可能多张） | 超长分段 `splitContent`（字符+字节双上限） |
| `src/types.ts` | `OutboundEvent` / `InboundCommand` / `FeishuTransport` 接口 | 新事件/新传输方法先改这里 |
| `src/transport/lark.ts` | 官方 SDK LarkChannel WS + ReplayGuard + 卡片回调同步应答 | `sendCard`/`updateCard`/`onInbound`/`onCardAction` |
| `src/transport/mock.ts` | JSONL 收发件箱（`inbox.jsonl`/`outbox.jsonl`），无凭证可跑全流程 | 测试与联调基础设施 |

**事件方向速查**：
- 出站（TUI→飞书）：`emit({kind: ...})` → transport.send → renderCards。kind 见 `types.ts` OutboundEvent。
- 入站（飞书→TUI）：transport.onInbound → `handleInbound`（switch on `cmd.action`）。
- 卡片按钮：`transport.onCardAction` + `cardActionToCommand`，处理后用 `renderProcessedCard` 原地置灰。

## 改代码前必读的坑（历史 bug 教训）

### SDK / OpenCode API
1. **v2 SDK 的 `AgentV2Info` 字段是 `id`，没有 `name`**；且 **`client.v2.agent.list()` 的 `res.data` 是 `{ location, data: AgentV2Info[] }` 包装对象，不是数组**——直接当数组 `.filter` 会抛 TypeError，被 `void handleInbound()` 静默吞掉，表现为 `/agent` 完全没反应（实测踩坑）。`handleInbound` 已有 try/catch 兜底回错误卡，新命令分支异常会以卡片形式暴露。
2. **远程 prompt 的 model/agent 以服务端会话状态为准（v2 `session.get`）**：TUI 本地状态（`api.state.session.get`）对外部/API 切换可能滞后甚至不更新，"最后一条 assistant 消息"更是永远是旧值——两者都只作兜底。否则远程 `/agent`、`/model` 切换会被下一条 prompt 钉回旧值（"切换无效"的经典根因）。注意 `session.get` 的返回也可能是 `{ data: SessionV2Info }` 包装。另外 TUI 界面的 agent/model 角标不随外部切换刷新，那是 TUI 自身渲染行为，插件无法触发。
3. **v1 prompt（`api.client.session.prompt`）支持 `noReply: true`**：消息进会话但不触发 agent 回复。用于"会话内持久通知"（如断开提示）。
4. **TUI 本地切换 agent/model 的服务器事件**是 `session.next.agent.switched` / `session.next.model.switched`（properties: `{sessionID, agent}` / `{sessionID, model: {id, providerID}}`）。
5. **v2 `switchAgent`/`switchModel`**：`api.client.v2.session.switchAgent({sessionID, agent})` / `switchModel({sessionID, model: {id, providerID}})`。
6. **插件自己调 switch API 后，服务器也会广播上述事件**——用 `remoteSwitchUntil` 时间窗（5s）抑制回声，否则飞书收到两张切换卡。

### 飞书卡片
7. **飞书按 UTF-8 字节截断超长卡片内容**（显示成 `…`），纯中文约 1K+ 字就中招。所以：
   - 分段上限是**字符 1600 + 字节 3000 双上限**（`BODY_LIMIT` / `BODY_BYTE_LIMIT`），`splitContent` 已做字节感知；
   - 流式卡**成功定格时超长要分页**：首页 `updateCard` 原地定格，续页 `transport.sendCard` 新增卡片（标题带 `(x/x)`）；
   - 流式**中间刷新**超长只保留尾部（`cardTail`，`…\n` 前缀标记前文略）。
8. **JSON 2.0 按钮回调的 value 必须内嵌在 `behaviors: [{type:"callback", value}]`**；顶层 `value` 声明 behaviors 后失效。
9. **卡片回调的同步应答体必须是 `{card: {type: "raw", data: 卡片JSON}}`** 包装，直接返回裸卡片 JSON 被飞书静默丢弃（200673）。SDK 在 `connect()` 内部才注册 `card.action.trigger` 处理器，**替换它必须在 connect() 之后**（`lark.ts` 里有详细注释）。
10. 卡片 markdown 里 `{{` 是变量语法，注入前必须 `escapeLarkMd`。

### 时序 / 去重
11. **防重放双保险**：SDK 事件层 ReplayGuard（LRU）+ 键格式 `${messageID}:${senderID}:${JSON.stringify(value)}`；同步应答路径与 SDK 事件路径共用同一键，同一次点击不会执行两遍。
12. **TUI 输入镜像防回声**：飞书注入的 prompt 会以 user message part 形式流回来，`recentInjected`（60s 窗口文本匹配）负责跳过；新增注入路径时记得先 `recentInjected.set(text, Date.now())`。
13. **忙时排队语义**：会话 busy 时远程 prompt 进 `promptQueue`（流式卡显示 📥 行），idle 后 `drainPromptQueue` 逐条执行；`submitPrompt` 报 busy 也会入队。
14. **提问回答后的续段**：question 工具 part 状态变 completed/error 时定格旧卡（`onQuestionResolved`），后续回复开新流式卡（`resumeStreaming`/`resumeBuffer`/`openResumeCard`）。TUI 事件总线不发 question.replied（API 应答不触发），以工具 part 状态为准。
15. **权限审批绑定 requestID**：只能批复当前 pending 的请求（`pendingPermissions`/`pendingQuestions` + 顺序数组），过期请求拒绝。审批卡要展示完整路径：`patterns` + metadata 详情（`permissionDetail`）。

## 测试约定

- `tests/plugin.test.ts`：**集成测试**。`makeFakeApi()` 造 fake TUI API 驱动真实 `tui()` 入口；mock 传输层轮询间隔 400ms，断言前要 `await new Promise(r => setTimeout(r, 700))`。发入站指令 = 往 `inbox.jsonl` 追加一行；看出站 = 读 `outbox.jsonl`（`readOutbox`）。模拟 TUI 事件 = `fake.triggerEvent(type, {properties})`。
- `tests/feishu.test.ts` / `tests/unit.test.ts`：renderer/transport/session/config/security 纯单元。
- **测试强制 `FEISHU_SHARE_TRANSPORT=mock`**，防止 shell 里的真实 FEISHU_* 泄漏进测试。
- fake api 的 v2 client 缺方法会以 `undefined` 报错——给新 API 加测试时同步扩展 `makeFakeApi`。

## 环境变量

`FEISHU_SHARE_TRANSPORT`(mock|lark)、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DEFAULT_CHAT_ID`、`FEISHU_ALLOWED_OPEN_IDS`、`FEISHU_ALLOWED_CHAT_IDS`、`FEISHU_DOMAIN`、`FEISHU_RECEIVE_ID_TYPE`；调试开关 `FEISHU_SHARE_DEBUG=1`（写 `<stateDir>/plugin-debug.log` 与 `lark-sdk.log`）。全部见 `src/config.ts` 与 `.env.example`。

## 安全规则（不可违反）

- 默认拒绝：白名单外的 sender/chat 一律拒绝并写 `audit.jsonl`。
- 密钥只经环境变量；代码、日志、卡片、测试不得出现 App Secret。
- 卡片按钮 value 由渲染器写入、`cardActionToCommand` 白名单解析；不要把用户输入直接拼进回调 value 再执行。
- 绝不把用户数据/文件外发到第三方地址。

## 发布

1. 改 `package.json` version + `src/types.ts` 的 `PLUGIN_VERSION`（保持一致）。
2. `npm run typecheck && npm test` 全绿。
3. `npm pack`，把 `*.tgz` 给使用者登记到 tui.json 的 plugin 字段（见 README 快速开始）。
