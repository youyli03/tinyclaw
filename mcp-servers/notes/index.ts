/**
 * tinyclaw Notes MCP Server
 *
 * 工具（agent 侧名前缀 mcp_notes_*）：
 *   list_categories      — 列出当前 agent 所有笔记分类
 *   create_category      — 新建笔记分类（指定类型、字段、描述）
 *   add_note             — 向某分类写入一条笔记
 *   query_notes          — 读取某分类的笔记（可限制条数）
 *   search_notes         — 在所有/指定分类中关键词搜索
 *   delete_note          — 按 note_id 删除某条笔记
 *   get_due_reminders    — 获取需要提醒的条目（每条24小时内不重复），对话开始时调用
 *
 * 启动方式：bun run /path/to/mcp-servers/notes/index.ts --agent-id <id>
 * 配置方式：~/.tinyclaw/mcp.toml [servers.notes]
 *
 * 数据目录：~/.tinyclaw/agents/<agent-id>/notes/
 *   index.json          分类元数据（名称、类型、字段定义、描述）
 *   <category>.md       各分类笔记数据（Markdown 格式）
 *   remind_state.json   每条提醒的最后提醒时间（用于去重，24h 内不重复提示）
 *
 * 三种格式类型：
 *   structured    严格字段格式，字段由创建分类时指定（交易记录等）
 *   timestamped   自动加时间戳，内容自由（提醒、点子等）
 *   freeform      完全自由格式，直接追加内容（知识点、命令速查等）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Agent ID & 数据目录 ────────────────────────────────────────────────────────

function parseAgentId(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--agent-id");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1]!;
  }
  return process.env["NOTES_AGENT_ID"] ?? "default";
}

const AGENT_ID = parseAgentId();
const NOTES_DIR = path.join(os.homedir(), ".tinyclaw", "agents", AGENT_ID, "notes");
const INDEX_FILE = path.join(NOTES_DIR, "index.json");
const REMIND_STATE_FILE = path.join(NOTES_DIR, "remind_state.json");

fs.mkdirSync(NOTES_DIR, { recursive: true });

// ── 类型定义 ───────────────────────────────────────────────────────────────────

type NoteType = "structured" | "timestamped" | "freeform";

interface FieldDef {
  name: string;
  description?: string;
  required?: boolean;
}

interface CategoryMeta {
  name: string;
  type: NoteType;
  description: string;
  fields?: FieldDef[];
  file: string;
  created_at: string;
}

interface NotesIndex {
  agent_id: string;
  categories: CategoryMeta[];
}

// ── 索引读写 ───────────────────────────────────────────────────────────────────

function loadIndex(): NotesIndex {
  if (fs.existsSync(INDEX_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")) as NotesIndex;
    } catch {
      // 损坏则重建
    }
  }
  return { agent_id: AGENT_ID, categories: [] };
}

function saveIndex(index: NotesIndex): void {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

function getCategoryMeta(index: NotesIndex, name: string): CategoryMeta | undefined {
  return index.categories.find((c) => c.name === name);
}

// ── 初始内置分类 ───────────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: Omit<CategoryMeta, "created_at">[] = [
  {
    name: "trading_log",
    type: "structured",
    description: "炒股操作记录，含买卖方向、价格、数量，便于复盘分析",
    fields: [
      { name: "time",   description: "操作时间（如 2026-03-28 14:00）", required: true },
      { name: "code",   description: "股票代码（如 002361）", required: true },
      { name: "action", description: "操作方向：买 或 卖", required: true },
      { name: "price",  description: "成交价格（元）", required: true },
      { name: "qty",    description: "数量（股）", required: true },
      { name: "note",   description: "备注（可选）", required: false },
    ],
    file: "trading_log.md",
  },
  {
    name: "reminders",
    type: "timestamped",
    description: "提醒与待办事项，自动记录写入时间",
    file: "reminders.md",
  },
  {
    name: "ideas",
    type: "timestamped",
    description: "tinyclaw 功能点子与想法，自动记录写入时间",
    file: "ideas.md",
  },
];

function buildFileHeader(
  name: string,
  type: NoteType,
  description: string,
  fields?: FieldDef[]
): string {
  let header = `# ${name}\n\n> ${description}\n>\n> 格式类型：${type}\n`;
  if (type === "structured" && fields && fields.length > 0) {
    header += `> 字段：${fields.map((f) => f.name).join(" | ")}\n\n`;
    header += `| ${fields.map((f) => f.name).join(" | ")} | note_id |\n`;
    header += `| ${fields.map(() => "---").join(" | ")} | --- |\n`;
  } else {
    header += "\n";
  }
  return header;
}

function ensureDefaultCategories(): void {
  const index = loadIndex();
  let changed = false;
  for (const def of DEFAULT_CATEGORIES) {
    if (!getCategoryMeta(index, def.name)) {
      index.categories.push({ ...def, created_at: new Date().toISOString() });
      const filePath = path.join(NOTES_DIR, def.file);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buildFileHeader(def.name, def.type, def.description, def.fields), "utf-8");
      }
      changed = true;
    }
  }
  if (changed) saveIndex(index);
}

// ── 提醒状态管理（remind_state.json） ─────────────────────────────────────────

/** remind_state.json 结构：{ [note_id]: ISO时间字符串（上次提醒时间） } */
type RemindState = Record<string, string>;

