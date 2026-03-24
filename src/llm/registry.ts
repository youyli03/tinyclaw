import { LLMClient } from "./client.js";
import type { BackendRole } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { buildCopilotClient } from "./copilot.js";

export type BackendName = "daily" | "summarizer" | "code";

/**
 * 解析模型 symbol，格式为 "provider/model-id"。
 * 例如："copilot/gpt-4o" → { provider: "copilot", modelId: "gpt-4o" }
 *      "openai/gpt-4o-mini" → { provider: "openai", modelId: "gpt-4o-mini" }
 */
export function parseModelSymbol(symbol: string): { provider: string; modelId: string } {
  const slash = symbol.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `模型 symbol 格式无效 "${symbol}"，应为 "provider/model-id"（如 "copilot/gpt-4o"）`
    );
  }
  return { provider: symbol.slice(0, slash), modelId: symbol.slice(slash + 1) };
}

/**
 * LLM 后端注册表。
 *
 * - OpenAI 后端：懒加载，首次 get() 时初始化。
 * - Copilot 后端：需在启动时调用 `await llmRegistry.init()` 预初始化
 *   （涉及异步 token 换取和模型能力发现）。
 * - 未配置 summarizer 时自动回退到 daily。
 */
class LLMRegistry {
  private clients = new Map<BackendName, LLMClient>();
  /** 从 Copilot 模型元数据获取的上下文窗口大小（tokens） */
  private contextWindows = new Map<BackendName, number>();

  /**
   * 预初始化所有 Copilot 后端（异步，需在 main 启动时 await）。
   * OpenAI 后端仍为懒加载，此方法对其无副作用。
   */
  async init(): Promise<void> {
    const config = loadConfig();
    const backends = config.llm.backends;
    const entries: [BackendName, BackendRole | undefined][] = [
      ["daily", backends.daily],
      ["summarizer", backends.summarizer],
      ["code", backends.code],
    ];

    for (const [name, role] of entries) {
      if (!role) continue;
      const { provider, modelId } = parseModelSymbol(role.model);
      if (provider !== "copilot") continue;

      const copilotCfg = config.providers.copilot;
      if (!copilotCfg) {
        throw new Error(
          `后端 '${name}' 使用 copilot 模型，但 [providers.copilot] 未配置`
        );
      }

      // code backend 默认超时 240s（探索大仓库时 LLM 单轮处理耗时更长）
      const defaultTimeoutMs = name === "code" ? 240_000 : copilotCfg.timeoutMs;
      const { client, contextWindow } = await buildCopilotClient({
        githubToken: copilotCfg.githubToken,
        model: modelId,
        timeoutMs: role.timeoutMs ?? defaultTimeoutMs,
        ...(role.supportsVision !== undefined ? { supportsVision: role.supportsVision } : {}),
      });
      this.clients.set(name, client);
      this.contextWindows.set(name, contextWindow);
      console.log(
        `[llmRegistry] Copilot 后端 '${name}' 初始化完成，` +
          `模型=${client.model}，上下文窗口=${contextWindow} tokens`
      );
    }
  }

  /**
   * 获取指定后端的 LLMClient。
   * - OpenAI 后端：首次调用时懒加载。
   * - Copilot 后端：必须先调用 init()，否则抛出错误。
   * - 未配置时回退到 daily。
   */
  get(name: BackendName = "daily"): LLMClient {
    const cached = this.clients.get(name);
    if (cached) return cached;

    const config = loadConfig();
    const backends = config.llm.backends;
    const role: BackendRole | undefined =
      name === "daily" ? backends.daily
      : name === "code" ? backends.code
      : backends.summarizer;

    if (!role) {
      return this.get("daily");
    }

    const { provider, modelId } = parseModelSymbol(role.model);

    if (provider === "copilot") {
      const dailyClient = this.clients.get("daily");
      if (name !== "daily" && dailyClient) return dailyClient;
      throw new Error(
        `Copilot 后端 '${name}' 尚未初始化，请在启动时调用 await llmRegistry.init()`
      );
    }

    if (provider === "openai") {
      const openaiCfg = config.providers.openai;
      if (!openaiCfg) {
        throw new Error(
          `后端 '${name}' 使用 openai 模型，但 [providers.openai] 未配置`
        );
      }
      const client = new LLMClient({
        baseUrl: openaiCfg.baseUrl,
        apiKey: openaiCfg.apiKey,
        model: modelId,
        maxTokens: role.maxTokens ?? openaiCfg.maxTokens,
        // code backend 默认超时 240s
        timeoutMs: role.timeoutMs ?? (name === "code" ? 240_000 : openaiCfg.timeoutMs),
        ...(role.supportsVision !== undefined ? { supportsVision: role.supportsVision } : {}),
      });
      this.clients.set(name, client);
      return client;
    }

    throw new Error(`未知 provider "${provider}"（来自模型 symbol "${role.model}"）`);
  }

  /**
   * 获取指定后端对应模型的上下文窗口大小（tokens）。
   * Copilot 后端由模型元数据决定；OpenAI 后端使用 memory.contextWindow 配置。
   */
  getContextWindow(name: BackendName = "daily"): number {
    return (
      this.contextWindows.get(name) ?? loadConfig().memory.contextWindow
    );
  }

  /** 清除所有缓存的 client（用于配置热重载） */
  _reset(): void {
    this.clients.clear();
    this.contextWindows.clear();
  }
}

export const llmRegistry = new LLMRegistry();

