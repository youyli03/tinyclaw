import { LLMClient } from "./client.js";
import type { LLMBackend } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";

export type BackendName = "daily" | "code" | "summarizer";

/**
 * LLM 后端注册表。
 * 懒加载：首次 get() 时从 config 初始化对应 client。
 * 未配置 code / summarizer 时自动回退到 daily。
 */
class LLMRegistry {
  private clients = new Map<BackendName, LLMClient>();

  private getBackendConfig(name: BackendName): LLMBackend {
    const cfg = loadConfig().llm.backends;
    if (name === "daily") return cfg.daily;
    // code / summarizer 未配置时回退到 daily
    return (name === "code" ? cfg.code : cfg.summarizer) ?? cfg.daily;
  }

  /**
   * 获取指定后端的 LLMClient，未配置时回退到 daily。
   */
  get(name: BackendName = "daily"): LLMClient {
    let client = this.clients.get(name);
    if (!client) {
      client = new LLMClient(this.getBackendConfig(name));
      this.clients.set(name, client);
    }
    return client;
  }

  /**
   * 运行时替换某个后端（例如热更新 config 后调用）。
   */
  replace(name: BackendName, backend: LLMBackend): void {
    this.clients.set(name, new LLMClient(backend));
  }

  /** 清除所有缓存的 client（测试用） */
  _reset(): void {
    this.clients.clear();
  }
}

export const llmRegistry = new LLMRegistry();
