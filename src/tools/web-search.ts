import { registerTool } from "./registry.js";
import { loadSecretsConfig } from "../config/loader.js";

const MAX_RESULTS = 10;
const MAX_CONTENT_PER_RESULT = 1000;

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "使用 Tavily 搜索引擎实时检索互联网信息，返回摘要和相关链接。适合查询最新新闻、实时数据、不在本地知识库中的信息。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索查询词（支持中英文）",
          },
          topic: {
            type: "string",
            enum: ["general", "news", "finance"],
            description: "搜索主题：general（通用，默认）/ news（新闻）/ finance（金融）",
          },
          max_results: {
            type: "number",
            description: "最多返回结果数（默认 5，最大 10）",
          },
          include_answer: {
            type: "boolean",
            description: "是否包含 Tavily 自动生成的摘要答案（默认 true）",
          },
        },
        required: ["query"],
      },
    },
  },
  async execute(args): Promise<string> {
    const { query, topic, max_results, include_answer } = args as {
      query: string;
      topic?: "general" | "news" | "finance";
      max_results?: number;
      include_answer?: boolean;
    };

    const secrets = loadSecretsConfig();
    const tavilyKey = secrets["TAVILY_KEY"];
    if (!tavilyKey) {
      throw new Error("TAVILY_KEY 未配置，请在 ~/.tinyclaw/secrets.toml 中添加");
    }

    const maxResults = Math.min(max_results ?? 5, MAX_RESULTS);
    const includeAnswer = include_answer !== false;

    const body = JSON.stringify({
      query,
      topic: topic ?? "general",
      max_results: maxResults,
      include_answer: includeAnswer,
      include_raw_content: false,
      include_images: false,
    });

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tavilyKey.value}`,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Tavily API 错误 ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as {
      answer?: string;
      results?: Array<{
        title: string;
        url: string;
        content: string;
        score: number;
      }>;
    };

    const parts: string[] = [];

    if (data.answer) {
      parts.push("**摘要答案**\n" + data.answer);
    }

    if (data.results && data.results.length > 0) {
      parts.push(
        "**搜索结果**（共 " + data.results.length + " 条）\n" +
          data.results
            .map((r, i) => {
              const content = r.content?.slice(0, MAX_CONTENT_PER_RESULT) ?? "";
              return (i + 1) + ". **" + r.title + "**\n   URL: " + r.url + "\n   " + content;
            })
            .join("\n\n"),
      );
    }

    return parts.join("\n\n") || "未找到相关结果";
  },
});
