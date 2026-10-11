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
| Plugin 入口 `index.ts` | 注册 `/feishu` 命令与菜单、订阅 TUI 事件、编排分享生命周期、组装其余模块 | `export const tui: TuiPlugin` |
| `share-state.ts` | 会话级分享状态机：默认 unshared；share 绑定 (sessionID, chatID)；stop 解绑；`routeCommand` 保证远程命令只作用于被分享 session | `share/stop/isShared/current` |
| `config.ts` | 环境变量加载（stateDir、白名单、传输层、凭证） | `loadConfig(env)` |
| `security.ts` | 发送者/会话白名单（默认拒绝）+ 审计日志 | `checkInbound/audit` |
| `router.ts` | 飞书文本指令 → `InboundCommand`（`#latest`/`#n` 选择器占位） | `parseFeishuCommand` |
| `renderer.ts` | `OutboundEvent` → 飞书文本（截断、不带敏感内容、不调用 LLM） | `renderOutbound` |
| `session.ts` | session 消息摘要（lastAssistantText / summarize） | 纯函数 |
| `transport/mock.ts` | JSONL 收发，自动化测试用；offset 起点天然防旧积压 | `FeishuTransport` |
| `transport/lark.ts` | 飞书官方 SDK：EventDispatcher + WSClient；ReplayGuard LRU 防重放 | `FeishuTransport` |

`FeishuTransport` 统一接口：
```ts
start(): Promise<void>          // 建立连接（mock: 标记 offset；lark: WS 长连接）
stop(): Promise<void>
send(event: OutboundEvent): Promise<void>         // TUI → 飞书
onInbound(handler): void                           // 飞书 → TUI
```

## 3. 关键数据流

### 3.1 开启分享（TUI → 飞书）
1. `/feishu` → DialogSelect 菜单 → `share`
2. 校验 `api.route.current` 处于 session 路由，取 sessionID
3. `ShareStateManager.share(sessionID, chatID)`（幂等；已有其他绑定则拒绝）
4. `transport.start()` + `send(share_open, session快照)` —— 先同步当前状态再接续事件

### 3.2 任务事件（TUI → 飞书）
- `session.status: busy` → 若去重集合未记录 → `task_started`
- `session.status: idle` → 拉取最近消息 → `task_completed(summary)`
- `session.error` → `task_failed(error.message)`
- `permission.asked` → 记入 pending（带序号）→ `permission_requested`
- `question.asked` → `question_asked`（含选项）
- 只转发**被分享 session** 的事件；`share.stop()` 后静默

### 3.3 远程命令（飞书 → TUI）
1. WS 收到 `im.message.receive_v1` → ReplayGuard（event_id/message_id 去重）
2. `parseFeishuCommand`（mention 剥离、未知指令忽略）
3. `Security.checkInbound`（白名单，默认拒绝 + 审计）
4. `ShareStateManager.routeCommand`（必须是被分享的 sessionID）
5. 分发：
   - `prompt` → `client.v2.session.prompt({prompt:{text}, delivery})`（durable 队列，busy 时按语义 steer/queue，绝不 SessionBusyError）
   - `permission_reply` → 解析 `#latest/#n` → 必须在 pending 列表 → `client.permission.reply({requestID})`
   - `question_reply` → 同上 → `client.question.reply({requestID, answers})`
   - `abort` → `client.session.abort`；`status/recent` → 查询回发；`stop` → 解绑（不 abort）

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
| 飞书重试导致重复执行 | ReplayGuard LRU（event_id/message_id）+ mock offset 起点 |
| 密钥泄露 | 凭证仅经环境变量；渲染器/审计/日志不含密钥；`__help__` 通知无敏感内容 |
| 无鉴权 OpenCode HTTP API 暴露 | 插件不创建任何监听端口；全部为出站连接 |
| 会话串扰 | routeCommand 严格校验 sessionID；切换 session 不自动分享 |
| 敏感内容外泄 | 通知默认截断摘要，不发送文件 diff/环境变量；权限标题仅含 permission 名 |

## 6. 设计取舍

- **文本指令而非卡片按钮**（第一版）：减少卡片回调协议依赖；`/approve n` 体验可接受。卡片交互按钮列为后续增强。
- **不持久化分享状态**：重启即 unshared 比恢复共享更安全，避免「以为没共享其实共享了」。
- **durable v2 prompt API**：`client.session.prompt`（parts 版）在 busy 时会返回 SessionBusyError；
  v2 durable 版自带 steer/queue 投递语义，是远程续聊的正确入口。PoC 用 parts 版验证了链路，生产路径用 v2 版。
- **单文件传输接口**：mock/lark 实现同一 `FeishuTransport`，测试与真实平台解耦。
