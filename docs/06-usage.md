# 使用说明与常见问题

## 日常使用流程

1. 像平常一样 `opencode` 启动 TUI，开始干活（插件已随 TUI 加载，但**默认不分享任何 session**）
2. 在执行任务期间想分享时：输入 `/feishu` 回车 → 菜单选择 **Share current session**
3. 飞书侧开始接收：开启通知 + 快照 → 任务开始/完成/失败 → 权限待审批 → Agent 提问
4. 需要时在飞书回复指令（见下表）；本地 TUI 完全不受影响，照常使用
5. 结束分享：`/feishu` → **Stop sharing**，或直接在飞书发 `/disconnect`
   —— 只解除远程访问，不会中止当前 Agent 任务

## 飞书指令表

| 指令 | 作用 |
|---|---|
| `/status` | 当前 session、运行状态、消息数、最近回复摘要 |
| `/recent` | 最近一条执行结果 |
| `/run <文本>` | 给当前 session 发新 prompt；agent 忙时自动**排队**（任务结束后执行） |
| `/steer <文本>` | 给当前 session **插话**；agent 忙时立即注入当前执行过程 |
| `/stop` | 中止当前执行（abort） |
| `/approve` / `/approve always` | 批准最新待审批权限（一次/永久） |
| `/approve 2` / `/deny 3` | 按通知序号批复指定权限 |
| `/answer <选项>` | 回答 Agent 的交互式问题（选项文本） |
| `/disconnect` | 断开分享（不中止本地任务） |
| `/help` | 指令帮助 |

TUI 内菜单项：

- **Share current session** — 绑定当前 session（幂等，重复选择不会重复建连）
- **Stop sharing** — 解除绑定
- **Show share status** — 显示绑定信息；mock 模式同时回发 status 到 outbox
- **PoC: send test prompt** — 向当前分享的 session 注入 `Reply with exactly: PONG`（链路诊断）

## 安全行为说明

- 白名单外的飞书用户/会话发来的任何指令都会被拒绝，并记录审计
- 权限审批只能针对**当前待处理**的请求（requestID 绑定），已处理/过期的请求无法复用
- 飞书重试或重放同一消息不会导致重复执行（LRU 去重）
- 所有远程操作（含被拒绝的）都记录在 `<stateDir>/audit.jsonl`
- TUI 退出自动断开；TUI 崩溃后飞书侧 SDK 探活超时后会识别离线
- 分享状态不持久化：TUI 重启后总是回到未分享状态

## 常见问题

**Q: 输入 `/feishu` 没有反应？**
插件未加载。检查 `tui.json` 的 plugin 路径是否为绝对路径、是否重启过 TUI；
查看 TUI 启动日志是否有 `[tui.plugin]` 报错。

**Q: 菜单里 Share 是灰的？**
当前不在 session 路由（例如还在首页）。先进入一个会话再执行 `/feishu`。

**Q: `/run` 的 prompt 没有出现在 TUI？**
- 确认该指令来自白名单用户
- durable prompt 在 agent 忙时会排队（任务结束后自动执行），这是预期行为
- 用 `/status` 查看 session 状态；检查 `<stateDir>/audit.jsonl` 是否有拒绝记录

**Q: 权限审批通知没有出现？**
只有**被分享的 session** 的 permission 请求会转发。另确认 agent 当前确实在等待审批
（TUI 内也应显示权限弹窗）。

**Q: 想把通知发到另一个人/群？**
一个插件实例绑定一个 `FEISHU_DEFAULT_CHAT_ID`。多目标需求可在飞书侧用群机器人转发，或等后续版本支持多目标。

**Q: Mock 模式和真实模式如何切换？**
`FEISHU_SHARE_TRANSPORT=lark`（真实飞书）vs 缺省（mock）。切换后重启 TUI。

**Q: 会消耗额外的 LLM 调用吗？**
状态通知全部是本地格式化渲染（任务完成时的摘要直接取自已有消息文本），**不发起任何额外 LLM 调用**。

**Q: 和 OpenCode 自带的 `/share`（网页分享）冲突吗？**
不冲突。本插件的分享是「飞书通道绑定」，与官方 share URL 无关；你的 opencode.json 中 `share: "disabled"` 也不受影响。

**Q: 支持多个 TUI 同时分享吗？**
每个 TUI 进程的插件实例独立绑定自己的 session 与飞书目标；互不干扰。
但同一个飞书群会收到多个 TUI 的通知（以会话标题区分）。
