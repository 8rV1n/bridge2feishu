import type { PluginConfig } from "../config.js"
import type { FeishuTransport } from "../types.js"
import { MockTransport } from "./mock.js"
import { LarkTransport } from "./lark.js"

export function createTransport(config: PluginConfig, log?: (level: "info" | "error", msg: string) => void): FeishuTransport {
  if (config.transport === "lark") {
    if (!config.feishuAppId || !config.feishuAppSecret || !config.defaultChatID) {
      throw new Error("lark transport requires FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_DEFAULT_CHAT_ID")
    }
    return new LarkTransport({
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      domain: config.feishuDomain,
      chatID: config.defaultChatID,
      receiveIDType: config.receiveIDType,
      logger: log,
    })
  }
  return new MockTransport({ stateDir: config.stateDir })
}
