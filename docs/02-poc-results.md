# Phase 2 PoC 验证记录（2026-10-09）

## 验证环境

- OpenCode 1.18.35（Homebrew arm64）
- 沙箱项目：`$TMPDIR/opencode/poc-project`，含 `.opencode/tui.json`：
  ```json
  { "$schema": "https://opencode.ai/tui.json",
    "plugin": ["<repo-root>/dist/index.js"] }
  ```
- 模型：ark-api / GLM-5.3-FLASH（用户既有配置，未做任何修改）
- 驱动方式：`expect` 驱动真实 TUI（pty），Mock 飞书传输层（JSONL outbox/inbox）

## 执行流程与结果

| # | 步骤 | 结果 |
|---|---|---|
| 1 | TUI 正常启动并加载插件（零运行时依赖、绝对路径 spec） | ✅ 插件加载无报错，`/feishu` 命令注册成功 |
| 2 | 首个 prompt 建立 session | ✅ session `ses_xxx…（已打码）` 创建 |
| 3 | `/feishu` → 菜单（Share current session / Stop / Status / PoC test prompt） | ✅ DialogSelect 菜单正常打开 |
| 4 | 选择 Share → 绑定当前 session | ✅ toast `Sharing ses_… -> mock-chat`；outbox `share_open` 含完整快照（title/messageCount/status/lastAssistantText） |
| 5 | 菜单 → PoC test prompt 注入 | ✅ `client.session.prompt` 注入 "Reply with exactly: PONG"，**同一 TUI 同一 session** 内显示该消息 |
| 6 | Agent 回复 | ✅ TUI 内渲染 `PONG`；outbox 收到 `task_started` → `task_completed(summary="PONG")` |
| 7 | 入站 status 查询（inbox.jsonl） | ✅ outbox 返回 `session/status/messages: 4/last: PONG` |
| 8 | 入站 stop 命令 | ✅ outbox `share_close(reason="remote stop")`，TUI toast `Sharing stopped (remote stop)` |
| 9 | TUI 退出 | ✅ expect 驱动退出，进程正常结束 |

## 验收标准核对

- 不新建 Session ✅（全程单 session）
- 不退出当前 TUI ✅
- 不启动另一套 OpenCode 实例 ✅（插件运行于 TUI 进程内）
- 成功接续同一 Session ✅（远程 prompt 注入 → 本地 TUI 实时可见 → 完成事件回推）

## 关键技术事实（本轮新验证）

1. **插件加载**：`<project>/.opencode/tui.json` 的 `plugin: ["/abs/path/dist/index.js"]` 生效；插件为纯 ESM JS、零 npm 运行时依赖（`@opencode-ai/plugin` 仅类型导入，构建后擦除）。
2. **slash 命令**：`api.keymap.registerLayer({ commands: [{ name, title, slashName: "feishu", run }] })` → 输入 `/feishu` 弹出自动补全，回车执行。
3. **菜单**：`api.ui.dialog.replace(() => api.ui.DialogSelect({...}))` 可用；`onSelect(option)` 收到 `{title, value}`。
4. **当前 session**：`api.route.current` → `{name:"session", params:{sessionID}}`。
5. **Prompt 注入**：`api.client.session.prompt({sessionID, parts:[{type:"text",text}]})`（parts 版 API）与 `api.client.v2.session.prompt({sessionID, prompt:{text}, delivery})`（durable 版，支持 steer/queue）均存在；PoC 对 idle 会话用 parts 版成功。
6. **事件流**：`api.event.on("session.status"/"session.error"/"permission.asked"/"question.asked", …)` 全部按预期触发；`session.status` 的 `busy`/`idle` 可准确界定任务起止。
7. **Toast**：`api.ui.toast({variant, title, message})` 正常显示。
8. **expect 驱动注意**：expect 的 `sleep` 不读 pty，需用 drain 循环（`expect -re ".+"`）持续读取，否则 log_file 捕获不到后续渲染。

## 遗留事项（进入 Phase 3）

- 真实飞书 WSClient 集成（`@larksuiteoapi/node-sdk`），Mock 保留为测试传输层
- `delivery: "steer" | "queue"` 在 busy 会话下的实测（PoC 中会话均为 idle）
- 权限/问答审批的实测（需要触发真实 permission 请求）
- 事件节流与卡片更新策略

## 交付版 E2E 回归（2026-10-09 晚，Phase 3 重构后）

使用 `scripts/e2e-driver.exp`（隔离沙箱 + 自动生成 tui.json + 最新 dist）复跑：

- 会话 `ses_xxx…（已打码）`：share_open(快照) → task_started → task_completed(summary="PONG") → status(响应入站查询) → share_close(remote stop) ✅
- 审计日志 `audit.jsonl` 正常记录 status/stop 操作及来源 ✅
- 全程单 session、单 TUI 进程、无重启 ✅

**Phase 3 重构后的插件行为与 PoC 一致，交付状态可复现。**
