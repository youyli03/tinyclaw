/**
 * CLI 命令：model
 *
 * 子命令：
 *   model list [-a]             列出所有 provider 的可用模型
 *   model show                  显示三个后端当前配置的模型 symbol
 *   model set [daily|code|summarizer]  交互式选择并写入配置
 *
 * 模型 symbol 格式：provider/model-id，如 "copilot/gpt-4o"、"openai/gpt-4o-mini"
 */

import { loadConfig } from "../../config/loader.js";
import { getCopilotModels } from "../../llm/copilot.js";
import { patchTomlField } from "../../config/writer.js";
import {
  printTable, select, confirm, prompt,
  bold, dim, green, yellow, cyan, red, section,
} from "../ui.js";

type BackendName = "daily" | "summarizer";
const BACKEND_NAMES: BackendName[] = ["daily", "summarizer"];

// ── 子命令实现 ────────────────────────────────────────────────────────────────

async function cmdShow(): Promise<void> {
  const cfg = loadConfig();
  section("当前模型配置");

  const rows: string[][] = [];
  for (const name of BACKEND_NAMES) {
    const role =
      name === "daily" ? cfg.llm.backends.daily
      : cfg.llm.backends.summarizer;

    if (!role) {
      rows.push([name, dim("(未配置，回退到 daily)")]);
      continue;
    }
    rows.push([bold(name), cyan(role.model)]);
  }
  printTable(["后端", "模型 Symbol"], rows);
}

async function listCopilot(githubToken: string, showAll: boolean): Promise<void> {
  process.stdout.write(`\n正在获取 Copilot 模型列表……`);
  const models = await getCopilotModels(githubToken);
  const display = showAll ? models : models.filter((m) => m.isPickerEnabled);
  const title = showAll
    ? `Copilot 全部模型（共 ${models.length} 个）`
    : `Copilot 可用模型（model_picker_enabled）`;

  console.log(` ${green("OK")}`);
  section(title);
  printTable(
    ["#", "Symbol", "乘数"],
    display.map((m, i) => [
      String(i + 1),
      cyan(`copilot/${m.id}`),
      m.multiplier === undefined ? "-"
        : m.multiplier === 0 ? green("free")
        : yellow(`×${m.multiplier}`),
    ])
  );
  if (!showAll) {
    console.log(dim(`\n显示 ${display.length} 个可选模型（总计 ${models.length} 个，-a 查看全部）`));
  }
}

async function listOpenAI(baseUrl: string, apiKey: string, showAll: boolean): Promise<void> {
  if (!showAll) {
    console.log(dim(`\n[providers.openai] ${baseUrl}，加 -a 枚举全部可用模型`));
    return;
  }
  process.stdout.write(`\n正在调用 ${baseUrl}/models……`);
  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      console.log(` ${red("失败")}`);
      if (resp.status === 401) {
        console.error(red(`  API Key 认证失败（HTTP 401）`));
        console.log(dim(`  请检查 config.toml 中 [providers.openai].apiKey 是否正确`));
      } else {
        console.error(red(`  HTTP ${resp.status} ${resp.statusText}`));
      }
      return;
    }
    const data = (await resp.json()) as { data?: { id: string; owned_by?: string }[] };
    const list = data.data ?? [];
    console.log(` ${green("OK")}`);
    section(`OpenAI 可用模型（${baseUrl}，共 ${list.length} 个）`);
    printTable(
      ["#", "Symbol", "创建方"],
      list.map((m, i) => [String(i + 1), cyan(`openai/${m.id}`), m.owned_by ?? "-"])
    );
  } catch (e) {
    console.log(` ${red("失败")}`);
    console.error(red(`  无法获取模型列表：${e}`));
  }
}

async function cmdList(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const showAll = args.includes("--all") || args.includes("-a");

  // 遍历所有已配置的 provider，与后端角色无关
  const { copilot, openai } = cfg.providers;

  if (!copilot && !openai) {
    console.log(red("\n未配置任何 provider，请在 config.toml 中添加 [providers.openai] 或 [providers.copilot]"));
    return;
  }

  if (copilot) {
    await listCopilot(copilot.githubToken, showAll);
  }
  if (openai) {
    await listOpenAI(openai.baseUrl, openai.apiKey, showAll);
  }
}

