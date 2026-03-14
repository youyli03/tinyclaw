/**
 * CLI 命令：model
 *
 * 子命令：
 *   model list [backend]        列出所有可用模型（Copilot 后端调用 API；OpenAI 显示当前）
 *   model show                  显示三个后端当前配置的模型
 *   model set [daily|code|summarizer]  交互式选择并写入配置，可选是否重启
 */

import { loadConfig } from "../../config/loader.js";
import { getCopilotModels } from "../../llm/copilot.js";
import { patchTomlField } from "../../config/writer.js";
import {
  printTable, select, confirm, prompt,
  bold, dim, green, yellow, cyan, red, section,
} from "../ui.js";
import type { AnyLLMBackend } from "../../config/schema.js";

type BackendName = "daily" | "code" | "summarizer";
const BACKEND_NAMES: BackendName[] = ["daily", "code", "summarizer"];

// ── 子命令实现 ────────────────────────────────────────────────────────────────

async function cmdShow(): Promise<void> {
  const cfg = loadConfig();
  section("当前模型配置");

  const rows: string[][] = [];
  for (const name of BACKEND_NAMES) {
    const b: AnyLLMBackend | undefined =
      name === "daily" ? cfg.llm.backends.daily
      : name === "code" ? cfg.llm.backends.code
      : cfg.llm.backends.summarizer;

    if (!b) {
      rows.push([name, dim("(未配置，回退到 daily)")]);
      continue;
    }
    const provider = b.provider === "copilot" ? cyan("copilot") : "openai";
    const model = b.model === "auto" ? yellow("auto") : cyan(b.model);
    rows.push([bold(name), provider, model]);
  }
  printTable(["后端", "Provider", "模型"], rows);
}

async function cmdList(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const target = (args[0] as BackendName | undefined) ?? "daily";

  if (!BACKEND_NAMES.includes(target)) {
    console.error(red(`未知后端 "${target}"，可选：daily / code / summarizer`));
    return;
  }

  const b: AnyLLMBackend | undefined =
    target === "daily" ? cfg.llm.backends.daily
    : target === "code" ? cfg.llm.backends.code
    : cfg.llm.backends.summarizer;

  if (!b) {
    console.log(dim(`后端 '${target}' 未配置（回退到 daily）`));
    return;
  }

  if (b.provider === "copilot") {
    console.log(`\n正在获取 Copilot 模型列表……`);
    const models = await getCopilotModels(b.githubToken);
    const picker = models.filter((m) => m.isPickerEnabled);

    section(`Copilot 可用模型（model_picker_enabled，后端: ${target}）`);
    printTable(
      ["#", "ID", "名称", "供应商", "分类", "默认", "乘数", "预览"],
      picker.map((m, i) => [
        String(i + 1),
        m.id,
        m.name,
        m.vendor,
        m.category ?? "-",
        m.isDefault ? green("✓") : "",
        m.multiplier === undefined ? "-"
          : m.multiplier === 0 ? green("free")
          : yellow(`×${m.multiplier}`),
        m.preview ? dim("preview") : "",
      ])
    );
    console.log(`\n共 ${picker.length} 个可选模型（总计 ${models.length} 个）`);
  } else {
    console.log(`\n后端 '${target}' 使用 OpenAI-compatible 接口`);
    console.log(`当前模型：${cyan(b.model)}`);
    console.log(dim("OpenAI-compatible 后端不支持自动枚举模型列表，请手动填写 model ID"));
  }
}

async function cmdSet(args: string[]): Promise<void> {
  const cfg = loadConfig();

  // 确定目标后端
  let backendName: BackendName = "daily";
  if (args[0] && BACKEND_NAMES.includes(args[0] as BackendName)) {
    backendName = args[0] as BackendName;
  } else if (args[0]) {
    // 非 flag 参数但不是合法后端名，提示用法
    console.error(red(`未知后端 "${args[0]}"，可选：daily / code / summarizer`));
    console.log(dim("用法：model set [daily|code|summarizer]"));
    return;
  }

  const b: AnyLLMBackend | undefined =
    backendName === "daily" ? cfg.llm.backends.daily
    : backendName === "code" ? cfg.llm.backends.code
    : cfg.llm.backends.summarizer;

  if (!b) {
    // 后端未配置，询问是否使用 daily
    console.log(yellow(`后端 '${backendName}' 未配置，将修改 'daily' 后端`));
    backendName = "daily";
  }

  const activeCfg: AnyLLMBackend =
    backendName === "daily" ? cfg.llm.backends.daily
    : backendName === "code" ? cfg.llm.backends.code ?? cfg.llm.backends.daily
    : cfg.llm.backends.summarizer ?? cfg.llm.backends.daily;

  let newModelId: string;

  if (activeCfg.provider === "copilot") {
    // Copilot 后端：拉取模型列表，交互式选择
    console.log(`\n正在获取 Copilot 可用模型……`);
    const models = await getCopilotModels(activeCfg.githubToken);
    const picker = models.filter((m) => m.isPickerEnabled);

    if (picker.length === 0) {
      console.error(red("该账号暂无 picker-enabled 模型"));
      return;
    }

    const currentModel = activeCfg.model;
    const items = picker.map((m) => ({
      label: m.isDefault ? `${m.name} ${green("(当前默认)")}` : m.name,
      value: m.id,
      note: [
        m.vendor,
        m.category ?? "",
        m.multiplier === undefined ? ""
          : m.multiplier === 0 ? "free"
          : `×${m.multiplier}`,
        m.preview ? "[preview]" : "",
        currentModel !== "auto" && currentModel === m.id ? "← 当前" : "",
      ].filter(Boolean).join(" · "),
    }));

    // 在列表末尾加入 "auto" 选项
    items.push({
      label: bold("auto") + dim("（自动选择默认模型）"),
      value: "auto",
      note: "",
    });

    newModelId = await select(`选择 [${backendName}] 使用的模型`, items);
  } else {
    // OpenAI-compatible：直接输入
    const current = activeCfg.model;
    console.log(`\n后端 [${backendName}] 当前模型：${cyan(current)}`);
    const input = await prompt("输入新模型 ID（留空取消）: ");
    const trimmed = input.trim();
    if (!trimmed) {
      console.log(dim("已取消"));
      return;
    }
    newModelId = trimmed;
  }

  // 写回配置文件
  patchTomlField(["llm", "backends", backendName], "model", JSON.stringify(newModelId));
  console.log(`\n${green("✓")} 已将 [${backendName}] 模型更新为 ${cyan(newModelId)}`);

  // 询问是否重启
  const shouldRestart = await confirm("是否重启 tinyclaw 服务？");
  if (shouldRestart) {
    const { run: restartRun } = await import("./restart.js");
    await restartRun([]);
  }
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("用法：")}
  model show                  显示当前模型配置
  model list [backend]        列出可用模型（默认后端: daily）
  model set  [backend]        交互式选择模型（默认后端: daily）

${bold("后端名：")}  daily | code | summarizer
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const description = "模型管理：列出 / 查看 / 切换当前 LLM 模型";
export const usage = "model <show|list|set> [backend]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const rest = args.slice(1);

  switch (sub) {
    case "show":   return cmdShow();
    case "list":   return cmdList(rest);
    case "set":    return cmdSet(rest);
    case "--help":
    case "-h":
    case "help":   printHelp(); return;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}
