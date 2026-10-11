# OpenCode 1.18.35 TUI 插件 API 可行性验证报告

> 验证日期：2026-10-09
> 验证方式：直接解包 npm 包 `@opencode-ai/plugin@1.18.35` / `@opencode-ai/sdk@1.18.35` 的官方类型定义，
> 并对本机安装的 opencode 二进制（Homebrew, Mach-O arm64, 内嵌 Bun 打包 JS）提取运行时实现代码交叉核实。
> 未做任何 API 猜测，全部结论来自类型定义 + 二进制内实际实现代码。

## 一、验证来源

| 来源 | 说明 |
|---|---|
| `@opencode-ai/plugin@1.18.35/dist/tui.d.ts` | TUI 插件 API 完整类型定义（`./tui` 子路径导出） |
| `@opencode-ai/plugin@1.18.35/dist/index.d.ts` | Server 插件 API 类型定义 |
| `@opencode-ai/sdk@1.18.35/dist/v2/gen/sdk.gen.d.ts` | v2 SDK Client 全部方法（session/permission/question/event...） |
| opencode 二进制内嵌 JS（`/$bunfs/root/chunk-*.js`） | TUI 插件运行时（TuiPluginRuntime）、内部插件（diff-viewer、plugin-manager、notifications、which-key）、TuiConfig 加载逻辑 |

## 二、核心结论：TUI 原生插件完全可行

**结论：`/feishu` 可以作为 TUI 原生 slash 命令注册，无需修改内核、无需独立进程、无需公网端口。**

### 1. TUI 插件模块格式（已验证）

```ts
// 插件模块默认导出或命名导出 tui：
export const tui: TuiPlugin = async (api: TuiPluginApi, options, meta) => { ... }
export const id = "opencode-feishu-share"   // 可选，推荐
// 注意：TuiPluginModule 中 server?: never —— 同一模块不能同时是 server 插件
```

二进制内内部插件实例（diff-viewer）原样代码：

```js
var qF0 = async (B) => {
  B.route.register([{ name: "diff.viewer", render: () => ... }]);
  B.keymap.registerLayer({
    commands: [{ name: "diff.open", title: "Open diff viewer",
                 slashName: "diff", category: "VCS", namespace: "palette",
                 run() { ... } }]
  });
};
var hm = { id: "diff-viewer", tui: qF0 };
```

### 2. `TuiPluginApi` 关键能力清单（全部存在于 1.18.35）

| 能力 | API | 状态 |
|---|---|---|
| **slash 命令注册** | `api.keymap.registerLayer({ commands: [{ name, title, slashName, slashAliases, category, run }] })` | ✅ 二进制验证（`/diff` `/sessions` `/editor` 等内部命令同机制） |
| 旧版命令 API | `api.command.register(cb)`（deprecated，内部转 registerLayer，`slash: {name, aliases}` 兼容映射） | ✅ 存在，不采用 |
| **当前 Session ID** | `api.route.current` → `{name:"session", params:{sessionID}} \| {name:"home"}` | ✅ |
| **SDK Client** | `api.client: OpencodeClient`（v2，已连接运行中的 server） | ✅ |
| Session 读取 | `api.state.session.get/messages/status/permission/question(sessionID)` | ✅ |
| **Prompt 注入** | `api.client.session.prompt({ sessionID, parts, delivery? })` | ✅ 支持 `delivery: "steer" \| "queue"`（busy 时可转向/排队，官方机制） |
| 中止执行 | `api.client.session.abort({ sessionID })` | ✅ |
| **权限审批** | `api.client.permission.reply({ requestID, reply: "once"\|"always"\|"reject" })` + `permission.list()` | ✅ |
| **交互问答** | `api.client.question.reply({ requestID, answers })` / `question.reject({requestID})` / `question.list()` | ✅ |
| 事件订阅 | `api.event.on(type, handler)`（自动随插件 dispose 解绑） | ✅ |
| Toast / Dialog | `api.ui.toast()`、`api.ui.DialogSelect/DialogAlert/DialogConfirm/DialogPrompt`、`api.ui.dialog` 栈 | ✅ |
| KV 存储 | `api.kv.get/set` | ✅ |
| 生命周期 | `api.lifecycle.signal`(AbortSignal) + `api.lifecycle.onDispose(fn)`（TUI 退出时 5s 超时清理） | ✅ |
| 运行时加载 | `api.plugins.add(spec)` / `install(spec)` / `activate(id)` / `deactivate(id)` —— **无需重启 TUI 动态加载** | ✅（内部 plugin-manager 即此机制） |
| 侧边栏/布局插槽 | `api.slots.register({ slots: { sidebar_title, sidebar_content, ... } })`（SolidJS 组件） | ✅ 存在（PoC 不需要） |

### 3. TUI 事件总线可用事件名（二进制内验证，payload 形如 `{type, properties}`）

用于通知飞书的核心事件：

| TUI 事件名 | 用途 |
|---|---|
| `session.status` | `properties.status.type`: `busy` / `idle` / `retry` —— 任务开始/完成 |
| `session.error` | `properties.error` —— 执行失败 |
| `session.idle` | 空闲 |
| `permission.asked` / `permission.replied` | 权限请求出现/答复（`properties.id` 为 requestID） |
| `question.asked` / `question.replied` / `question.rejected` | Agent 提问出现/答复 |
| `message.updated` / `message.removed` | 消息变化 |
| `message.part.updated` / `message.part.delta` / `message.part.removed` | 消息部分变化（节流用） |
| `session.created` / `session.updated` / `session.deleted` | 会话管理 |

