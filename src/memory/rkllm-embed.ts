/**
 * RKLLM NPU Embedding — HTTP 客户端 LlamaCpp 替代实现
 *
 * 通过本地 HTTP 服务（~/rkllm-embed-server/server.py）调 RK3588 NPU 做 embedding，
 * 完全解放 CPU 的 node-llama-cpp 线程。
 *
 * 用法：在 getQMDStore 里调用 setDefaultLlamaCpp(makeRkllmEmbedLlm(port))
 */

const MODEL_NAME = "rkllm/Qwen3-Embedding-0.6B_w8a8";

interface RkllmHttpEmbedResult {
  embedding: number[];
  dim: number;
}

/**
 * 构造一个符合 qmd LLM interface 的对象（只实现 embed / embedBatch）。
 * generate / rerank 均不支持，调用时 throw。
 * expandQuery 返回原始 query 的向量搜索，qmd 会退化为基础语义搜索。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeRkllmEmbedLlm(port = 11434): any {
  const base = `http://127.0.0.1:${port}`;

  return {
    async embed(text: string): Promise<{ embedding: number[]; model: string } | null> {
      const res = await fetch(`${base}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "unknown");
        throw new Error(`rkllm-embed HTTP ${res.status}: ${err}`);
      }
      const data = (await res.json()) as RkllmHttpEmbedResult;
      return { embedding: data.embedding, model: MODEL_NAME };
    },

    async embedBatch(texts: string[]): Promise<({ embedding: number[]; model: string } | null)[]> {
      const res = await fetch(`${base}/embed_batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "unknown");
        throw new Error(`rkllm-embed HTTP ${res.status}: ${err}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings.map((emb) => ({ embedding: emb, model: MODEL_NAME }));
    },

    async modelExists(_model: string): Promise<{ exists: boolean }> {
      return { exists: true };
    },

    async generate(): Promise<null> {
      throw new Error("rkllm-embed: generate not supported");
    },

    async expandQuery(query: string): Promise<{ type: string; text: string }[]> {
      return [{ type: "vec", text: query }];
    },

    async rerank(): Promise<never> {
      throw new Error("rkllm-embed: rerank not supported");
    },

    async dispose(): Promise<void> {},
  };
}