function loadRemindState(): RemindState {
  if (fs.existsSync(REMIND_STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(REMIND_STATE_FILE, "utf-8")) as RemindState;
    } catch { /* 损坏则重建 */ }
  }
  return {};
}

function saveRemindState(state: RemindState): void {
  fs.writeFileSync(REMIND_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * 从 reminders.md 中解析所有笔记条目。
 * timestamped 格式：`- **[时间]** 内容 <!-- note-id -->`
 * 返回 { noteId, text } 数组。
 */
function parseReminderEntries(content: string): Array<{ noteId: string; text: string }> {
  const results: Array<{ noteId: string; text: string }> = [];
  for (const line of content.split("\n")) {
    const m = line.match(/<!--\s*(note-\S+)\s*-->/);
    if (!m) continue;
    const noteId = m[1]!;
    // 提取可读文本（去除 Markdown 语法和注释）
    const text = line
      .replace(/<!--.*?-->/g, "")
      .replace(/\*\*\[.*?\]\*\*/g, "")
      .replace(/^[-\s]+/, "")
      .trim();
    if (text) results.push({ noteId, text });
  }
  return results;
}

// ── 笔记写入工具函数 ───────────────────────────────────────────────────────────

function genNoteId(): string {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:T.Z]/g, "");
  return `note-${iso}`;
}

function appendStructuredNote(
  filePath: string,
  fields: FieldDef[],
  content: Record<string, string>,
  noteId: string
): void {
  const values = fields.map((f) => {
    const v = (content[f.name] ?? "").replace(/\|/g, "\\|");
    return v;
  });
  const line = `| ${values.join(" | ")} | ${noteId} |\n`;
  fs.appendFileSync(filePath, line, "utf-8");
}

function appendTimestampedNote(filePath: string, content: string, noteId: string): void {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const line = `\n- **[${ts}]** ${content.trim()} <!-- ${noteId} -->\n`;
  fs.appendFileSync(filePath, line, "utf-8");
}

