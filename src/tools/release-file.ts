/**
 * release_file tool — 把文件投放到 Dashboard 下载页
 *
 * 两个区（`[web.downloads]`）:
 *   - 临时区 `dir`（缺省 ~/.tinyclaw/downloads/）: 平铺文件名，按 `ttlDays` 自动清理
 *   - 常驻区 `keepDir`（缺省 ~/.tinyclaw/keep/）: `keep: true` 时启用，`name` 可以是
 *     `分类/子类/文件名` 这样的相对路径（按 notes 那样的目录归类），**永不自动清理**
 *
 * 安全闸（别删）:
 *   - 拒绝 `isRuntimeSecretPath()` 判定的密钥/凭证文件（否则等于把密钥挂上一次性链接）
 *   - 拒绝符号链接、非普通文件；目标路径逐段校验（复用 downloads.normalizeKeepRel）
 *   - 单文件与两个区各自的总量都有上限；复制而非移动（原件保留）；每次调用都写审计
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import { isRuntimeSecretPath } from "./path-guard.js";
import { auditToolCall } from "../auth/tool-policy.js";
import { loadConfig } from "../config/loader.js";
import {
  downloadDir,
  downloadsTotalBytes,
  keepDir,
  keepTotalBytes,
  normalizeKeepRel,
} from "../web/backend/downloads.js";

const MAX_NAME_LEN = 150;

/** 临时区目标文件名清洗：去路径分隔符/控制字符/Windows 保留字符，去前导点 */
function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim();
  s = s.replace(/^\.+/, "_");
  if (s.length > MAX_NAME_LEN) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, MAX_NAME_LEN - ext.length) + ext;
  }
  return s || "file";
}

