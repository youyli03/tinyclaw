import type { InboundMessage } from "../connectors/base.js";
import { requestQQBotUserInput, sendQQBotMessage } from "../ipc/client.js";
import type { CronRuntimeBridge } from "./runner.js";

export class ChatRuntimeBridge implements CronRuntimeBridge {
  async send(
    peerId: string,
    msgType: InboundMessage["type"],
    message: string,
    replyToId?: string
  ): Promise<void> {
    await sendQQBotMessage({ peerId, msgType, text: message, ...(replyToId ? { replyToId } : {}) });
  }

  async requestUserInput(
    peerId: string,
    msgType: InboundMessage["type"],
    prompt: string,
    timeoutMs: number
  ): Promise<string> {
    return requestQQBotUserInput({ peerId, msgType, prompt, timeoutMs });
  }
}