function appendFreeformNote(filePath: string, content: string, noteId: string): void {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const block = `\n## [${ts}] <!-- ${noteId} -->\n\n${content.trim()}\n`;
  fs.appendFileSync(filePath, block, "utf-8");
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

ensureDefaultCategories();

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "notes", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ── 工具列表 ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_categories",
      description: `列出当前 agent（${AGENT_ID}）的所有笔记分类，包含名称、类型、描述、字段定义。`,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_category",
      description:
        "新建一个笔记分类。\n" +
        "- structured：需提供 fields 字段列表，写入时强制按字段记录\n" +
        "- timestamped：自动加时间戳，内容自由（提醒、点子）\n" +
        "- freeform：完全自由格式，按块追加（领域知识点）",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "分类名（小写字母+下划线，如 docker_notes）",
          },
          type: {
            type: "string",
            enum: ["structured", "timestamped", "freeform"],
            description: "格式类型",
          },
          description: {
            type: "string",
            description: "分类用途描述",
          },
          fields: {
            type: "array",
            description: "字段定义列表（仅 structured 类型需要）",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                required: { type: "boolean" },
              },
              required: ["name"],
            },
          },
        },
        required: ["name", "type", "description"],
      },
    },
    {
      name: "add_note",
      description:
        "向指定分类写入一条笔记。\n" +
        "- structured 分类：content 必须是字段名->值的对象，如 {\"code\":\"002361\",\"action\":\"买\",...}\n" +
        "- timestamped 分类：content 为字符串，自动加时间戳\n" +
        "- freeform 分类：content 为字符串，自由内容",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "分类名（需已存在，可先调用 list_categories 查询）",
          },
          content: {
            description: "笔记内容：structured 时传对象，其他类型传字符串",
          },
        },
        required: ["category", "content"],
      },
    },
    {
      name: "query_notes",
      description: "读取指定分类的笔记内容（Markdown 格式），可通过 limit 限制返回行数。",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "分类名",
          },
          limit: {
            type: "number",
            description: "最多返回最近 N 行内容（不传则返回全部）",
          },
        },
        required: ["category"],
      },
    },
    {
      name: "search_notes",
      description:
        "在所有或指定分类中进行关键词全文搜索（文本匹配，多词空格分隔为 OR 逻辑）。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词，多词空格分隔",
          },
          category: {
            type: "string",
            description: "限定分类名（不传则搜索全部分类）",
          },
          max_results: {
            type: "number",
            description: "最多返回结果数，默认 20",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "delete_note",
      description:
        "按 note_id 删除指定分类中的某条笔记。note_id 可从 query_notes 返回的内容中找到。",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "分类名",
          },
          note_id: {
            type: "string",
            description: "笔记 ID（格式 note-YYYYMMDDHHMMSSMMM）",
          },
        },
        required: ["category", "note_id"],
      },
    },
    {
      name: "get_due_reminders",
      description:
        "【每次对话开始时调用】获取 reminders 分类中需要提醒的条目。\n" +
        "同一条提醒 24 小时内只返回一次（内部记录上次提醒时间），避免频繁打扰。\n" +
        "返回值：{ due: [{note_id, text}], total_reminders: N }\n" +
        "- due 为空数组时表示当前无需提醒（静默，不要向用户说没有提醒）\n" +
        "- due 不为空时，在回复用户第一条消息时顺带提示这些内容",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// ── 工具执行 ───────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {

      // ── list_categories ───────────────────────────────────────────────
      case "list_categories": {
        const index = loadIndex();
        if (index.categories.length === 0) {
          return ok({ agent_id: AGENT_ID, count: 0, categories: [], message: "暂无分类" });
        }
        const cats = index.categories.map((c) => ({
          name: c.name,
          type: c.type,
          description: c.description,
          fields: c.fields?.map((f) => `${f.name}${f.required === false ? "（可选）" : ""}`),
          file: path.join(NOTES_DIR, c.file),
          created_at: c.created_at,
        }));
        return ok({ agent_id: AGENT_ID, count: cats.length, categories: cats });
      }

      // ── create_category ───────────────────────────────────────────────
      case "create_category": {
        const catName = String(args["name"] ?? "").trim().toLowerCase();
        if (!catName || !/^[a-z0-9_]+$/.test(catName)) {
          return err("分类名只能包含小写字母、数字和下划线");
        }
        const catType = String(args["type"] ?? "") as NoteType;
        if (!["structured", "timestamped", "freeform"].includes(catType)) {
          return err("type 必须为 structured / timestamped / freeform");
        }
        const description = String(args["description"] ?? "").trim();
        if (!description) return err("缺少 description 参数");

        const index = loadIndex();
        if (getCategoryMeta(index, catName)) {
          return err(`分类 "${catName}" 已存在`);
        }

        // 解析 fields
        let fields: FieldDef[] | undefined;
        if (catType === "structured") {
          const rawFields = args["fields"];
          if (!Array.isArray(rawFields) || rawFields.length === 0) {
            return err("structured 类型必须提供 fields 字段列表");
          }
          fields = (rawFields as Array<Record<string, unknown>>).map((f) => ({
            name: String(f["name"] ?? ""),
            description: f["description"] ? String(f["description"]) : undefined,
            required: f["required"] !== false,
          }));
        }

        const fileName = `${catName}.md`;
        const filePath = path.join(NOTES_DIR, fileName);
        const meta: CategoryMeta = {
          name: catName,
          type: catType,
          description,
          fields,
          file: fileName,
          created_at: new Date().toISOString(),
        };

        index.categories.push(meta);
        saveIndex(index);
        fs.writeFileSync(filePath, buildFileHeader(catName, catType, description, fields), "utf-8");

        return ok({
          message: `已创建分类 "${catName}"（${catType}）`,
          category: meta,
          file: filePath,
        });
      }

      // ── add_note ──────────────────────────────────────────────────────
      case "add_note": {
        const catName = String(args["category"] ?? "").trim();
        if (!catName) return err("缺少 category 参数");

        const index = loadIndex();
        const meta = getCategoryMeta(index, catName);
        if (!meta) {
          return err(`分类 "${catName}" 不存在，请先调用 list_categories 查看或 create_category 新建`);
        }

        const filePath = path.join(NOTES_DIR, meta.file);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, buildFileHeader(meta.name, meta.type, meta.description, meta.fields), "utf-8");
        }

        const noteId = genNoteId();
        const content = args["content"];

        switch (meta.type) {
          case "structured": {
            if (!meta.fields || meta.fields.length === 0) {
              return err("该 structured 分类未定义字段");
            }
            if (typeof content !== "object" || content === null || Array.isArray(content)) {
              return err("structured 类型的 content 必须是字段名->值的对象，如 {\"code\":\"002361\",\"action\":\"买\"}");
            }
            const contentObj = content as Record<string, unknown>;
            // 检查必填字段
            const missing = meta.fields
              .filter((f) => f.required !== false && !contentObj[f.name])
              .map((f) => f.name);
            if (missing.length > 0) {
              return err(`缺少必填字段：${missing.join(", ")}`);
            }
            const strContent: Record<string, string> = {};
            for (const f of meta.fields) {
              strContent[f.name] = String(contentObj[f.name] ?? "");
            }
            appendStructuredNote(filePath, meta.fields, strContent, noteId);
            break;
          }
          case "timestamped": {
            const text = typeof content === "string" ? content : JSON.stringify(content);
            appendTimestampedNote(filePath, text, noteId);
            break;
          }
          case "freeform": {
            const text = typeof content === "string" ? content : JSON.stringify(content);
            appendFreeformNote(filePath, text, noteId);
            break;
          }
        }

        return ok({
          message: `已写入一条笔记到分类 "${catName}"`,
          note_id: noteId,
          category: catName,
          type: meta.type,
          file: filePath,
        });
      }

      // ── query_notes ───────────────────────────────────────────────────
      case "query_notes": {
        const catName = String(args["category"] ?? "").trim();
        if (!catName) return err("缺少 category 参数");

        const index = loadIndex();
        const meta = getCategoryMeta(index, catName);
        if (!meta) {
          return err(`分类 "${catName}" 不存在`);
        }

        const filePath = path.join(NOTES_DIR, meta.file);
        if (!fs.existsSync(filePath)) {
          return ok({ category: catName, found: false, content: "", message: "该分类暂无笔记" });
        }

        let content = fs.readFileSync(filePath, "utf-8");

        const limit = args["limit"] ? Number(args["limit"]) : undefined;
        if (limit && limit > 0) {
          // 只返回最后 limit 行（非空行）
          const lines = content.split("\n");
          const nonEmpty = lines.filter((l) => l.trim() !== "");
          const sliced = nonEmpty.slice(-limit);
          content = sliced.join("\n");
        }

        return ok({
          category: catName,
          type: meta.type,
          description: meta.description,
          fields: meta.fields,
          file: filePath,
          content,
        });
      }

      // ── search_notes ──────────────────────────────────────────────────
      case "search_notes": {
        const query = String(args["query"] ?? "").trim();
        if (!query) return err("缺少 query 参数");

        const catFilter = args["category"] ? String(args["category"]).trim() : undefined;
        const maxResults = Math.min(100, Math.max(1, Number(args["max_results"] ?? 20)));
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

        const index = loadIndex();
        const targets = catFilter
          ? index.categories.filter((c) => c.name === catFilter)
          : index.categories;

        if (catFilter && targets.length === 0) {
          return err(`分类 "${catFilter}" 不存在`);
        }

        const matches: Array<{ category: string; line: string }> = [];

        for (const cat of targets) {
          if (matches.length >= maxResults) break;
          const filePath = path.join(NOTES_DIR, cat.file);
          if (!fs.existsSync(filePath)) continue;

          const lines = fs.readFileSync(filePath, "utf-8").split("\n");
          for (const line of lines) {
            if (matches.length >= maxResults) break;
            const ll = line.toLowerCase();
            if (keywords.some((kw) => ll.includes(kw))) {
              matches.push({ category: cat.name, line: line.trim() });
            }
          }
        }

        if (matches.length === 0) {
          return ok({ query, found: 0, message: "未找到匹配内容" });
        }

        const resultText = matches
          .map((m) => `[${m.category}] ${m.line}`)
          .join("\n");

        return ok({ query, found: matches.length, results: resultText });
      }

      // ── delete_note ───────────────────────────────────────────────────
      case "delete_note": {
        const catName = String(args["category"] ?? "").trim();
        const noteId = String(args["note_id"] ?? "").trim();
        if (!catName) return err("缺少 category 参数");
        if (!noteId) return err("缺少 note_id 参数");

        const index = loadIndex();
        const meta = getCategoryMeta(index, catName);
        if (!meta) return err(`分类 "${catName}" 不存在`);

        const filePath = path.join(NOTES_DIR, meta.file);
        if (!fs.existsSync(filePath)) {
          return err(`分类 "${catName}" 的笔记文件不存在`);
        }

        const original = fs.readFileSync(filePath, "utf-8");
        // structured 行末有 note_id，timestamped/freeform 用 HTML 注释标记
        const filtered = original
          .split("\n")
          .filter((line) => !line.includes(noteId))
          .join("\n");

        if (filtered === original) {
          return err(`未找到 note_id="${noteId}" 的笔记（请检查分类和 ID 是否正确）`);
        }

        fs.writeFileSync(filePath, filtered, "utf-8");
        return ok({ message: `已删除笔记 ${noteId}（分类：${catName}）` });
      }

      // ── get_due_reminders ─────────────────────────────────────────────
      case "get_due_reminders": {
        const index = loadIndex();
        const meta = getCategoryMeta(index, "reminders");
        if (!meta) {
          return ok({ due: [], total_reminders: 0, message: "reminders 分类不存在" });
        }

        const filePath = path.join(NOTES_DIR, meta.file);
        if (!fs.existsSync(filePath)) {
          return ok({ due: [], total_reminders: 0 });
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const entries = parseReminderEntries(content);

        if (entries.length === 0) {
          return ok({ due: [], total_reminders: 0 });
        }

        const state = loadRemindState();
        const now = Date.now();
        const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 小时

        const due: Array<{ note_id: string; text: string }> = [];
        let stateChanged = false;

        for (const entry of entries) {
          const lastReminded = state[entry.noteId];
          const shouldRemind =
            !lastReminded || now - new Date(lastReminded).getTime() >= INTERVAL_MS;

          if (shouldRemind) {
            due.push({ note_id: entry.noteId, text: entry.text });
            state[entry.noteId] = new Date().toISOString();
            stateChanged = true;
          }
        }

        if (stateChanged) saveRemindState(state);

        return ok({
          due,
          total_reminders: entries.length,
          message:
            due.length > 0
              ? `有 ${due.length} 条待提醒（共 ${entries.length} 条提醒）`
              : `所有 ${entries.length} 条提醒均在 24 小时内已提醒过，本次静默`,
        });
      }

      default:
        return err(`未知工具：${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
});

// ── 响应辅助 ───────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ── 启动 ──────────────────────────────────────────────────────────────────────

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const transport = new StdioServerTransport();
await server.connect(transport);
