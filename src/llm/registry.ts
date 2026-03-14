import { LLMClient } from "./client.js";
import type { LLMBackend, AnyLLMBackend } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { buildCopilotClient } from "./copilot.js";

export type BackendName = "daily" | "code" | "summarizer";

/**
 * LLM 后端注册表。
 *
 * - OpenAI 后端：懒加载，首次 get() 时初始化。
 * - Copilot 后端：需在启动时调用 `await llmRegistry.init()` 预初始化
 *   （涉及异步 token 换取和模型能力发现）。
 * - 未配置 code / summarizer 时自动回退到 daily。
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
    const cfg = loadConfig().llm.backends;
    const entries: [BackendName, AnyLLMBackend | undefined][] = [
      ["daily", cfg.daily],
      ["code", cfg.code],
      ["summarizer", cfg.summarizer],
    ];

    for (const [name, backendCfg] of entries) {
      if (!backendCfg) continue;
      if (backendCfg.provider !== "copilot") continue;

      const { client, contextWindow } = await buildCopilotClient(backendCfg);
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

    const cfg = loadConfig().llm.backends;
    // 获取该 name 对应的原始配置（未配置则 fallback 到 daily 的配置对象）
    const rawCfg: AnyLLMBackend | undefined =
      name === "daily"
        ? cfg.daily
        : (name === "code" ? cfg.code : cfg.summarizer);

    if (!rawCfg) {
      // 未配置，回退到 daily（可能已经缓存了 daily 的 client）
      return this.get("daily");
    }

    if (rawCfg.provider === "copilot") {
      // Copilot 回退路径：如果 daily 已初始化且当前 name 未配置，
      // 直接返回 daily client（上层 !rawCfg 分支已处理；此处 rawCfg 存在但未初始化）
      const dailyClient = this.clients.get("daily");
      if (name !== "daily" && dailyClient) return dailyClient;
      throw new Error(
        `Copilot 后端 '${name}' 尚未初始化，请在启动时调用 await llmRegistry.init()`
      );
    }

    // OpenAI 后端：懒加载
    const client = new LLMClient(rawCfg as LLMBackend);
    this.clients.set(name, client);
    return client;
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

  /**
   * 运行时替换某个 OpenAI 后端（热更新 config 后调用）。
   */
  replace(name: BackendName, backend: LLMBackend): void {
    this.clients.set(name, new LLMClient(backend));
    this.contextWindows.delete(name);
  }

  /** 清除所有缓存的 client（测试用） */
  _reset(): void {
    this.clients.clear();
    this.contextWindows.clear();
  }
}

export const llmRegistry = new LLMRegistry();
