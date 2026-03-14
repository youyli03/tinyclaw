/**
 * tinyclaw 入口
 *
 * 启动顺序：
 * 1. 验证配置
 * 2. 初始化 LLM / QMD 注册表（懒加载）
 * 3. 启动 QQBot connector
 * 4. 监听信号，优雅退出
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config/loader.js";
import { llmRegistry } from "./llm/registry.js";
import { Session } from "./core/session.js";
import { runAgent } from "./core/agent.js";
import { QQBotConnector } from "./connectors/qqbot/index.js";
import type { InboundMessage } from "./connectors/base.js";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");

// ── 每个 peerId 维护一个独立的 Session ────────────────────────────────────────

const sessions = new Map<string, Session>();

function getSession(peerId: string): Session {
  let s = sessions.get(peerId);
  if (!s) { s = new Session(); sessions.set(peerId, s); }
  return s;
}

// ── 消息处理 ──────────────────────────────────────────────────────────────────

async function handleMessage(msg: InboundMessage): Promise<string> {
  const session = getSession(msg.peerId);
  const opts = {
    onMFAPrompt: (prompt: string) => console.log("[MFA]", prompt),
  };
  const result = await runAgent(session, msg.content, opts);
  return result.content;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 0. 写 PID 文件（供 CLI restart 使用）
  try {
    fs.mkdirSync(path.dirname(SERVICE_PID_FILE), { recursive: true });
    fs.writeFileSync(SERVICE_PID_FILE, String(process.pid), "utf-8");
  } catch {
    // 非致命，忽略
  }

  // 1. 验证配置（fail-fast）
  const cfg = loadConfig();
  console.log("[tinyclaw] Config loaded");

  // 2. 预初始化 LLM 后端（Copilot 后端需异步 token 换取 + 模型发现）
  await llmRegistry.init();
  console.log(`[tinyclaw] LLM backend ready (model=${llmRegistry.get("daily").model})`);

  // 3. 启动 QQBot
  if (!cfg.channels.qqbot) {
    console.log("[tinyclaw] QQBot not configured, exiting");
    process.exit(0);
  }

  const connector = new QQBotConnector();
  connector.onMessage(handleMessage);

  // 4. 优雅退出
  const handleExit = async (signal: string) => {
    console.log(`\n[tinyclaw] Received ${signal}, shutting down...`);
    await connector.stop();
    try { fs.unlinkSync(SERVICE_PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => void handleExit("SIGINT"));
  process.on("SIGTERM", () => void handleExit("SIGTERM"));

  console.log("[tinyclaw] Starting QQBot connector...");
  await connector.start(); // 阻塞直到 abort
}

main().catch((err) => {
  console.error("[tinyclaw] Fatal:", err);
  process.exit(1);
});
