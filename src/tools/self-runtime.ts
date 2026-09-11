/**
 * self_runtime_* —— Agent 对**自身运行时目录**（`~/.tinyclaw`）的操作能力（"自指"）。
 *
 * 授权模型：`config.toml` 的 `[self_access].grantedAgents` 列出被授权的 agentId；
 * 未列出时三个工具一律返回"已拒绝"（不会偷偷降级）。
 *
 * 授权后该 agent 对 `~/.tinyclaw` 树拥有**完整访问权**，唯一的例外是**密钥**：
 * `config.toml` / `secrets.toml` / `mcp.toml` / `auth/**` / `*.key` / 名字含 token 的文件
 * 既不可读、也不可写、不可删（由 `tools/path-guard.ts` 的 `isRuntimeSecretPath` 统一裁决）。
 *
 * 三个工具都不需要 MFA —— 授权本身就是用户的决策；但删除必须显式给 `confirm: true`。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerTool, type ToolContext } from "./registry.js";
import { isInsideRuntime, isRuntimeSecretPath, isSelfAccessGranted, runtimeRoot } from "./path-guard.js";
import { fmtBytes, isProtectedFromDelete, measure, scanRuntime } from "../core/runtime-usage.js";
import { loadConfig } from "../config/loader.js";

/** 未授权时的统一拒绝文案（含解决办法，避免模型反复试） */
function deniedMessage(agentId: string): string {
  return (
    `已拒绝：agent "${agentId}" 未被授予运行时目录的自指权限。\n` +
    `如需授权，请在 ~/.tinyclaw/config.toml 中加入：\n` +
    `[selfAccess]\ngrantedAgents = ["${agentId}"]\n` +
    `（该权限覆盖 ~/.tinyclaw 全树，密钥类文件始终除外）`
  );
}

/** 解析 + 统一校验目标路径；返回 null 表示已拒绝（错误文案已算好） */
function resolveTarget(
  rawPath: string,
  ctx?: ToolContext
): { ok: true; abs: string } | { ok: false; message: string } {
  const agentId = ctx?.agentId ?? "default";
  if (!isSelfAccessGranted(agentId)) return { ok: false, message: deniedMessage(agentId) };

  const expanded =
    rawPath === "~" || rawPath.startsWith("~/")
      ? path.join(process.env["HOME"] ?? runtimeRoot(), rawPath.slice(2))
      : rawPath;
  const abs = path.resolve(expanded);

  if (!isInsideRuntime(abs)) {
    return {
      ok: false,
      message: `已拒绝：${abs} 不在运行时目录 ${runtimeRoot()} 内（自指权限不覆盖其他路径）`,
    };
  }
  if (isRuntimeSecretPath(abs)) {
    return {
      ok: false,
      message: `已拒绝：${path.basename(abs)} 属于密钥/凭据，即使拥有自指权限也不可访问`,
    };
  }
  return { ok: true, abs };
}

// ── self_runtime_scan ─────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "self_runtime_scan",
      description:
        "Inspect the disk usage of **your own runtime directory** (~/.tinyclaw) — read-only. Returns total usage, " +
        "per-top-level-entry usage sorted by size, the largest files, and **cleanup candidates** with their size, " +
        "reason and risk level (safe / caution).\n" +
        "Use it when the user asks how much data you occupy, whether the disk is full, or before cleaning anything up.\n" +
        "Requires the [selfAccess] grant; secret files are counted but never listed.",
      parameters: {
        type: "object",
        properties: {
          top: { type: "number", description: "Max number of entries to return (default 12)." },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    if (!isSelfAccessGranted(agentId)) return deniedMessage(agentId);

    const top = Math.max(1, Math.min(50, Number(args["top"] ?? 12) || 12));
    const usage = scanRuntime(undefined, top);

    const lines = [
      `**运行时目录占用** \`${usage.root}\``,
      "",
      `- 合计：${fmtBytes(usage.totalBytes)} / ${usage.totalFiles.toLocaleString()} 个文件` +
        (usage.secretBytes > 0 ? `（另有密钥类文件 ${fmtBytes(usage.secretBytes)}，已隐藏路径）` : ""),
      "",
      "**顶层占用**",
      "",
      ...usage.entries
        .slice(0, top)
        .map((e) => `- ${e.path}/：${fmtBytes(e.bytes)}（${e.files.toLocaleString()} 文件）`),
      "",
      "**最大的文件**",
      "",
      ...usage.biggestFiles.map((f) => `- ${fmtBytes(f.bytes)}  ${f.path}`),
    ];

    if (usage.cleanupCandidates.length > 0) {
      lines.push("", "**可清理候选**（safe = 删了不影响运行；caution = 需确认语义）", "");
      for (const c of usage.cleanupCandidates) {
        lines.push(`- [${c.level}] ${fmtBytes(c.bytes)}  ${c.path} —— ${c.reason}`);
      }
      const safeBytes = usage.cleanupCandidates
        .filter((c) => c.level === "safe")
        .reduce((s, c) => s + c.bytes, 0);
      lines.push("", `其中 safe 类合计约 ${fmtBytes(safeBytes)}。`);
    } else {
      lines.push("", "未发现明显的可清理候选。");
    }

    return lines.join("\n");
  },
});

