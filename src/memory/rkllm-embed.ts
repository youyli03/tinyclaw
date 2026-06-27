/**
 * RKLLM NPU Embedding — HTTP 客户端 LlamaCpp 替代实现
 *
 * 通过本地 HTTP 服务(~/rkllm-embed-server/server.py)调 RK3588 NPU 做 embedding,
 * 完全解放 CPU 的 node-llama-cpp 线程。
 *
 * 用法:在 getQMDStore 里调用 setDefaultLlamaCpp(makeRkllmEmbedLlm(port))
 */

const MODEL_NAME = "rkllm/Qwen3-Embedding-0.6B_w8a8";
const FETCH_TIMEOUT_MS = 30_000; // 30s 单次 HTTP 超时(仅网络层面)
const MAX_RETRIES = 3;           // 最多重试 3 次
const RETRY_BACKOFF_MS = [2000, 4000, 8000]; // 指数退避

interface RkllmHttpEmbedResult {
  embedding: number[];
  dim: number;
}

/**
 * FIFO 串行队列：所有 NPU embedding 请求排队,一个完成后再处理下一个。
 * 避免并发 HTTP 连接在 NPU 串行处理时堆积超时。
 * 队列纯内存,重启后丢失;但 QMD Store(SQLite)里待嵌入文本状态未更新,
 * 下次 updateStore 会自动重新提交,最终一致。
 */
class SerialQueue {
  private _queue: Array<() => Promise<unknown>> = [];
  private _running = false;

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._queue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      this._drain();
    });
  }

  private _drain() {
    if (this._running) return;
    const task = this._queue.shift();
    if (!task) return;
    this._running = true;
    task().finally(() => {
      this._running = false;
      this._drain();
    });
  }

  get length(): number { return this._queue.length; }
}

const _embedQueue = new SerialQueue();

/**
 * 内部 fetch：不设 AbortSignal 超时(队列串行,排到了自然会处理)。
 * 仅保留 30s fetchTimeout 应对网络层面异常。
 * 重试间隔静默,最终失败才打一次 warn。
 */
async function _doFetch(url: string, options: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (e: unknown) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        // 中间重试静默,不刷屏
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  console.warn(`[rkllm-embed] fetch failed after ${MAX_RETRIES + 1} attempts:`, (lastErr as Error)?.message ?? "unknown");
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
      return _embedQueue.enqueue(async () => {
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
      });
    },

    async embedBatch(texts: string[]): Promise<({ embedding: number[]; model: string } | null)[]> {
      return _embedQueue.enqueue(async () => {
        const res = await _doFetch(`${base}/embed_batch`, {
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
      });
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
