# OpenCode 1.18.35 兼容性验证记录

> 验证日期：2026-10-09（API 核实）～ 2026-10-11（真实飞书租户联调）
> 环境：macOS（arm64），Homebrew opencode 1.18.35（Mach-O，内嵌 Bun），Node 22.20（构建/测试）

## 一、API 核实方式

1. `npm pack @opencode-ai/plugin@1.18.35` / `@opencode-ai/sdk@1.18.35` → 解包读取官方类型定义
   （`dist/tui.d.ts`、`dist/index.d.ts`、`dist/v2/gen/sdk.gen.d.ts`、`dist/v2/gen/types.gen.d.ts`）
2. 从 opencode 二进制提取内嵌打包 JS（`/$bunfs/root/chunk-*.js`），核对运行时实现：
   TUI 插件运行时（TuiPluginRuntime）、TuiConfig 加载逻辑、内部插件（diff-viewer / plugin-manager /
   notifications / which-key）的真实用法

## 二、逐项兼容性清单

| API | 版本/来源 | 验证结果 |
|---|---|---|
| `TuiPluginModule = { id?, tui }` | plugin@1.18.35 tui.d.ts | ✅ 类型 + 二进制内部插件同构 |
| `api.keymap.registerLayer({ commands })` | tui.d.ts + 二进制（diff-viewer 等内部插件） | ✅ E2E 实测 `/feishu` 注册成功 |
| `slashName` / `slashAliases` | 二进制（legacy `slash:{name}` 映射到 slashName） | ✅ `/feishu` 补全与执行正常 |
| `api.ui.dialog.replace/clear` | tui.d.ts + 二进制 plugin-manager | ✅ E2E 菜单打开/关闭 |
| `api.ui.DialogSelect`（顶层 `onSelect(option)`） | tui.d.ts | ✅ E2E 菜单选择执行 |
| `api.ui.toast({variant,title,message})` | tui.d.ts + 二进制 notifications | ✅ E2E 显示 |
| `api.route.current` → `{name:"session", params:{sessionID}}` | tui.d.ts | ✅ E2E 获取当前 session |
| `api.event.on(type, handler)` | tui.d.ts（自动 dispose 包装） | ✅ E2E 事件驱动通知 |
| `session.status`（busy/retry/idle） | v2 types.gen.d.ts | ✅ E2E task_started/completed |
| `session.error` | v2 types.gen.d.ts | ✅（单测覆盖，真实失败路径未触发） |
| `permission.asked/replied` | v2 types.gen.d.ts | ✅ 集成测试 + 真实飞书联调（卡片按钮直批） |
| `question.asked/replied/rejected` | v2 types.gen.d.ts | ✅ 集成测试 + 真实飞书联调（按钮/表单/自定义答案） |
| `api.client.session.prompt({sessionID, parts})` | sdk v2 sdk.gen.d.ts（Session2） | ✅ E2E 注入成功，TUI 同 session 可见；**生产路径**：显式携带会话最后 assistant 消息的 model/agent，busy 由插件队列自管 |
| `api.client.v2.session.prompt({sessionID, prompt:{text}, delivery})` | sdk v2 sdk.gen.d.ts（Session3, durable） | ✅ 类型验证；生产未采用（部分租户下 server 默认模型失效返回 401，见「版本注意点」3） |
| `api.client.v2.session.switchModel / switchAgent` + `client.v2.agent.list` | sdk v2 | ✅ 远程 `/model` `/agent` 切换（真实飞书联调通过） |
| `api.client.session.abort` | sdk v2 | ✅ 集成测试 |
| `api.client.session.messages({sessionID, limit})` | sdk v2 | ✅ E2E 快照/摘要 |
| `api.client.permission.reply({requestID, reply})` | sdk v2（Permission） | ✅ 集成测试 + 真实飞书联调 |
| `api.client.question.reply({requestID, answers})` | sdk v2（Question，`answers: string[][]`） | ✅ 集成测试 |
| `api.state.session.get/status/messages` | tui.d.ts TuiState | ✅ E2E |
| `api.state.session.diff / todo` | tui.d.ts TuiState | ✅ `/status` 的文件变更/待办栏（真实飞书联调通过） |
| `message.part.updated` / `message.updated` 事件 | tui.d.ts | ✅ 流式任务卡刷新 + TUI 输入镜像（真实飞书联调通过） |
| `session.status: retry`（attempt/message） | v2 types.gen.d.ts | ✅ 限流重试原地提示（真实触发并验证） |
| `api.lifecycle.onDispose`（5s 超时清理） | 二进制 tF0 实现 | ✅ 集成测试 dispose 链路 |
| TUI 配置 `<project>/.opencode/tui.json` `plugin:[spec]` | 二进制 TuiConfig.loadState + XU0 | ✅ E2E 加载 |
| 全局 `~/.config/opencode/tui.json` | 二进制同函数 | ✅ 路径核实（用户未部署全局，避免动其配置） |
| `OPENCODE_PURE=1` 禁用插件 | 二进制 | ⚠️ 已知限制（正常环境不开启） |

