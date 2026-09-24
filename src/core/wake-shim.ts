/**
 * `wake` shim —— 把 wake 物化成一个**独立的小可执行文件**（不是 `tinyclaw` 本体），并注入 PATH。
 *
 * 为什么要这样（用户口径）：脚本 / cron / job / 沙箱里应该"喊一声 `wake …` 就有"，但
 * **不该把整个 `tinyclaw` CLI 暴露出去**（它带着 config / mcp / restart 等一大片命令面）。
 * 所以这里生成一个只做一件事的自包含脚本：解析参数 → 往 IPC socket 发一条 `wake` 请求
 * → 打印受理结果。零依赖（只用 node 内置 net/fs），不 import 仓库任何模块，因此
 * **沙箱内也能跑**（socket 实测可达）。
 *
 * 为什么是"文件"：PATH 查找在本质上需要一个目录项（`fexecve()` 能从内存 fd 执行，但它
 * 不做 PATH 查找；`memfd_create` 的匿名文件只能经 `/proc/<pid>/fd/N` 暴露，
 * 那里的文件名是 fd 号，`wake` 这个名字永远解析不到）。所以"能被 PATH 找到"就必须落一个
 * 可执行文件；这里落在 tinyclaw 自己的运行时目录 `~/.tinyclaw/bin/`，随服务启动重建。
 *
 * 简洁性（job / cron 里零参数）：
 * job / cron 的运行环境里会被注入三个自标识变量（见 `job-manager.ts` / `cron/runner.ts`）：
 *   - `TINYCLAW_WAKE_TARGET`：该任务"天然该唤醒的会话"
 *   - `TINYCLAW_AGENT_ID`：该任务的 agent
 *   - `TINYCLAW_JOB_ID` / `TINYCLAW_CRON_JOB_ID`：任务 id（自动当 `--source`）
 * 于是脚本里只需要：`wake "训练跑完了，看下指标"`，甚至 `tail -50 log | wake --stdin`。
 *
 * 幂等：内容不一致才重写（原子写 + 0755）。解释器路径直接钉死生成时的 `process.execPath`
 * （= 服务同款 node），不受 job/shell 的 PATH 影响。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IPC_SOCKET_PATH } from "../ipc/protocol.js";

/** shim 内容版本；改动生成脚本时递增，服务启动会据此重写。 */
export const WAKE_SHIM_VERSION = 3;

/** shim 所在目录（注入 PATH 的就是它）。 */
export function wakeShimDir(): string {
  return path.join(os.homedir(), ".tinyclaw", "bin");
}

/** shim 可执行文件路径。 */
export function wakeShimPath(): string {
  return path.join(wakeShimDir(), "wake");
}