async function cmdSet(args: string[]): Promise<void> {
  const cfg = loadConfig();

  // 确定目标后端
  let backendName: BackendName = "daily";
  if (args[0] && BACKEND_NAMES.includes(args[0] as BackendName)) {
    backendName = args[0] as BackendName;
  } else if (args[0]) {
    console.error(red(`未知后端 "${args[0]}"，可选：daily / summarizer`));
    console.log(dim("用法：model set [daily|summarizer]"));
    return;
  }

  const currentRole =
    backendName === "daily" ? cfg.llm.backends.daily
    : cfg.llm.backends.summarizer;

  const currentSymbol = currentRole?.model ?? dim("(未配置)");

  // 收集所有可选的 symbol
  interface PickItem { label: string; value: string; note: string }
  const items: PickItem[] = [];

  if (cfg.providers.copilot) {
    console.log(`\n正在获取 Copilot 可用模型……`);
    const models = await getCopilotModels(cfg.providers.copilot.githubToken);
    const picker = models.filter((m) => m.isPickerEnabled);
    for (const m of picker) {
      const symbol = `copilot/${m.id}`;
      items.push({
        label: m.isDefault ? `${m.name} ${green("(默认)")}` : m.name,
        value: symbol,
        note: [
          cyan(symbol),
          m.vendor,
          m.category ?? "",
          m.multiplier === undefined ? ""
            : m.multiplier === 0 ? "free"
            : `×${m.multiplier}`,
          m.preview ? "[preview]" : "",
          currentSymbol === symbol ? "← 当前" : "",
        ].filter(Boolean).join(" · "),
      });
    }
    // auto 选项
    items.push({
      label: bold("copilot/auto") + dim("（自动选择 Copilot 默认模型）"),
      value: "copilot/auto",
      note: currentSymbol === "copilot/auto" ? "← 当前" : "",
    });
  }

  if (cfg.providers.openai) {
    // OpenAI 无法列举，提供手动输入路径
    items.push({
      label: bold("openai/...") + dim("（手动输入 model ID）"),
      value: "__openai_manual__",
      note: "",
    });
  }

  if (items.length === 0) {
    console.error(red("未配置任何 provider，无法选择模型"));
    return;
  }

  console.log(`\n后端 [${bold(backendName)}] 当前模型：${cyan(String(currentSymbol))}`);
  const selected = await select(`选择新的模型 Symbol`, items);

  let newSymbol: string;
  if (selected === "__openai_manual__") {
    const input = await prompt("输入 OpenAI model ID（如 gpt-4o-mini）: ");
    const trimmed = input.trim();
    if (!trimmed) { console.log(dim("已取消")); return; }
    newSymbol = `openai/${trimmed}`;
  } else {
    newSymbol = selected;
  }

  patchTomlField(["llm", "backends", backendName], "model", JSON.stringify(newSymbol));
  console.log(`\n${green("✓")} 已将 [${backendName}] 模型更新为 ${cyan(newSymbol)}`);

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
  model show               显示各后端当前使用的模型 symbol
  model list [-a]          列出所有 provider 的可用模型
  model set  [backend]     交互式选择模型（默认后端: daily）
  model set  summarizer    切换摘要压缩模型

${bold("后端名：")}  daily | summarizer

${bold("模型 Symbol 格式：")}  provider/model-id
  示例：copilot/gpt-4o  copilot/auto  openai/gpt-4o-mini

${bold("参数：")}
  -a, --all   list 时显示全量模型（Copilot 含 picker_disabled；OpenAI 调用 /models）

${bold("Provider 配置（~/.tinyclaw/config.toml）：")}
  [providers.copilot]
  githubToken = "gh_cli"

  [providers.openai]
  apiKey  = "sk-..."
  baseUrl = "https://api.openai.com/v1"
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