## 三、版本注意点

1. `api.command.*`（legacy）在 1.18.35 标记 deprecated（"Remove in v2"）—— 本插件使用 `keymap.registerLayer`
2. TUI 事件名是 TUI 侧名称（`permission.asked` 等），与服务端原始事件名不同——不要混用
3. `client.session.prompt`（parts 版）busy 时返回 SessionBusyError —— 生产路径采用 parts 版 +
   显式 model/agent + 插件自管队列；`client.v2.session.prompt`（durable，steer/queue）类型存在但未采用：
   部分租户/模型配置下 durable 版按 server 默认模型提交，若该模型不可用会返回 401
4. `QuestionAnswer = Array<string>`：`question.reply` 的 `answers` 形如 `[["选项A"]]`；
   多问题表单一次提交时 answers 与 questions 按序一一对应，空数组表示该题跳过
5. `@opencode-ai/plugin` 的 `tui` 与 `server` 导出互斥（`server?: never`）——本插件为纯 TUI 插件，无需 server 侧
6. 插件以绝对路径注册且零运行时 npm 依赖（`@opencode-ai/plugin` 仅类型导入，构建后擦除）；
   飞书 SDK（`@larksuiteoapi/node-sdk`）按需 `await import()`，仅 lark 传输层启动时加载
7. 飞书卡片 JSON 2.0：按钮回调数据必须内嵌在 `behaviors:[{type:"callback",value}]`（声明 behaviors 后
   顶层 value 失效，点击无回调，实测确认）；卡片回调需在 3s 内同步应答，应答体须为官方包装
   `{card:{type:"raw",data:卡片JSON}}`，裸卡片 JSON 会被静默丢弃（200673）；SDK 的
   `card.action.trigger` 处理器在 `connect()` 之后才注册，同步应答替换必须发生在 connect 之后

## 四、E2E 验证（真实 TUI，expect 驱动 pty）

完整记录见 `docs/02-poc-results.md`（Mock 飞书通道）：

- 插件加载、`/feishu` 命令、菜单、share 绑定、快照通知
- 同一 session 内注入 prompt → TUI 实时可见 → PONG 回复 → 完成通知
- 入站 status/stop 指令 → outbox 响应
- 全程单 session、单 TUI 进程、无新建会话

## 五、真实飞书环境验证（2026-10-11，真实租户联调）

- ✅ WS 长连接建连、事件接收、交互卡片发送（`im.message.receive_v1` + LarkChannel）
- ✅ JSON 2.0 卡片按钮回调送达与执行（权限审批三按钮、单问题选项按钮、多问题/多选表单提交）
- ✅ 卡片回调 3s 内同步应答（「处理中」卡/「✍️ 其他答案」输入表单卡）
- ✅ 流式任务卡原地更新（`updateCard`）；完成后定格；失败变红；限流重试提示
- ✅ TUI 输入镜像、远程 `/model` `/agent` 切换、`/status` 上下文栏（Context/费用/文件/待办）
- 未覆盖：`OPENCODE_PURE=1` 环境下的行为（正常环境不适用）；多 TUI 进程并发分享同一飞书群（设计上互不干扰，未压力验证）
