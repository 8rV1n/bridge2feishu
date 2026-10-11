# 安装与卸载

## 前置条件

- OpenCode 1.18.35（其他 1.18.x 版本接口一致，已核实类型定义；更早版本未验证）
- Node.js ≥ 22（仅构建/测试用；TUI 运行时使用 OpenCode 内嵌 Bun）

## 安装（本地源码方式，推荐）

```bash
cd ~/OpenCodeHome/bridge2feishu
npm install          # 安装构建与测试依赖（含飞书 SDK）
npm run build        # 产出 dist/index.js（零运行时 npm 依赖，飞书 SDK 按需动态加载）
npm test             # 66 个自动化测试应全部通过
```

### 登记 TUI 插件（二选一）

> `<repo-root>` 指本仓库根目录（即执行 `npm run build` 的目录）；插件 spec 需展开为绝对路径。

**A. 项目级**（只在该项目启用）— `<project>/.opencode/tui.json`：

```json
{
  "$schema": "https://opencode.ai/tui.json",
   "plugin": ["<repo-root>/dist/index.js"]
}
```

**B. 全局**（所有项目启用）— `~/.config/opencode/tui.json`（若已有该文件，只需把路径加进其中已有的 `"plugin"` 数组）：

```json
{
  "$schema": "https://opencode.ai/tui.json",
   "plugin": ["<repo-root>/dist/index.js"]
}
```

> 注意：此安装方式不修改 `opencode.json`（不影响你的模型/插件/其他全局配置）。
> 首次安装需要**重启一次 TUI**；之后 share/stop 都在运行中的 TUI 内完成。

### 环境变量

放在 shell 配置（如 `~/.zshrc`）或启动 TUI 前导出，见 `docs/05-feishu-app-setup.md`。
未配置时默认使用 Mock 传输层，可以先体验全流程。

Mock 状态目录默认 `~/.local/share/opencode/feishu-share/`（可用 `FEISHU_SHARE_STATE_DIR` 覆盖）。

## 验证安装

1. 启动 `opencode`，进入一个 session
2. 输入 `/f` —— 自动补全应出现 `/feishu`
3. 回车打开菜单 → **Share current session** → 顶部 toast「Sharing ses_… -> …」
4. Mock 模式下检查 `~/.local/share/opencode/feishu-share/outbox.jsonl` 应出现 `share_open`
   （卡片 JSON 2.0 结构）；任务执行期间应出现 `card_update`（流式刷新）与 `tui_input`（本地输入镜像）
5. 向 `inbox.jsonl` 追加一行测试指令：

   ```bash
   echo '{"senderID":"*","chatID":"mock","messageID":"m1","command":{"action":"status"}}' \
     >> ~/.local/share/opencode/feishu-share/inbox.jsonl
   ```

   outbox 应出现 `status` 回复。注意：mock 模式白名单需 `FEISHU_ALLOWED_OPEN_IDS=*`。

## 运行中动态加载（免重启，可选）

TUI 亦支持运行时加载：命令面板（ctrl+p）→ `plugins.install` → 输入 `/abs/path/dist/index.js`。
适合试验；日常建议上面的配置方式。

## 卸载

1. 从 `tui.json` 的 `plugin` 数组中移除对应路径（或删除该文件条目）
2. 重启 TUI
3. 清理数据目录（可选）：

   ```bash
   rm -rf ~/.local/share/opencode/feishu-share
   ```

4. 项目依赖（`node_modules`）可整体删除，不影响 OpenCode 本体

## 升级

```bash
cd ~/OpenCodeHome/bridge2feishu
git pull   # 或手动更新源码
npm install && npm run build && npm test
```

重启 TUI 即生效（TUI 启动时读取 dist 产物）。
