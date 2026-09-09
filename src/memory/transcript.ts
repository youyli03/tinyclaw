/**
 * 逐字层（transcript）
 *
 * 问题：记忆链的每一级都是**有损摘要**——
 *   对话原文 → diary（LLM 提炼成 1-3 句）→ cards / MEM.md（再蒸馏）
 * 而 QMD 只索引摘要文件，原文所在的 session JSONL 不在索引里，
 * 于是「细节」在写入时就被压掉了，检索再准也找不回来。
 *
 * 本模块补上缺失的一层：把每轮对话的**原文**追加到按天归档的 markdown，
 * 该目录位于 `~/.tinyclaw/agents/<id>/memory/` 下，而 QMD 的 `memory`
 * collection 模式是 `**\/*.md`，因此**自动纳入向量索引**，无需改 collection 配置。
 *
 * 特点：
 *  - 纯追加、不蒸馏、不调用 LLM → 零细节损失
 *  - 每条记录含用户原文、AI 结论、工具调用要点
 *  - 写入后按 agent 节流触发一次增量索引（默认 5 分钟一次），避免每轮都 embed
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentManager } from "../core/agent-manager.js";
import { updateMemoryIndex } from "./qmd.js";

/** 单条记录各部分的字符上限，避免工具长输出把索引撑爆 */
const MAX_USER_CHARS = 4_000;
const MAX_ASSISTANT_CHARS = 4_000;
const MAX_TOOLS_CHARS = 600;

/** 同一 agent 的增量索引节流窗口 */
const INDEX_THROTTLE_MS = 5 * 60 * 1000;
const _lastIndexAt = new Map<string, number>();

export interface TranscriptTurn {
  /** 用户本轮原文 */
  user: string;
  /** AI 本轮最终回复 */
  assistant: string;
  /** 本轮工具调用摘要（如 `exec_shell: crontab -l`），可选 */
  tools?: string[];
  /** 记录时间，默认当前时间 */
  at?: Date;
}

/** transcript 文件路径：`agents/<agentId>/memory/transcript/YYYY-MM-DD.md` */
export function transcriptPath(agentId: string, at: Date = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  return path.join(agentManager.memoryDir(agentId), "transcript", `${day}.md`);
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + `\n…[截断，原 ${t.length} 字符]`;
}

/** 把一轮对话渲染成 markdown 片段 */
export function renderTurn(turn: TranscriptTurn): string {
  const at = turn.at ?? new Date();
  const hhmm = at.toTimeString().slice(0, 5);
  const parts: string[] = [`## ${at.toISOString().slice(0, 10)} ${hhmm}`, ""];
  if (turn.user.trim()) parts.push("**用户**：", clip(turn.user, MAX_USER_CHARS), "");
  if (turn.assistant.trim()) parts.push("**AI**：", clip(turn.assistant, MAX_ASSISTANT_CHARS), "");
  if (turn.tools && turn.tools.length > 0) {
    parts.push("**工具**：" + clip(turn.tools.join(" · "), MAX_TOOLS_CHARS), "");
  }
  return parts.join("\n") + "\n";
}

/**
 * 只写文件（不触发索引），返回写入路径。
 * 与 `appendTranscript` 拆开是为了让写盘逻辑可单独测试。
 */
export function writeTranscriptTurn(agentId: string, turn: TranscriptTurn): string {
  const filePath = transcriptPath(agentId, turn.at);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const at = turn.at ?? new Date();
  const day = at.toISOString().slice(0, 10);
  const isNew = !fs.existsSync(filePath);
  const header = isNew ? `# 对话原文 ${day}\n\n` : "";
  fs.appendFileSync(filePath, header + renderTurn({ ...turn, at }), "utf-8");
  return filePath;
}

/**
 * 追加一轮对话到当日 transcript 文件，并按 agent 节流触发一次增量索引。
 * 文件不存在时自动创建并写入标题。
 */
export function appendTranscript(agentId: string, turn: TranscriptTurn): void {
  writeTranscriptTurn(agentId, turn);
  scheduleIndex(agentId);
}

/** 按 agent 节流地触发增量索引（fire-and-forget，失败只告警） */
function scheduleIndex(agentId: string): void {
  const now = Date.now();
  const last = _lastIndexAt.get(agentId) ?? 0;
  if (now - last < INDEX_THROTTLE_MS) return;
  _lastIndexAt.set(agentId, now);
  void updateMemoryIndex(agentId).catch((err) => {
    console.warn(
      "[transcript] 增量索引失败:",
      err instanceof Error ? err.message : err
    );
  });
}