/** 目录内同名的下一个可用名：a.txt → a-1.txt → a-2.txt */
function uniqueDest(dir: string, name: string): string {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function deny(reason: string, ctx: ToolContext | undefined, args: Record<string, unknown>): string {
  auditToolCall({
    event: "tool",
    decision: "deny",
    tool: "release_file",
    origin: ctx?.origin,
    agentId: ctx?.agentId ?? "unknown",
    ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    reason,
    args,
  });
  return `已拒绝：${reason}`;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "release_file",
      description:
        "Publish a file to the Dashboard downloads page so the user can fetch it.\n\n" +
        "Use this when the user asked for a deliverable (a report, script, archive, image, …) " +
        "and you want them to pick it up from the dashboard. The file is COPIED into the " +
        "downloads area — the original is left untouched. The user then opens the 下载 page, " +
        "picks the file and gets a one-time `curl` command.\n\n" +
        "Two zones:\n" +
        "  - default (temp): flat file names, auto-cleaned after a retention period.\n" +
        "  - `keep: true` (persistent): for files worth keeping and re-downloading; `name` may be " +
        "a relative path like `tools/pack/x.zip` to file it under categories (like the notes tree). " +
        "Persistent files are never auto-cleaned.\n\n" +
        "Provide EITHER `path` (an existing local file) OR `content` (inline text to write). " +
        "`name` is the file name the user will see (defaults to the source file name).\n" +
        "Secret/credential files are refused; symbolic links are refused.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path of an existing file to publish",
          },
          content: {
            type: "string",
            description: "Inline text content to publish (alternative to `path`)",
          },
          name: {
            type: "string",
            description:
              "File name shown to the user (optional; defaults to the source file name). " +
              "With `keep: true` this may be a relative path such as `tools/pack/x.zip`.",
          },
          keep: {
            type: "boolean",
            description:
              "Put the file in the persistent zone (categorised, never auto-cleaned) instead of " +
              "the temp zone (default false)",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite an existing file with the same name (default false)",
          },
        },
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const srcArg = String(args["path"] ?? "").trim();
    const content = typeof args["content"] === "string" ? String(args["content"]) : "";
    const overwrite = args["overwrite"] === true;
    const keep = args["keep"] === true;

    if (!srcArg && !content) {
      return "错误：path 与 content 至少要提供一个";
    }
    if (srcArg && content) {
      return "错误：path 与 content 只能提供一个";
    }

    const cfg = loadConfig().web.downloads;
    if (!cfg.enabled) {
      return deny("Dashboard 下载功能未启用", ctx, args);
    }

    const maxFileBytes = cfg.maxFileMb * 1024 * 1024;
    const maxTotalBytes = (keep ? cfg.keepMaxTotalMb : cfg.maxTotalMb) * 1024 * 1024;

    let dir: string;
    try {
      dir = keep ? keepDir(cfg) : downloadDir(cfg);
    } catch (e) {
      return `错误：无法准备${keep ? "常驻区" : "临时区"}目录：${String(e)}`;
    }

    // 目标相对路径：常驻区允许 `分类/文件`（与下载侧共用逐段校验），临时区只允许平铺
    const rawName = args["name"]
      ? String(args["name"])
      : srcArg
        ? path.basename(srcArg)
        : "file.txt";
    let rel: string;
    if (keep) {
      const norm = normalizeKeepRel(rawName);
      if (!norm) return deny(`常驻区目标路径非法：${rawName}`, ctx, args);
      rel = norm;
    } else {
      rel = sanitizeName(rawName);
    }

    let size: number;
    let srcPath: string | null = null;

    if (srcArg) {
      srcPath = path.isAbsolute(srcArg)
        ? path.resolve(srcArg)
        : path.resolve(ctx?.cwd ?? process.cwd(), srcArg);

      let st: fs.Stats;
      try {
        st = fs.lstatSync(srcPath);
      } catch {
        return deny(`源文件不存在：${srcPath}`, ctx, args);
      }
      if (st.isSymbolicLink()) return deny("不接受符号链接（可能是路径逃逸）", ctx, args);
      if (!st.isFile()) return deny(`不是普通文件：${srcPath}`, ctx, args);
      if (isRuntimeSecretPath(srcPath)) {
        return deny("密钥/凭证文件不可释放", ctx, args);
      }
      size = st.size;
    } else {
      size = Buffer.byteLength(content, "utf8");
    }

    if (size > maxFileBytes) {
      return deny(
        `文件 ${(size / 1048576).toFixed(1)} MB 超过单文件上限 ${cfg.maxFileMb} MB`,
        ctx,
        args
      );
    }

    const used = keep ? keepTotalBytes(cfg) : downloadsTotalBytes(cfg);
    if (used + size > maxTotalBytes) {
      const capMb = keep ? cfg.keepMaxTotalMb : cfg.maxTotalMb;
      return deny(
        `${keep ? "常驻区" : "临时区"}已达上限（已用 ${(used / 1048576).toFixed(0)} MB + 本次 ${(
          size / 1048576
        ).toFixed(1)} MB > ${capMb} MB），请先在下载页删除旧文件`,
        ctx,
        args
      );
    }

    const targetDir = path.join(dir, path.dirname(rel));
    if (keep) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (e) {
        return `错误：无法创建分类目录：${String(e)}`;
      }
    }
    const dest = overwrite ? path.join(dir, rel) : uniqueDest(targetDir, path.basename(rel));
    const finalName = path.relative(dir, dest);
    if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
      return deny("目标文件是符号链接，拒绝覆盖", ctx, args);
    }

    try {
      if (srcPath) {
        fs.copyFileSync(srcPath, dest);
      } else {
        fs.writeFileSync(dest, content, "utf-8");
      }
    } catch (e) {
      return `错误：写入释放目录失败：${String(e)}`;
    }

    auditToolCall({
      event: "tool",
      decision: "allow",
      tool: "release_file",
      origin: ctx?.origin,
      agentId: ctx?.agentId ?? "unknown",
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      reason: `释放到${keep ? "常驻区" : "临时区"}：${finalName}`,
      args: {
        path: srcPath ?? "(inline content)",
        name: finalName,
        size,
        zone: keep ? "keep" : "temp",
      },
    });

    return JSON.stringify({
      success: true,
      zone: keep ? "keep" : "temp",
      name: finalName,
      size,
      dir,
      note: `用户在 Dashboard 的「下载」页${keep ? "常驻区" : "临时区"}可看到该文件，并生成一次性下载命令`,
    });
  },
});
