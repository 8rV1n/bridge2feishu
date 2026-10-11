# 飞书开放平台应用配置指南

本插件使用飞书官方 Node.js SDK（`@larksuiteoapi/node-sdk`）的 **WebSocket 长连接**模式：
无需公网 IP/端口/回调 URL，由插件主动与飞书建立长连接并接收事件。

## 一、创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 开发者后台 → **创建企业自建应用**
2. 记录 **App ID**（`cli_` 开头）与 **App Secret**（只在本地环境变量中使用，绝不提交到代码/仓库）

## 二、开通机器人能力

- 左侧「应用能力 → 添加应用能力」→ **机器人**

## 三、事件订阅（WS 长连接）

1. 左侧「事件与回调 → 订阅方式」选择：**使用长连接接收事件**（WebSocket）
2. 在「事件与回调 → 事件订阅」中添加事件：

| 事件 | 用途 |
|---|---|
| `im.message.receive_v1`（接收消息） | 接收你在飞书发出的指令（/run、/approve 等） |

> 只需要这一个事件。状态通知（任务开始/完成/失败/权限审批）是插件**主动发送**给飞书的，不需要事件订阅。

3. 版本选择 v1（默认）

## 四、权限清单（「权限管理」中搜索开通）

| 权限 | 权限标识 | 用途 |
|---|---|---|
| 获取与发送单聊、群组消息 | `im:message`（或最小集：`im:message:send_as_bot` + `im:message.p2p_msg:readonly` / `im:message.group_msg:readonly`） | 发送通知 + 读取你发的指令 |
| （仅发送通知的最小集） | `im:message:send_as_bot` | 以机器人身份发消息 |

说明：
- 若只在**群聊**接收通知并把指令发到群里：需要群消息读取权限，并把机器人加入该群
- 若在**单聊**（与机器人私聊）使用：需要单聊消息权限
- 事件回调要求开通的权限会由开放平台在订阅页面提示，按提示开通即可

## 五、发布应用

- 创建版本 → 申请线上发布 → 管理员审核通过
- 企业自建应用一般可自审自批

## 六、准备接收目标

通知发送目标 `FEISHU_DEFAULT_CHAT_ID`：

- **群聊**：把机器人加入群 → 群设置里查看群信息，或在群内 @机器人 后由平台事件里的 `chat_id` 获得（`oc_` 开头）
- **单聊**：`receive_id_type` 用 `open_id`，`FEISHU_DEFAULT_CHAT_ID` 填你的 `ou_` 开头 open_id
  （可在管理后台「成员管理」或通过调试工具获取）

## 七、本地环境变量

```bash
# ~/.zshrc 或启动 opencode 前 export
export FEISHU_SHARE_TRANSPORT=lark
export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx            # 不要写进任何文件/仓库
export FEISHU_DEFAULT_CHAT_ID=oc_xxxxxxxx    # 群 chat_id（或配 open_id + 下行配置）
export FEISHU_RECEIVE_ID_TYPE=chat_id        # 群用 chat_id，单聊用 open_id
export FEISHU_ALLOWED_OPEN_IDS=ou_your_id    # 用户白名单（逗号分隔多个），未配置=全部拒绝
export FEISHU_ALLOWED_CHAT_IDS=oc_group_id   # 会话白名单
# export FEISHU_DOMAIN=https://open.feishu.cn  # 国际版用 https://open.larksuite.com
```

> 安全提醒：
> - App Secret 只经环境变量注入；插件不会把凭证写入日志/通知/审计文件
> - 白名单未配置时插件拒绝一切远程操作（默认拒绝）
> - `FEISHU_ALLOWED_OPEN_IDS` 不要设为 `*`，除非你完全理解风险（仅建议在 Mock 测试时使用）

## 八、人工联调步骤（无需自动化）

1. 配置好环境变量后启动 `opencode`，进入 session，`/feishu` → Share
2. 飞书目标会话应收到「🟢 已开启分享」交互卡片（含会话快照）
3. 在 TUI 里给 agent 发一个任务 → 飞书收到「▶️ 任务开始执行」卡片并**流式刷新**
   （工具时间线/思考中/正文），完成后原地定格「✅ 任务完成」；期间 TUI 本地输入会以「👤 TUI 输入」卡片镜像到飞书
4. 触发一个需要权限的操作（例如让 agent 运行 bash 命令）→ 飞书收到「⚠️ 等待权限审批」卡片 →
   **直接点「批准一次」按钮**（或回复 `/approve`）→ TUI 内权限被批准，原卡片变为「✅ 已处理」
5. 触发 Agent 提问 → 收到「❓ Agent 需要你的回答」卡片 → 单问题直接点选项按钮；
   多问题/多选用卡片内表单选择后点「提交回答」；「✍️ 其他答案」会原地变输入框，填写后提交
6. 直接发一段文本（不带斜杠）= 给 session 发新 prompt；`/run` busy 时自动排队（卡片显示排队条数，idle 后自动执行）
7. 回复 `/model` `/agent` 查看并切换模型/Agent；`/status` `/recent` 验证查询；`/stop` 验证中止；`/disconnect` 验证断开
8. 联调中若收不到消息，检查：应用是否发布上线、机器人是否在群里、事件订阅是否选了长连接模式、
   `im.message.receive_v1` 是否已添加、权限是否已开通

## 九、调试开关（可选）

```bash
export FEISHU_SHARE_DEBUG=1
```

开启后写入两个诊断文件（位于 `<stateDir>/`，默认 `~/.local/share/opencode/feishu-share/`）：

| 文件 | 内容 |
|---|---|
| `plugin-debug.log` | 插件侧事件时序（session.status、message.part.updated、流式卡开/定/续、镜像去重） |
| `lark-sdk.log` | 飞书 SDK 的 WS 帧/dispatcher 日志（排查按钮回调是否送达、建连是否成功） |

排查完记得关闭（日志为明文追加，含消息内容摘要）。

## 十、常见审核/配置问题

| 现象 | 处理 |
|---|---|
| 收不到任何通知 | `FEISHU_DEFAULT_CHAT_ID` 是否正确；机器人是否被加入群；应用是否已发布 |
| 通知能收到但指令无响应 | `im.message.receive_v1` 未订阅/未发布；用户不在 `FEISHU_ALLOWED_OPEN_IDS` |
| 卡片能收到但点按钮无反应 | 用 `FEISHU_SHARE_DEBUG=1` 看 `lark-sdk.log` 是否有 card action 帧；确认应用已发布、
机器人能力开启；回调去重会跳过同一用户对同一 value 的重复点击（属预期） |
| 启动时报凭证错误 | App ID/Secret 错误；或用国内域名访问国际版租户（设置 `FEISHU_DOMAIN`） |
| WS 频繁断开重连 | 正常行为（SDK 内建重连）；重连后旧指令不会补跑（防重放设计） |
