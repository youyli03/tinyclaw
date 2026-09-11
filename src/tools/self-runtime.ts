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
        "查看**你自己的运行时目录**（~/.tinyclaw）的磁盘占用（只读）。返回：总占用、顶层各项占用" +
        "（按大小排序）、最大的若干文件、以及**可清理候选**（附体积、原因、风险等级 safe/caution）。\n" +
        "适用场景：用户问「你的数据有多大 / 磁盘满了吗」，或要清理空间时先取真实数据再决定删什么。\n" +
        "需要被授予 [self_access] 权限；密钥类文件只计入体积、不会出现在清单里。",
      parameters: {
        type: "object",
        properties: {
          top: { type: "number", description: "返回的最大文件条数（默认 12）" },
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
        "读取**你自己的运行时目录**（~/.tinyclaw）下的文件或列出目录内容（只读）。\n" +
        "适用场景：查看自己的记忆文件（MEM.md / ACTIVE.md / 卡片）、会话记录、cron 任务定义、" +
        "loop 配置、日志，或确认某个文件多大、什么时候改的。\n" +
        "密钥类文件（config.toml / secrets.toml / mcp.toml / auth/** / *.key / *token*）不可读取。" +
        "需要被授予 [self_access] 权限。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "运行时目录下的绝对路径（如 ~/.tinyclaw/agents/default/memory/MEM.md）或用 ~ 开头的路径",
          },
          max_bytes: { type: "number", description: "单次返回上限（默认取配置 maxReadBytes）" },
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
        "删除**你自己的运行时目录**（~/.tinyclaw）下的文件或目录，用于清理磁盘。\n" +
        "必须显式传 `confirm: true`；先用 `dry_run: true` 可以只看会释放多少空间而不真删。\n" +
        "受保护：运行时根目录本身、根下的 .git（配置备份仓库）、agents 目录整体，以及所有密钥文件。\n" +
        "删除前建议先 self_runtime_scan 确认候选；对 [caution] 级候选（下载素材/产物/记忆归档）" +
        "应先在回复里向用户说明再删。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "运行时目录下要删除的绝对路径（文件或目录）" },
          confirm: { type: "boolean", description: "必须为 true 才真正删除" },
          dry_run: { type: "boolean", description: "true = 只报告将释放的空间，不删除" },
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
