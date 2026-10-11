import { PLUGIN_ID, type FeishuTransport } from "./types.js"

export type PluginConfig = {
  stateDir: string
  /** 逗号分隔的飞书用户白名单；"*" 表示 Mock 模式放行 */
  allowedSenderIDs: string[]
  /** 逗号分隔的飞书会话（chat）白名单；"*" 表示不限制 */
  allowedChatIDs: string[]
  /** 传输层：mock（默认，JSONL 文件）| lark（真实飞书 WS） */
  transport: "mock" | "lark"
  feishuAppId?: string
  feishuAppSecret?: string
  feishuDomain?: string
  defaultChatID: string
  receiveIDType: "chat_id" | "open_id"
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const stateDir =
    env.FEISHU_SHARE_STATE_DIR ??
    `${env.HOME ?? "/tmp"}/.local/share/opencode/feishu-share`

  const transport = env.FEISHU_SHARE_TRANSPORT === "lark" ? "lark" : "mock"
  const feishuAppId = env.FEISHU_APP_ID
  const feishuAppSecret = env.FEISHU_APP_SECRET

  return {
    stateDir,
    allowedSenderIDs: list(env.FEISHU_ALLOWED_OPEN_IDS, []),
    allowedChatIDs: list(env.FEISHU_ALLOWED_CHAT_IDS, []),
    transport,
    feishuAppId,
    feishuAppSecret,
    feishuDomain: env.FEISHU_DOMAIN,
    defaultChatID: env.FEISHU_DEFAULT_CHAT_ID ?? (transport === "lark" ? (feishuAppId ? "" : "mock") : "mock"),
    receiveIDType: env.FEISHU_RECEIVE_ID_TYPE === "open_id" ? "open_id" : "chat_id",
  }
}

export type { FeishuTransport, PLUGIN_ID }
