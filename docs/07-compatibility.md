# OpenCode 1.18.35 兼容性验证记录

> 验证日期：2026-10-09
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
| `permission.asked/replied` | v2 types.gen.d.ts | ✅ 集成测试（真实权限触发待真机联调） |
| `question.asked/replied/rejected` | v2 types.gen.d.ts | ✅ 集成测试（真实提问待真机联调） |
| `api.client.session.prompt({sessionID, parts})` | sdk v2 sdk.gen.d.ts（Session2） | ✅ E2E 注入成功，TUI 同 session 可见 |
| `api.client.v2.session.prompt({sessionID, prompt:{text}, delivery})` | sdk v2 sdk.gen.d.ts（Session3, durable） | ✅ 类型验证；busy steer/queue 行为待真机联调 |
| `api.client.session.abort` | sdk v2 | ✅ 集成测试 |
| `api.client.session.messages({sessionID, limit})` | sdk v2 | ✅ E2E 快照/摘要 |
| `api.client.permission.reply({requestID, reply})` | sdk v2（Permission） | ✅ 集成测试（真实审批待真机联调） |
| `api.client.question.reply({requestID, answers})` | sdk v2（Question，`answers: string[][]`） | ✅ 集成测试 |
| `api.state.session.get/status/messages` | tui.d.ts TuiState | ✅ E2E |
| `api.lifecycle.onDispose`（5s 超时清理） | 二进制 tF0 实现 | ✅ 集成测试 dispose 链路 |
| TUI 配置 `<project>/.opencode/tui.json` `plugin:[spec]` | 二进制 TuiConfig.loadState + XU0 | ✅ E2E 加载 |
| 全局 `~/.config/opencode/tui.json` | 二进制同函数 | ✅ 路径核实（用户未部署全局，避免动其配置） |
| `OPENCODE_PURE=1` 禁用插件 | 二进制 | ⚠️ 已知限制（正常环境不开启） |

## 三、版本注意点

1. `api.command.*`（legacy）在 1.18.35 标记 deprecated（"Remove in v2"）—— 本插件使用 `keymap.registerLayer`
2. TUI 事件名是 TUI 侧名称（`permission.asked` 等），与服务端原始事件名不同——不要混用
3. `client.session.prompt`（parts 版）busy 时返回 SessionBusyError；远程续聊必须用 `client.v2.session.prompt`
   （durable，支持 `delivery: "steer" | "queue"`）
4. `QuestionAnswer = Array<string>`：`question.reply` 的 `answers` 形如 `[["选项A"]]`
5. `@opencode-ai/plugin` 的 `tui` 与 `server` 导出互斥（`server?: never`）——本插件为纯 TUI 插件，无需 server 侧
6. 插件以绝对路径注册且零运行时 npm 依赖（`@opencode-ai/plugin` 仅类型导入，构建后擦除）；
   飞书 SDK（`@larksuiteoapi/node-sdk`）按需 `await import()`，仅 lark 传输层启动时加载

## 四、E2E 验证（真实 TUI，expect 驱动 pty）

完整记录见 `docs/02-poc-results.md`（Mock 飞书通道）：

- 插件加载、`/feishu` 命令、菜单、share 绑定、快照通知
- 同一 session 内注入 prompt → TUI 实时可见 → PONG 回复 → 完成通知
- 入站 status/stop 指令 → outbox 响应
- 全程单 session、单 TUI 进程、无新建会话

## 五、尚未在真实飞书环境验证

- WS 长连接真实建连、事件接收、消息发送（需真实 App 凭证，人工联调步骤见 docs/05）
- 真实权限/提问事件的端到端（自动化测试以事件注入方式覆盖了插件侧逻辑）
- busy 会话下 steer/queue 的真实表现（SDK 语义已核实，逻辑已实现）
