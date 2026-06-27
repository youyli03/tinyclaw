/**
 * RKLLM NPU Embedding — HTTP 客户端 LlamaCpp 替代实现
 *
 * 通过本地 HTTP 服务（~/rkllm-embed-server/server.py）调 RK3588 NPU 做 embedding，
 * 完全解放 CPU 的 node-llama-cpp 线程。
 *
 * 用法：在 getQMDStore 里调用 setDefaultLlamaCpp(makeRkllmEmbedLlm(port))
 */

const MODEL_NAME = "rkllm/Qwen3-Embedding-0.6B_w8a8";
const FETCH_TIMEOUT_MS = 60_000; // 60s 单次超时
const MAX_RETRIES = 2;           // 最多重试 2 次

interface RkllmHttpEmbedResult {
  embedding: number[];
  dim: number;
}

/**
 * 带超时和重试的 fetch 包装。
 * NPU 可能被主 LLM 占用导致 embedding server 阻塞，短暂等待后重试通常能成功。
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (e: unknown) {
      if (attempt < retries) {
        const delay = 1000 * (attempt + 1); // 1s, 2s 退避
        console.warn(`[rkllm-embed] fetch attempt ${attempt + 1} failed, retrying in ${delay}ms:`, (e as Error).message);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
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
    __rkllm: true as const,
    async embed(text: string): Promise<{ embedding: number[]; model: string } | null> {
      const res = await fetchWithRetry(`${base}/embed`, {
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
      const res = await fetchWithRetry(`${base}/embed_batch`, {
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

    /**
     * tokenize: qmd 用于按 token 数切分文档。
     * rkllm-embed 服务不提供 tokenizer 接口，此处用字符数做近似估算：
     * 中英混合约 3 chars/token，返回长度等于估算 token 数的 Uint32Array，
     * 满足 qmd 只检查 .length 的需求。
     */
    async tokenize(text: string): Promise<Uint32Array> {
      // RKLLM Qwen3-Embedding ~1.8 chars/token (Chinese);
      // tokenize returns estimated token count so QMD chunks to ~900 tokens = ~1620 chars
      const approxTokens = Math.max(1, Math.ceil(text.length / 1.8));
      return new Uint32Array(approxTokens);
    },
  };
}
