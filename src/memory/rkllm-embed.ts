/**
 * RKLLM NPU Embedding — HTTP 客户端 LlamaCpp 替代实现
 *
 * 通过本地 HTTP 服务(~/rkllm-embed-server/server.py)调 RK3588 NPU 做 embedding,
 * 完全解放 CPU 的 node-llama-cpp 线程。
 *
 * 用法:在 getQMDStore 里调用 setDefaultLlamaCpp(makeRkllmEmbedLlm(port))
 */

const MODEL_NAME = "rkllm/Qwen3-Embedding-0.6B_w8a8";
const FETCH_TIMEOUT_MS = 120_000; // 120s 单次 HTTP 超时; batch embed(32条)在 NPU 上可能耗时较长
interface RkllmHttpEmbedResult {
  embedding: number[];
  dim: number;
}

async function _doFetch(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`rkllm-embed 请求超时 (${FETCH_TIMEOUT_MS / 1000}s): ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function _fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      return await _doFetch(url, options);
    } catch (e: any) {
      lastErr = e;
      if (i < retries) {
        const delay = Math.min(1000 * Math.pow(2, i), 5000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * 构造一个符合 qmd LLM interface 的对象(只实现 embed / embedBatch)。
 * generate / rerank 均不支持,调用时 throw。
 * expandQuery 返回原始 query 的向量搜索,qmd 会退化为基础语义搜索。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeRkllmEmbedLlm(port = 11434): any {
  const base = `http://127.0.0.1:${port}`;

  return {
    __rkllm: true as const,
    async embed(text: string): Promise<{ embedding: number[]; model: string } | null> {
      const res = await _doFetch(`${base}/embed`, {
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
      const res = await _fetchWithRetry(`${base}/embed_batch`, {
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
     * rkllm-embed 服务不提供 tokenizer 接口,此处用字符数做近似估算:
     * 中英混合约 3 chars/token,返回长度等于估算 token 数的 Uint32Array,
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
