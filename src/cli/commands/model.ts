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
import { fetchFreeModels } from "../../llm/openrouter.js";
import { patchTomlField } from "../../config/writer.js";
import {
  printTable, select, confirm, prompt,
  singleSelect, searchableSelect,
  bold, dim, green, yellow, cyan, red, magenta, section,
} from "../ui.js";

type BackendName = "daily" | "code" | "summarizer";
const BACKEND_NAMES: BackendName[] = ["daily", "code", "summarizer"];

// ── 子命令实现 ────────────────────────────────────────────────────────────────

async function cmdShow(): Promise<void> {
  const cfg = loadConfig();
  section("当前模型配置");

  const rows: string[][] = [];
  for (const name of BACKEND_NAMES) {
    const role =
      name === "daily"       ? cfg.llm.backends.daily
      : name === "code"      ? cfg.llm.backends.code
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

async function listOpenRouter(apiKey: string, showAll: boolean): Promise<void> {
  if (showAll) {
    const baseUrl = "https://openrouter.ai/api/v1";
    process.stdout.write(`\n正在获取 OpenRouter 全量模型列表......`);
    try {
      const resp = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      if (!resp.ok) {
        console.log(` ${red("失败")}`);
        console.error(red(`  HTTP ${resp.status} ${resp.statusText}`));
        return;
      }
      const data = (await resp.json()) as { data?: { id: string; context_length?: number; pricing?: { prompt?: string } }[] };
      const list = data.data ?? [];
      console.log(` ${green("OK")}`);
      section(`OpenRouter 全量模型(共 ${list.length} 个)`);
      printTable(
        ["#", "Symbol", "CTX", "定价(prompt/1M)"],
        list.map((m, i) => {
          const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k` : "-";
          const price = m.pricing?.prompt != null
            ? (parseFloat(m.pricing.prompt) * 1_000_000).toFixed(2) === "0.00"
              ? green("free")
              : yellow(`$${(parseFloat(m.pricing.prompt) * 1_000_000).toFixed(2)}`)
            : "-";
          return [String(i + 1), cyan(`openrouter/${m.id}`), ctx, price];
        })
      );
    } catch (e) {
      console.log(` ${red("失败")}`);
      console.error(red(`  ${e}`));
    }
    return;
  }

  // 默认：免费榜单
  process.stdout.write(`\n正在获取 OpenRouter 免费模型榜单......`);
  try {
    const models = await fetchFreeModels(apiKey);
    console.log(` ${green("OK")}`);
    section(`OpenRouter 免费模型(top-weekly，共 ${models.length} 个)`);
    printTable(
      ["#", "Symbol", "CTX", "max_out"],
      models.map((m, i) => {
        const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k` : "-";
        const maxOut = m.top_provider?.max_completion_tokens
          ? String(m.top_provider.max_completion_tokens)
          : "-";
        return [String(i + 1), cyan(`openrouter/${m.id}`), ctx, maxOut];
      })
    );
    console.log(dim(`\n加 -a 查看全量模型`));
  } catch (e) {
    console.log(` ${red("失败")}`);
    console.error(red(`  ${e}`));
  }
}

async function cmdList(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const showAll = args.includes("--all") || args.includes("-a");

  // 支持 provider 筛选：model list [copilot|openrouter|openai] [-a]
  const filterArg = args.find((a) => ["copilot", "openrouter", "openai"].includes(a));
  const { copilot, openai, openrouter } = cfg.providers;

  if (!copilot && !openai && !openrouter) {
    console.log(red("\n未配置任何 provider，请在 config.toml 中配置 provider"));
    return;
  }

  const showCopilot = !filterArg || filterArg === "copilot";
  const showOpenRouter = !filterArg || filterArg === "openrouter";
  const showOpenAI = !filterArg || filterArg === "openai";

  if (showCopilot && copilot) {
    await listCopilot(copilot.githubToken, showAll);
  }
  if (showOpenRouter && openrouter) {
    await listOpenRouter(openrouter.apiKey, showAll);
  }
  if (showOpenAI && openai) {
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
    console.error(red(`未知后端 "${args[0]}"，可选：daily / code / summarizer`));
    console.log(dim("用法：model set [daily|code|summarizer]"));
    return;
  }

  const currentRole =
    backendName === "daily"       ? cfg.llm.backends.daily
    : backendName === "code"      ? cfg.llm.backends.code
    : cfg.llm.backends.summarizer;

  const currentSymbol = currentRole?.model ?? "(未配置)";
  console.log(`\n后端 [${bold(backendName)}] 当前模型：${cyan(currentSymbol)}`);

  // ── 第一级：选 provider ────────────────────────────────────────────────
  const { copilot, openai, openrouter } = cfg.providers;
  interface ProviderItem { label: string; value: string; note?: string }
  const providerItems: ProviderItem[] = [];
  if (copilot)     providerItems.push({ label: "Copilot",     value: "copilot",     note: "GitHub Copilot" });
  if (openrouter)  providerItems.push({ label: "OpenRouter",  value: "openrouter",  note: "免费/付费模型" });
  if (openai)      providerItems.push({ label: "OpenAI",      value: "openai",      note: "手动输入" });

  if (providerItems.length === 0) {
    console.error(red("未配置任何 provider，无法选择模型"));
    return;
  }

  const provider = await singleSelect("选择 Provider", providerItems);

  // ── 第二级：选模型 ─────────────────────────────────────────────────────
  let newSymbol: string;

  if (provider === "copilot" && copilot) {
    process.stdout.write("\n正在获取 Copilot 可用模型......");
    const models = await getCopilotModels(copilot.githubToken);
    const picker = models.filter((m) => m.isPickerEnabled);
    console.log(` ${green("OK")} (${picker.length} 个)`);

    interface PickItem { label: string; value: string; note?: string }
    const items: PickItem[] = picker.map((m) => {
      const symbol = `copilot/${m.id}`;
      return {
        label: m.isDefault ? `${m.name} ${green("(默认)")}` : m.name,
        value: symbol,
        note: [
          cyan(symbol),
          m.vendor,
          m.category ?? "",
          m.multiplier === undefined ? ""
            : m.multiplier === 0 ? green("free")
            : yellow(`×${m.multiplier}`),
          m.preview ? dim("[preview]") : "",
          currentSymbol === symbol ? magenta("← 当前") : "",
        ].filter(Boolean).join(" · "),
      };
    });
    items.push({
      label: "copilot/auto  " + dim("自动选择默认模型"),
      value: "copilot/auto",
      note: currentSymbol === "copilot/auto" ? magenta("← 当前") : "",
    });
    newSymbol = await searchableSelect("选择 Copilot 模型", items);

  } else if (provider === "openrouter" && openrouter) {
    process.stdout.write("\n正在获取 OpenRouter 免费模型榜单......");
    const freeModels = await fetchFreeModels(openrouter.apiKey);
    console.log(` ${green("OK")} (${freeModels.length} 个)`);

    interface PickItem { label: string; value: string; note?: string }
    const items: PickItem[] = [
      {
        label: "openrouter/auto-free  " + dim("自动路由免费模型"),
        value: "openrouter/auto-free",
        note: currentSymbol === "openrouter/auto-free" ? magenta("← 当前") : "",
      },
      ...freeModels.map((m) => {
        const symbol = `openrouter/${m.id}`;
        const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : "";
        const maxOut = m.top_provider?.max_completion_tokens
          ? `max_out=${m.top_provider.max_completion_tokens}`
          : "";
        return {
          label: m.id,
          value: symbol,
          note: [green("free"), ctx, maxOut, currentSymbol === symbol ? magenta("← 当前") : ""].filter(Boolean).join(" · "),
        };
      }),
      {
        label: dim("[手动输入 model ID]"),
        value: "__openrouter_manual__",
        note: "",
      },
    ];
    const picked = await searchableSelect("选择 OpenRouter 模型", items);
    if (picked === "__openrouter_manual__") {
      const input = await prompt("输入 OpenRouter model ID（如 google/gemma-3-27b-it:free）: ");
      const trimmed = input.trim();
      if (!trimmed) { console.log(dim("已取消")); return; }
      newSymbol = `openrouter/${trimmed}`;
    } else {
      newSymbol = picked;
    }

  } else if (provider === "openai" && openai) {
    const input = await prompt("输入 OpenAI model ID（如 gpt-4o-mini）: ");
    const trimmed = input.trim();
    if (!trimmed) { console.log(dim("已取消")); return; }
    newSymbol = `openai/${trimmed}`;

  } else {
    console.error(red("所选 provider 未配置"));
    return;
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

/** 第二层：只列子命令 */
function printHelp(): void {
  console.log(`
${bold("tinyclaw model")}  —  LLM 模型管理

${bold("子命令：")}
  ${cyan("show")}              显示各后端当前使用的模型 symbol
  ${cyan("list")}              列出所有 provider 的可用模型
  ${cyan("set")}               交互式选择并切换模型

${dim("运行 tinyclaw model <sub> -h 查看子命令详细参数")}
`);
}

/** 第三层：显示指定子命令的完整参数说明 */
function printSubHelp(sub: string): void {
  switch (sub) {
    case "show":
      console.log(`
${bold("tinyclaw model show")}

  显示 daily / code / summarizer 三个后端当前配置的模型 symbol。
  无需额外参数。
`);
      break;
    case "list":
      console.log(`
${bold("tinyclaw model list")} [-a]

${bold("参数：")}
  -a, --all   显示全量模型
              Copilot：含 picker_disabled 的模型
              OpenAI：调用 /models 接口枚举

${bold("说明：")}
  不加 -a 时，Copilot 仅显示 model_picker_enabled 的模型；
  OpenAI provider 仅打印提示信息。
`);
      break;
    case "set":
      console.log(`
${bold("tinyclaw model set")} [daily|code|summarizer]

${bold("参数：")}
  backend     目标后端名（默认 daily）
              可选：daily | code | summarizer

${bold("说明：")}
  交互式列出可用模型，选择后写入 ~/.tinyclaw/config.toml。
  模型 symbol 格式：provider/model-id
    示例：copilot/gpt-4o  copilot/auto  openai/gpt-4o-mini
`);
      break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const subcommands = ["show", "list", "set", "--all", "-a", "help"] as const;
export const description = "模型管理：列出 / 查看 / 切换当前 LLM 模型";
export const usage = "model <show|list|set> [backend]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const rest = args.slice(1);

  switch (sub) {
    case "show":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("show"); return; }
      return cmdShow();
    case "list":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("list"); return; }
      return cmdList(rest);
    case "set":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("set"); return; }
      return cmdSet(rest);
    case "--help":
    case "-h":
    case "help":   printHelp(); return;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}


