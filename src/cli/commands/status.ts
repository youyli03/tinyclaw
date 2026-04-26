/**
 * CLI 命令：status
 *
 * 显示 tinyclaw 运行状态概览：
 *   - 主进程是否在运行（PID 文件）
 *   - 配置文件是否存在且合法
 *   - 当前 LLM 后端摘要
 *   - GitHub Token 状态（若有 Copilot 后端）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { printTable, bold, dim, green, red, yellow, cyan, section } from "../ui.js";
import { CONFIG_PATH } from "../../config/writer.js";
import { ConfigSchema } from "../../config/schema.js";
import { parse } from "smol-toml";
import { loadSavedGitHubToken } from "../../llm/copilotSetup.js";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");

export const description = "显示 tinyclaw 运行状态概览";
export const usage = "status";

export async function run(_args: string[]): Promise<void> {
  section("tinyclaw 运行状态");

  // ── 进程状态 ─────────────────────────────────────────────────────────────────
  let processStatus = red("未运行");
  let pid = 0;

  if (fs.existsSync(SERVICE_PID_FILE)) {
    try {
      pid = parseInt(fs.readFileSync(SERVICE_PID_FILE, "utf-8").trim(), 10);
      process.kill(pid, 0); // 仅检测，不发信号
      processStatus = green(`运行中 (PID ${pid})`);
    } catch {
      processStatus = yellow("已停止（PID 文件残留）");
    }
  }

  console.log(`进程状态：${processStatus}`);

  // ── 配置文件 ──────────────────────────────────────────────────────────────────
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`配置文件：${red("不存在")}  ${dim(CONFIG_PATH)}`);
    return;
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    console.log(`配置文件：${green("存在")}  ${dim(CONFIG_PATH)}`);
  } catch (e) {
    console.log(`配置文件：${red("解析失败")}  ${dim(String(e))}`);
    return;
  }

  const parsed = ConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.log(`配置验证：${red("失败")}\n${issues}`);
    return;
  }

  console.log(`配置验证：${green("通过")}`);

  const cfg = parsed.data;

  // ── LLM 后端摘要 ──────────────────────────────────────────────────────────────
  console.log(`\n${bold("LLM 后端")}`);
  const entries: [string, typeof cfg.llm.backends.daily | undefined][] = [
    ["daily", cfg.llm.backends.daily],
    ["summarizer", cfg.llm.backends.summarizer],
  ];

  const rows = entries.map(([name, b]) => {
    if (!b) return [name, dim("(未配置，回退 daily)")];
    const { provider, modelId } = (() => {
      const slash = b.model.indexOf("/");
      return slash === -1
        ? { provider: b.model, modelId: "" }
        : { provider: b.model.slice(0, slash), modelId: b.model.slice(slash + 1) };
    })();
    const providerStr = provider === "copilot" ? cyan("copilot") : provider === "openai" ? "openai" : dim(provider);
    const modelStr = modelId === "auto" || modelId === "" ? yellow(b.model) : cyan(b.model);
    return [bold(name), providerStr, modelStr];
  });

  printTable(["后端", "Provider", "模型 Symbol"], rows);

  // ── GitHub Token（仅 Copilot 提供商） ─────────────────────────────────────────
  const hasCopilot = !!cfg.providers.copilot;
  if (hasCopilot) {
    const saved = loadSavedGitHubToken();
    if (saved) {
      const masked = saved.slice(0, 8) + "…" + saved.slice(-4);
      console.log(`\nGitHub Token：${green("已保存")}  ${dim(masked)}`);
    } else {
      console.log(`\nGitHub Token：${yellow("未保存")}  ${dim("（将使用 gh CLI 或 Device Flow）")}`);
    }
  }

  // ── Channels ─────────────────────────────────────────────────────────────────
  console.log(`\n${bold("Channels")}`);
  const qqbotsEntries = Object.entries(cfg.channels.qqbots ?? {});
  if (qqbotsEntries.length > 0) {
    for (const [id, bot] of qqbotsEntries) {
      console.log(`  QQBot[${id}]：${green("已配置")}  ${dim(`appId: ${bot.appId}`)}`);
    }
  } else {
    console.log(`  QQBot：${yellow("未配置")}`);
  }
}