// ── self_runtime_read ─────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "self_runtime_read",
      description:
        "Read a file or list a directory under **your own runtime directory** (~/.tinyclaw) — read-only.\n" +
        "Use it to inspect your memory files (MEM.md / ACTIVE.md / cards), session records, cron job definitions, " +
        "loop configs, logs, or to check how large a file is and when it changed.\n" +
        "Secret files (config.toml / secrets.toml / mcp.toml / auth/** / *.key / *token*) cannot be read. " +
        "Requires the [selfAccess] grant.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path under the runtime directory (e.g. ~/.tinyclaw/agents/default/memory/MEM.md); a leading ~ is accepted.",
          },
          max_bytes: { type: "number", description: "Max bytes to return in one call (default: configured maxReadBytes)." },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx?: ToolContext): Promise<string> => {
    const raw = String(args["path"] ?? "").trim();
    if (!raw) return "错误：缺少 path 参数";

    const target = resolveTarget(raw, ctx);
    if (!target.ok) return target.message;

    if (!fs.existsSync(target.abs)) return `不存在：${target.abs}`;

    const st = fs.statSync(target.abs);
    if (st.isDirectory()) {
      const dirents = fs.readdirSync(target.abs, { withFileTypes: true });
      const rows = dirents.map((d) => {
        const full = path.join(target.abs, d.name);
        if (d.isDirectory()) {
          const m = measure(full);
          return `- ${d.name}/  ${fmtBytes(m.bytes)}（${m.files} 文件）`;
        }
        if (isRuntimeSecretPath(full)) return `- ${d.name}  （密钥，已隐藏）`;
        const size = (() => {
          try {
            return fs.statSync(full).size;
          } catch {
            return 0;
          }
        })();
        return `- ${d.name}  ${fmtBytes(size)}`;
      });
      return [
        `**目录** \`${target.abs}\`（${dirents.length} 项）`,
        "",
        ...rows.sort(),
      ].join("\n");
    }

    const limit = Math.max(
      1024,
      Number(args["max_bytes"] ?? loadConfig().selfAccess.maxReadBytes) || 200_000
    );
    const raw_buf = fs.readFileSync(target.abs);
    const truncated = raw_buf.length > limit;
    const text = raw_buf.subarray(0, limit).toString("utf-8");
    return [
      `**文件** \`${target.abs}\`（${fmtBytes(st.size)}，修改于 ${new Date(st.mtimeMs).toISOString()}）`,
      truncated ? `（已截断到 ${fmtBytes(limit)}，需要更多请调大 max_bytes）` : "",
      "",
      "```",
      text,
      "```",
    ]
      .filter((l) => l !== "")
      .join("\n");
  },
});

// ── self_runtime_delete ───────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "self_runtime_delete",
      description:
        "Delete a file or directory under **your own runtime directory** (~/.tinyclaw) to free up disk space.\n" +
        "You must pass `confirm: true`; use `dry_run: true` first to see how much space would be freed without deleting.\n" +
        "Protected: the runtime root itself, its `.git` (the config backup repo), the `agents` directory as a whole, " +
        "and every secret file. Run `self_runtime_scan` first to pick candidates; for [caution]-level candidates " +
        "(downloaded assets, outputs, archived memory) explain to the user what will be removed before deleting.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file or directory to delete (under the runtime directory)." },
          confirm: { type: "boolean", description: "Must be true for the deletion to actually happen." },
          dry_run: { type: "boolean", description: "true = only report how much space would be freed, delete nothing." },
        },
        required: ["path", "confirm"],
      },
    },
  },
  execute: async (args, ctx?: ToolContext): Promise<string> => {
    const raw = String(args["path"] ?? "").trim();
    if (!raw) return "错误：缺少 path 参数";

    const target = resolveTarget(raw, ctx);
    if (!target.ok) return target.message;

    const guarded = isProtectedFromDelete(target.abs);
    if (guarded) return `已拒绝：${guarded}（${target.abs}）`;

    if (!fs.existsSync(target.abs)) return `不存在：${target.abs}`;

    const isDir = fs.statSync(target.abs).isDirectory();
    const { bytes, files } = measure(target.abs);
    const dryRun = args["dry_run"] === true;

    if (args["confirm"] !== true && !dryRun) {
      return (
        `需要确认：将删除 ${target.abs}（${fmtBytes(bytes)}${isDir ? `，${files} 个文件` : ""}）。\n` +
        `确认请在参数中加 confirm: true；只想预览就传 dry_run: true。`
      );
    }
    if (dryRun) {
      return `[dry-run] 将删除 ${target.abs}，预计释放 ${fmtBytes(bytes)}（${files} 个文件）。未执行删除。`;
    }

    if (!loadConfig().selfAccess.allowDelete) {
      return "已拒绝：配置 [self_access].allowDelete = false，删除功能处于关闭状态。";
    }

    fs.rmSync(target.abs, { recursive: true, force: true });
    return `已删除：${target.abs}，释放 ${fmtBytes(bytes)}（${files} 个文件）`;
  },
});