内部 notifications 插件（二进制原样代码）即使用 `session.status`/`session.error`/`permission.asked`/`question.asked` 实现提醒，模式可直接复用。

### 4. SDK v2 关键签名（`@opencode-ai/sdk@1.18.35/dist/v2/gen/sdk.gen.d.ts`）

```ts
client.session.prompt({ sessionID, parts: TextPartInput[], agent?, model?,
                        delivery?: "steer" | "queue", noReply?, tools? })
client.session.abort({ sessionID })
client.session.messages({ sessionID, limit?, before? })   // 读取历史
client.permission.reply({ requestID, reply: "once"|"always"|"reject" })
client.permission.list()
client.question.reply({ requestID, answers: QuestionAnswer[] })
client.question.reject({ requestID })
client.question.list()
```

- `PermissionRequest = { id, sessionID, permission, patterns, metadata, always, tool? }`
- `QuestionRequest = { id, sessionID, questions: QuestionInfo[], tool? }`

### 5. 插件加载方式（TuiConfig 运行时，二进制验证）

- TUI 配置文件（JSONC）带 `plugin: [spec, ...]` 字段，spec 可以是 **npm 包名** 或 **文件路径**（`file://`、绝对路径、相对 cwd 路径均可）。
- 配置文件位置（按加载顺序）：全局 `~/.config/opencode/tui.json`（环境变量 `OPENCODE_TUI_CONFIG` 可覆盖）、项目级 `<project>/.opencode/tui.json`（运行时 addPlugin 的默认落点即此路径，二进制 `XU0` 函数确认）。
- 作用域判定：配置文件路径在项目目录内 → `local`，否则 `global`。
- 首次加载时 TUI 会自动把 `@opencode-ai/plugin` 安装到插件目录依赖（`waitForDependencies`）。
- **首次安装需要重启一次 TUI**（读配置）；之后可用 `api.plugins.add()` 在运行中动态加载（内部 Plugins 面板即用此能力）。

### 6. 生命周期与清理（二进制 `tF0` 函数验证）

- 每个插件有独立 AbortController + `onDispose` 队列；TUI 退出时逆序执行 dispose，单个插件 5000ms 超时。
- `event.on` 注册的 handler 自动跟踪、自动清理。
- `lifecycle.signal` abort 后应停止一切网络活动。

## 三、逐项回答任务书第一阶段的核实点

1. **TUI Plugin 注册/配置/加载方式**：✅ 见上 §5。
2. **原生命令注册能力**：✅ `registerLayer + slashName`，`/feishu` 可原生注册（prompt 中输入 `/f` 即自动补全）。
3. **当前 Session ID 获取**：✅ `api.route.current`。
4. **SDK Client 获取与生命周期**：✅ `api.client`，随 TUI 存活，TUI 退出由 `lifecycle.signal` 通知。
5. **Prompt / Abort / 消息读取**：✅ `session.prompt / abort / messages`。
6. **Session 状态与事件订阅**：✅ `state.session.status` + `event.on("session.status")`。
7. **Permission / Question 审批**：✅ `permission.reply` / `question.reply`，requestID 绑定。
8. **插件生命周期与连接清理**：✅ `onDispose` + AbortSignal，5s 超时。
9. **运行中 TUI 能否直接注入 Prompt**：✅ `client.session.prompt`，且支持 `steer/queue` 交付语义；TUI 经事件流实时显示新消息（内部通知插件同样依赖该事件流）。
10. **是否需要额外 HTTP Server**：❌ 不需要。插件运行于 TUI 进程内，经 `api.client`（本地 server）通信；飞书侧用官方 SDK **WebSocket 长连接**（WSClient），无需公网端口。

## 四、能力缺口与自行实现项

| 项 | 结论 |
|---|---|
| 飞书通信 | OpenCode 无此能力 → 自行实现（官方 `@larksuiteoapi/node-sdk` WSClient，1.74.0） |
| Session↔飞书会话绑定状态机 | 自行实现（默认 unshared；显式 share 才绑定） |
| 事件合并/节流、卡片更新 | 自行实现 |
| 白名单/鉴权/防重放 | 自行实现 |
| 多个 slash 子命令参数 | 命令 `run()` 不接收参数文本 → 采用「`/feishu` 打开交互菜单（DialogSelect）」方案 |
| 首次安装 | 需重启一次 TUI（配置加载时机），符合任务书允许范围 |

## 五、风险与版本限制

1. `api.command`（旧版）已标记 deprecated（"Remove in v2"）→ 使用 `keymap.registerLayer` 新 API。
2. TUI 事件名是 TUI 侧别名（`permission.asked` 等），与服务端事件名（`permission.v2.asked` 等）不同 —— 必须使用 TUI 侧名称。
3. `session.prompt` 为长请求（等待回合结束），必须 catch 且不阻塞命令菜单。
4. 飞书 SDK 在 Bun 内嵌运行时的兼容性需 PoC 实测（若不兼容则用裸 WebSocket 实现 Long Connection 协议，作为后备方案，不影响架构）。
5. `OPENCODE_PURE=1` 会禁用全部插件（正常环境不适用）。

## 六、最终可行性判定

**判定：全链路可行，无需替代实现。**

- `/feishu` → 原生 slash 命令 + 交互菜单 ✅
- 同 Session 续聊（不新建、不退出、不平行实例）✅（`client.session.prompt(sessionID)` + steer/queue）
- 权限/问答远程审批 ✅（requestID 绑定）
- 安全解除绑定 ✅（仅解除远程通道，不 abort 本地任务）
- 无公网端口 ✅（飞书 WS 长连接）
