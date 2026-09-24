/**
 * `manual` —— 按需拉取的**英文操作手册**（模型面向，不是给人看的用户文档）。
 *
 * 为什么需要它：cron / loop / job / env 这四块的规则又长又互相牵连（谁能写哪里、密钥怎么声明、
 * 怎么从脚本里唤醒 LLM），把它们全塞进系统提示词，等于每一轮都为一个偶尔才用的功能付 token。
 * 所以改成"要用时喊一声"：模型自己判断需要，调一次工具，拿到当前版本的手册。
 *
 * 与普通工具的关键差别 —— `ephemeralResult: true`（见 `src/tools/registry.ts`）：
 * - **不落盘**：结果不进 JSONL、不进原文账本（journal）、不进 transcript；
 * - **压缩即弃**：`Session.compress()` 在摘要前把它丢掉，所以它既不会被蒸馏进长期记忆，
 *   也不会逐字留在保留尾部；
 * - 因此模型必须在**自己的回复里**留下结论 —— 手册内容下一轮压缩后就不在了。
 *
 * 缓存一致性：结果会作为"稳定前缀"的一部分活到下一次压缩（期间可命中服务端 KV cache）；
 * 唯一的消失点是压缩，而那时整段历史本来就要被重写，故不额外破坏前缀缓存。
 *
 * 内容位置：`docs/manual/<topic>.md`（进仓库，可被 review / 随版本走）。手册是**唯一真相**，
 * 这里只做读取与索引，不在代码里第二份维护同样的规则（见 AGENTS.md §0 R1/R4）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerTool } from "./registry.js";
import { createLogger } from "../utils/logger.js";

/** 手册内容版本：改 `docs/manual/*.md` 时一起 +1，便于判断模型读的是哪一版。 */
export const MANUAL_VERSION = 1;

/** 单次返回的字符上限（手册本就是给人读的短文，这里只是防跑飞）。 */
const MAX_MANUAL_CHARS = 32_000;

/** 手册目录：仓库根的 `docs/manual`（本文件在 `src/tools/`，故上溯两级）。 */
const MANUAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/manual");

/** 可拉取的主题 → 一句话说明（也用于 `topic` 省略时的索引） */
const TOPICS: ReadonlyArray<{ id: string; summary: string }> = [
  { id: "cron", summary: "Scheduled tasks: modes, schedule fields, notify policy, sandbox/secrets, verification" },
  { id: "jobs", summary: "Background process jobs: lifecycle, detach, env, reading output, waking the LLM" },
  { id: "loop", summary: "Loop triggers (watch mode): tick semantics, loop_control, hard limits" },
  { id: "env", summary: "Environment layering, secrets, sandbox writable paths, the `wake` command" },
];

const log = createLogger("tools/manual");

function topicId(t: string): string | undefined {
  const id = t.trim().toLowerCase();
  return TOPICS.some((x) => x.id === id) ? id : undefined;
}

function indexText(): string {
  return [
    `# tinyclaw manual (v${MANUAL_VERSION}) — topics`,
    "",
    ...TOPICS.map((t) => `- \`${t.id}\` — ${t.summary}`),
    "",
    'Call `manual` again with one of these ids, e.g. `{ "topic": "cron" }`.',
  ].join("\n");
}

/** 读一篇手册正文；读不到返回 null（由调用方给可操作的报错）。 */
function readTopic(id: string): string | null {
  const file = path.join(MANUAL_DIR, `${id}.md`);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    log.warn(`手册读取失败: ${file}`, err);
    return null;
  }
}

registerTool({
  requiresMFA: false,
  // 用完即弃：不落盘、不进 transcript、压缩时丢弃（见文件头注释）
  ephemeralResult: true,
  spec: {
    type: "function",
    function: {
      name: "manual",
      description:
        "Read tinyclaw's operating manual (English, authoritative) for its unattended machinery. Call this " +
        "BEFORE you create or change a cron job, a loop trigger or a background job, and whenever a task " +
        "depends on environment variables, secrets, sandbox write paths or waking the LLM: those rules have " +
        "sharp edges that the individual tool descriptions only summarise, and guessing them produces " +
        "silently broken automation. Topic: \"cron\" | \"jobs\" | \"loop\" | \"env\" (omit to list topics). " +
        "The reply is loaded on demand and dropped at the next compaction, so put anything you still need " +
        "into your own answer or memory.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: TOPICS.map((t) => t.id),
            description: 'Which manual to read; omit to get the topic index',
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>): Promise<string> => {
    const raw = typeof args["topic"] === "string" ? args["topic"] : "";
    if (raw.trim() === "") return indexText();
    const id = topicId(raw);
    if (!id) {
      return `没有这个主题：「${raw.trim()}」。\n\n${indexText()}`;
    }
    const body = readTopic(id);
    if (body === null) {
      return (
        `手册文件缺失：${path.join(MANUAL_DIR, `${id}.md`)}\n` +
        "（`docs/manual/` 应随仓库一起存在；若确实丢了，请让用户检查安装是否完整。）"
      );
    }
    const clipped =
      body.length > MAX_MANUAL_CHARS
        ? body.slice(0, MAX_MANUAL_CHARS) + `\n\n…[手册超过 ${MAX_MANUAL_CHARS} 字符，已截断]`
        : body;
    return [
      `# manual: ${id} (v${MANUAL_VERSION})`,
      "",
      clipped.trimEnd(),
      "",
      "---",
      "This manual is ephemeral: it is dropped at the next compaction. Restate in your reply whatever you " +
        "must keep, and do not claim to have read it in a later turn without calling `manual` again.",
    ].join("\n");
  },
});