/** 生成 shim 源码（纯 JS；`nodePath` 会把服务同款 node 钉进 shebang）。 */
function renderWakeShim(nodePath: string): string {
  const socket = JSON.stringify(IPC_SOCKET_PATH);
  return [
    `#!${nodePath}`,
    `// tinyclaw \`wake\` shim — 自动生成，请勿手改（版本 ${WAKE_SHIM_VERSION}）。`,
    "// 只做一件事：把参数转成 IPC wake 请求（不暴露 tinyclaw CLI 的其它命令）。",
    '"use strict";',
    'const net = require("node:net");',
    'const fs = require("node:fs");',
    `const SOCKET = ${socket};`,
    'const USAGE = [',
    '  "用法: wake [选项] [消息]",',
    '  "  -s, --session <id>   目标会话（job/cron 里可省略：默认取 $TINYCLAW_WAKE_TARGET）",',
    '  "  -a, --agent <id>     目标 agent（可省略：默认取 $TINYCLAW_AGENT_ID）",',
    '  "      --source <标签>  来源标签（可省略：job/cron 里自动取任务 id）",',
    '  "      --stdin          从标准输入读消息正文（适合把日志尾部直接交给 agent）",',
    "].join(\"\\n\");",
    'function fail(msg) { process.stderr.write("wake: " + msg + "\\n"); process.exit(1); }',
    "const argv = process.argv.slice(2);",
    "let sessionId, agentId, source, fromStdin = false;",
    "const rest = [];",
    "for (let i = 0; i < argv.length; i++) {",
    "  const a = argv[i];",
    '  if ((a === "-s" || a === "--session") && argv[i + 1]) sessionId = argv[++i];',
    '  else if ((a === "-a" || a === "--agent") && argv[i + 1]) agentId = argv[++i];',
    '  else if (a === "--source" && argv[i + 1]) source = argv[++i];',
    '  else if (a === "--stdin") fromStdin = true;',
    '  else if (a === "-h" || a === "--help") { process.stdout.write(USAGE + "\\n"); process.exit(0); }',
    "  else rest.push(a);",
    "}",
    '// 目标：显式参数 > 任务自标识（job/cron 注入）',
    'if (!sessionId && !agentId) {',
    '  if (process.env.TINYCLAW_WAKE_TARGET) sessionId = process.env.TINYCLAW_WAKE_TARGET;',
    '  else if (process.env.TINYCLAW_AGENT_ID) agentId = process.env.TINYCLAW_AGENT_ID;',
    "}",
    'if (!sessionId && !agentId) fail("需要 -s <sessionId> 或 -a <agentId>（不在 job/cron 环境里时必须显式给）\\n" + USAGE);',
    '// 来源标签：显式 > 任务 id',
    "if (!source) {",
    '  if (process.env.TINYCLAW_JOB_ID) source = "job:" + process.env.TINYCLAW_JOB_ID;',
    '  else if (process.env.TINYCLAW_CRON_JOB_ID) source = "cron:" + process.env.TINYCLAW_CRON_JOB_ID;',
    "}",
    'let message = rest.join(" ").trim();',
    "if (!message && fromStdin) {",
    '  try { message = fs.readFileSync(0, "utf8").trim(); }',
    '  catch (e) { fail("读取标准输入失败: " + e.message); }',
    "}",
    'if (!message) fail("消息不能为空（或用 --stdin 从管道读）\\n" + USAGE);',
    'const req = { type: "wake", message: message };',
    "if (sessionId) req.sessionId = sessionId;",
    "if (agentId) req.agentId = agentId;",
    "if (source) req.source = source;",
    'let buf = "";',
    "let done = false;",
    "const sock = net.connect(SOCKET);",
    "function finish(code) {",
    "  if (done) return;",
    "  done = true;",
    "  try { sock.destroy(); } catch (e) { /* 已断开 */ }",
    "  process.exit(code);",
    "}",
    'sock.on("connect", function () { sock.write(JSON.stringify(req) + "\\n"); });',
    'sock.on("data", function (d) {',
    '  buf += d.toString("utf8");',
    '  const lines = buf.split("\\n");',
    "  buf = lines.pop();",
    "  for (const line of lines) {",
    "    if (!line.trim()) continue;",
    "    let resp;",
    "    try { resp = JSON.parse(line); } catch (e) { continue; }",
    '    if (resp.type === "woken") {',
    '      process.stdout.write("✅ 已唤醒 " + resp.sessionId + "\\n" + (resp.note || "") + "\\n");',
    "      finish(0);",
    '    } else if (resp.type === "error") {',
    "      fail(resp.message);",
    "    }",
    "  }",
    "});",
    'sock.on("error", function (err) { fail(err.message + "（socket: " + SOCKET + "）"); });',
    'sock.on("close", function () { if (!done) fail("连接已关闭（服务在跑吗？socket: " + SOCKET + "）"); });',
    "",
  ].join("\n");
}

export interface WakeShimResult {
  path: string;
  /** 本次是否写入（内容变化 / 首次生成）。 */
  written: boolean;
  /** 生成时钉进去的 node 路径。 */
  nodePath: string;
}

/**
 * 幂等地物化 shim：内容不一致才重写（临时文件 + rename 原子替换，0755）。
 * 由 `main.ts` 在服务启动时调用一次。
 */
export function ensureWakeShim(nodePath: string = process.execPath): WakeShimResult {
  const dir = wakeShimDir();
  const file = wakeShimPath();
  const content = renderWakeShim(nodePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (existing === content) {
      fs.chmodSync(file, 0o755);
      return { path: file, written: false, nodePath };
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o755 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o755);
    return { path: file, written: true, nodePath };
  } catch (err) {
    console.warn(
      "[wake-shim] 物化 wake shim 失败（脚本里请改用绝对路径调用）：",
      err instanceof Error ? err.message : err
    );
    return { path: file, written: false, nodePath };
  }
}

/**
 * 把 shim 目录**前置**到一份 env 的 PATH 上（幂等：已在最前则不重复）。
 * 返回新对象，不修改入参 —— job / cron / exec_shell 三处共用。
 */
export function withWakeShimPath<T extends Record<string, string | undefined>>(
  env: T
): Record<string, string> {
  const dir = wakeShimDir();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  const current = out["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
  const parts = current.split(":").filter((p) => p.length > 0);
  out["PATH"] = parts[0] === dir ? current : [dir, ...parts].join(":");
  return out;
}

/**
 * 任务自标识变量：job / cron 运行时注入，让 `wake` 在任务里可以**零参数**调用
 * （目标会话与来源标签都自动带上）。
 */
export const WAKE_ENV = {
  /** 目标会话（该任务天然该唤醒的那个会话）。 */
  target: "TINYCLAW_WAKE_TARGET",
  /** 任务所属 agent。 */
  agent: "TINYCLAW_AGENT_ID",
  /** job 任务的 id（自动成为 `--source job:<id>`）。 */
  jobId: "TINYCLAW_JOB_ID",
  /** cron 任务的 id（自动成为 `--source cron:<id>`）。 */
  cronJobId: "TINYCLAW_CRON_JOB_ID",
} as const;
