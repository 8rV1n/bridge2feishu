# opencode-feishu-share

OpenCode 原生 TUI 插件：把**当前正在运行的 OpenCode Session** 一键分享到飞书，实现双向交互——
飞书接收任务状态/结果/待审批通知，并可以直接在飞书里发 Prompt、批准权限、回答问题、停止任务。

- 不修改 OpenCode 内核，不需要额外进程，不需要公网端口
- 飞书侧使用官方 SDK + WebSocket 长连接
- 默认不分享任何 Session；只有显式 `/feishu → Share` 之后才允许远程访问
- 适配 OpenCode **1.18.35** 的 TUI Plugin API（已对源码/二进制逐项核实，见 `docs/01-feasibility.md`）

## 功能总览

| 方向 | 能力 |
|---|---|
| TUI → 飞书 | 分享开启/关闭、会话快照、**流式任务卡**（开始→实时刷新→完成/失败定格）、限流重试提示、权限待审批（**按钮直批**）、Agent 提问（**按钮/表单直答**，支持多问题/多选/自定义答案输入框）、TUI 本地输入镜像、`/status` 查询回复 |
| 飞书 → TUI | 直接发文本 = 发 prompt（busy 时插件排队）、`/run` `/steer`、`/status`、`/recent`、`/stop`、`/approve` `/deny`（权限审批）、`/answer`（回答提问）、`/model` `/agent`（查看/切换模型与 Agent）、`/disconnect`；卡片按钮/表单点击等效指令 |
| 生命周期 | 会话级分享状态机；stop 不中止本地任务；TUI 退出自动清理；重连去重防重放 |

## 快速开始

1. 安装（详见 `docs/04-install.md`）：

   ```bash
   cd ~/OpenCodeHome/bridge2feishu
   npm install && npm run build
   ```

   在项目（或全局）TUI 配置里登记插件（`<repo-root>` 为本仓库根目录，下同），例如 `<project>/.opencode/tui.json`：

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["<repo-root>/dist/index.js"]
   }
   ```

   重启一次 TUI。

2. 未配置飞书凭证时自动使用 **Mock 传输层**（本地 JSONL 收件箱/发件箱），可直接体验全流程。

3. 配置真实飞书（详见 `docs/05-feishu-app-setup.md`）：

   ```bash
   export FEISHU_SHARE_TRANSPORT=lark
   export FEISHU_APP_ID=cli_xxx
   export FEISHU_APP_SECRET=xxx          # 只放环境变量，不要写进代码/配置文件
   export FEISHU_DEFAULT_CHAT_ID=oc_xxx  # 接收通知的群 chat_id 或 open_id
   export FEISHU_ALLOWED_OPEN_IDS=ou_xxx # 用户白名单（默认拒绝一切未授权用户）
   export FEISHU_ALLOWED_CHAT_IDS=oc_xxx
   ```

4. 在 TUI 里打开一个 session，输入 `/feishu`，选择 **Share current session**。

## 飞书侧体验

- 所有通知均为**交互式卡片**（飞书 JSON 2.0）：原生 markdown、表格、按钮与表单
- 任务执行中一张卡片流式刷新（工具时间线、思考中、正文 `▌`），完成后原地定格绿色；失败变红
- 权限审批/Agent 提问卡片上直接点按钮即可批复/作答；多问题与多选走表单；「✍️ 其他答案」原地变输入框
- 回答后 agent 继续产出时自动开**新卡片**展示后续回复（旧卡定格，保证时间线可读）

## 安全模型（单用户）

- 默认拒绝：不在白名单的发送者/会话一律拒绝并留痕
- 权限审批绑定 requestID：只能批复「当前 pending」的请求，过期/已处理请求不可复用
- 防重放：飞书 event_id/message_id LRU 去重，重试不会重复执行 prompt；卡片按钮回调同样去重
- 卡片按钮数据受控：点击回调 value 由渲染器写入、路由层白名单解析（`cardActionToCommand`），伪造 value 不产生任意指令
- 审计：所有远程操作记录在 `<stateDir>/audit.jsonl`（动作+来源，不含内容与密钥）
- 密钥只经环境变量注入；插件日志、通知、测试样例均不包含 App Secret

## 目录结构

```
src/
  index.ts          插件入口（tui 导出）：命令注册、事件订阅、生命周期、流式任务卡状态机、入站命令处理
  config.ts         环境变量配置加载
  share-state.ts    会话级分享状态机（unshared/shared/routeCommand）
  security.ts       白名单 + 审计日志
  router.ts         飞书文本/卡片按钮 → 指令解析（纯文本即 prompt）
  renderer.ts       通知渲染为飞书 JSON 2.0 交互卡片（markdown/表格/按钮/表单、超长分段）
  session.ts        session 消息摘要工具
  types.ts          共享类型
  transport/
    index.ts        传输层工厂（mock | lark）
    mock.ts         JSONL mock 传输层（自动化测试用，含卡片点击模拟）
    lark.ts         飞书官方 SDK LarkChannel WS 长连接 + ReplayGuard + 卡片回调同步应答
tests/              node:test 自动化测试（单元 + 集成）
docs/               可行性、PoC 记录、架构、安装、飞书配置、使用说明、兼容性
scripts/            E2E expect 驱动脚本
```

## 测试

```bash
npm test        # 66 个自动化测试（单元 + fake-api 集成）
npm run typecheck
```

真实飞书联调步骤见 `docs/05-feishu-app-setup.md`；无凭证环境下的全部行为由 Mock 覆盖。
