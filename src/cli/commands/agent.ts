/**
 * tinyclaw agent — 管理 Agent 工作区
 *
 * 用法：
 *   agent list                  列出所有 Agent
 *   agent new <id>              创建新 Agent
 *   agent show <id>             显示 Agent 详情
 *   agent edit <id>             用 $EDITOR 编辑系统提示（SYSTEM.md）
 *   agent delete <id>           删除 Agent（default 不可删除）
 *   agent repair [id|--all]     补全缺失目录和配置文件
 *   agent mcp <id> [set|clear]  管理 MCP server 白名单
 *   agent tools <id> [set-allow|set-deny|clear]  管理内置工具黑/白名单
 *   agent perm <id>             交互式权限配置向导（工具 + MCP）
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bold, dim, green, red, cyan, yellow, printTable, singleSelect, multiSelect } from "../ui.js";
import { AgentManager } from "../../core/agent-manager.js";
import { stringify } from "smol-toml";

export const description = "管理 Agent 工作区（独立人格与记忆命名空间）";
export const usage = "agent <list|new|show|edit|delete|repair|mcp|tools|perm> [id|--all]";

// ── 所有内置工具名（静态枚举，与 src/tools/ 下注册的工具同步） ──────────────

export const BUILTIN_TOOLS = [
  "exec_shell",
  "write_file",
  "edit_file",
  "read_file",
  "delete_file",
  "cron_add",
  "cron_list",
  "cron_remove",
  "cron_enable",
  "cron_disable",
  "cron_run",
  "agent_fork",
  "agent_status",
  "agent_wait",
  "agent_abort",
  "notify_user",
  "send_report",
  "render_diagram",
  "search_store",
  "code_assist",
  "create_skill",
  "mcp_list_servers",
  "mcp_enable_server",
  "mcp_disable_server",
  "ask_user",
  "exit_plan_mode",
] as const;

// ── 模板 ─────────────────────────────────────────────────────────────────────

const SAMPLE_MEM = `# 持久记忆

<!-- 这里记录用户偏好、重要结论、待办事项等跨 session 信息 -->
<!-- agent 可直接用 write_file 更新本文件 -->
`;

const SAMPLE_SKILLS = `# 技能目录

<!-- 格式示例：
## skill-name
- 介绍/文档: skills/skill-name/README.md
- 工作目录: /relevant/path/
- 使用场景: 什么时候需要这个技能
-->
`;

const SAMPLE_SYSTEM = (id: string) =>
  `# ${id} 系统提示

在此描述该 Agent 的角色、风格和专业方向。
`;

// ── 帮助 ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("用法：")}
  agent list                       列出所有 Agent
  agent new <id>                   创建新 Agent
  agent show <id>                  显示 Agent 详情（含权限配置）
  agent edit <id>                  用 $EDITOR 编辑系统提示（SYSTEM.md）
  agent delete <id>                删除 Agent（default 不可删除）
  agent repair [id|--all]          补全缺失目录和配置文件

  agent mcp <id>                   查看 MCP server 白名单
  agent mcp <id> set <s...>        设置 MCP 白名单（覆盖写入 mcp.toml）
  agent mcp <id> clear             清除白名单（删除 mcp.toml，恢复全量访问）

  agent tools <id>                 查看内置工具黑/白名单
  agent tools <id> set-allow <t...> 设置工具白名单（allowlist 模式）
  agent tools <id> set-deny  <t...> 设置工具黑名单（denylist 模式）
  agent tools <id> clear           清除限制（删除 tools.toml）

  agent perm <id>                  ${cyan("★")} 交互式权限配置向导（工具 + MCP）

${bold("说明：")}
  每个 Agent 是独立工作区 ${dim("~/.tinyclaw/agents/<id>/")}
    ${dim("agent.toml")}       — 元数据与绑定规则
    ${dim("SYSTEM.md")}        — 自定义系统提示（可选）
    ${dim("MEM.md")}           — 持久记忆（跨 session）
    ${dim("SKILLS.md")}        — 技能目录
    ${dim("mcp.toml")}         — MCP server 白名单（可选，缺失则不限制）
    ${dim("tools.toml")}       — 内置工具黑/白名单（可选，缺失则不限制）
    ${dim("memory/")}          — 独立向量记忆
    ${dim("workspace/")}       — 工作区根目录

  将终端会话绑定到 Agent：
    tinyclaw chat -s <sessionId> bind <agentId>

${bold("示例：")}
  agent perm loop-01               # 交互式配置 loop-01 的工具和 MCP 权限
  agent tools loop-01 set-deny exec_shell write_file delete_file
  agent mcp trader set polymarket browser
`);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const mgr = new AgentManager();
  const sub = args[0];

  switch (sub) {
    case "list":   return runList(mgr);
    case "new":    return runNew(mgr, args[1]);
    case "show":   return runShow(mgr, args[1]);
    case "edit":   return runEdit(mgr, args[1]);
    case "delete": return runDelete(mgr, args[1]);
    case "repair": return runRepair(mgr, args[1]);
    case "mcp":    return runMcp(mgr, args.slice(1));
    case "tools":  return runTools(mgr, args.slice(1));
    case "perm":   return runPerm(mgr, args[1]);
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
      process.exit(1);
  }
}

// ── list ─────────────────────────────────────────────────────────────────────

function runList(mgr: AgentManager): void {
  const agents = mgr.loadAll();
  if (agents.length === 0) {
    console.log(dim("暂无 Agent，使用 tinyclaw agent new <id> 创建"));
    return;
  }
  const rows = agents.map((a) => {
    const hasPrompt = existsSync(mgr.systemPromptPath(a.id));
    const bindings = a.bindings.length > 0
      ? a.bindings.map((b) => b.source).join(", ")
      : dim("—");

    const mcpCfg = mgr.readMcpServers(a.id);
    const mcpStr = mcpCfg === null
      ? dim("不限制")
      : mcpCfg.length === 0
        ? red("全禁用")
        : cyan(mcpCfg.join(", "));

    const toolsCfg = mgr.readToolsConfig(a.id);
    const toolsStr = toolsCfg === null
      ? dim("不限制")
      : toolsCfg.mode === "allowlist"
        ? green(`白名单(${toolsCfg.tools.length})`)
        : yellow(`黑名单(${toolsCfg.tools.length})`);

    return [
      a.id === "default" ? cyan(a.id) + dim(" (default)") : cyan(a.id),
      hasPrompt ? green("✓") : dim("—"),
      String(a.bindings.length),
      bindings,
      mcpStr,
      toolsStr,
    ];
  });
  printTable(["ID", "SYSTEM.md", "绑定数", "绑定来源", "MCP", "工具限制"], rows);
}

// ── new ──────────────────────────────────────────────────────────────────────

function runNew(mgr: AgentManager, id: string | undefined): void {
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    console.error(dim("用法：tinyclaw agent new <id>"));
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    console.error(red("错误：Agent ID 只能包含字母、数字、下划线和连字符"));
    process.exit(1);
  }
  try {
    mgr.load(id);
    console.error(red(`错误：Agent "${id}" 已存在`));
    process.exit(1);
  } catch { /* expected */ }

  mgr.save({ id, createdAt: new Date().toISOString(), bindings: [] });
  console.log(green(`✓ Agent "${id}" 已创建`));
  console.log(dim(`  工作区：  ${mgr.agentDir(id)}`));
  console.log(dim(`  设置提示：tinyclaw agent edit ${id}`));
  console.log(dim(`  配置权限：tinyclaw agent perm ${id}`));
}

// ── show ─────────────────────────────────────────────────────────────────────

function runShow(mgr: AgentManager, id: string | undefined): void {
  if (!id) { console.error(red("错误：请指定 Agent ID")); process.exit(1); }
  let def;
  try { def = mgr.load(id); } catch {
    console.error(red(`错误：Agent "${id}" 不存在`)); process.exit(1);
  }
  console.log(`\n${bold("Agent: " + id)}`);
  console.log(dim("─".repeat(44)));
  console.log(`  创建时间：${dim(def.createdAt)}`);
  console.log(`  工作区：  ${dim(mgr.agentDir(id))}`);

  const agentPrompt = mgr.readSystemPrompt(id);
  if (agentPrompt) {
    console.log(`\n${bold("SYSTEM.md（前 10 行）：")}`);
    const lines = agentPrompt.split("\n").slice(0, 10);
    for (const line of lines) console.log(`  ${dim(line)}`);
    if (agentPrompt.split("\n").length > 10) console.log(dim("  ...（更多内容）"));
  } else {
    console.log(dim("\n  SYSTEM.md：（未设置）"));
  }

  if (def.bindings.length > 0) {
    console.log(`\n${bold("绑定来源：")}`);
    for (const b of def.bindings) console.log(`  ${cyan("•")} ${b.source}`);
  } else {
    console.log(dim("\n  绑定来源：（无）"));
  }

  // 内置工具限制
  const toolsCfg = mgr.readToolsConfig(id);
  console.log(`\n${bold("内置工具权限：")}`);
  if (toolsCfg === null) {
    console.log(`  ${dim("不限制（无 tools.toml，可使用所有工具）")}`);
    console.log(dim(`  配置：tinyclaw agent perm ${id}`));
  } else if (toolsCfg.mode === "allowlist") {
    console.log(`  ${green("白名单模式")}（只允许以下工具）`);
    for (const t of toolsCfg.tools) console.log(`    ${green("•")} ${t}`);
    console.log(dim(`  路径：${mgr.agentToolsPath(id)}`));
  } else {
    console.log(`  ${yellow("黑名单模式")}（禁止以下工具）`);
    for (const t of toolsCfg.tools) console.log(`    ${yellow("•")} ${t}`);
    console.log(dim(`  路径：${mgr.agentToolsPath(id)}`));
  }

  // MCP 白名单
  const mcpCfg = mgr.readMcpServers(id);
  console.log(`\n${bold("MCP 访问权限：")}`);
  if (mcpCfg === null) {
    console.log(`  ${dim("不限制（无 mcp.toml，可访问所有已配置的 server）")}`);
    console.log(dim(`  配置：tinyclaw agent mcp ${id} set <server1> ...`));
  } else if (mcpCfg.length === 0) {
    console.log(`  ${red("全部禁用")} ${dim("（mcp.toml 存在但 servers 为空）")}`);
  } else {
    console.log(`  ${green("白名单模式")}（只允许以下 server）`);
    for (const s of mcpCfg) console.log(`    ${cyan("•")} ${s}`);
    console.log(dim(`  路径：${mgr.agentMcpPath(id)}`));
  }
  console.log();
}

// ── edit ─────────────────────────────────────────────────────────────────────

function runEdit(mgr: AgentManager, id: string | undefined): void {
  if (!id) { console.error(red("错误：请指定 Agent ID")); process.exit(1); }
  try { mgr.load(id); } catch {
    console.error(red(`错误：Agent "${id}" 不存在`)); process.exit(1);
  }
  const systemPath = mgr.systemPromptPath(id);
  if (!existsSync(systemPath)) {
    writeFileSync(systemPath, `# ${id} 系统提示\n\n在此描述该 Agent 的角色、风格和专业方向。\n`, "utf-8");
  }
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "nano";
  const result = spawnSync(editor, [systemPath], { stdio: "inherit" });
  if (result.error) {
    console.error(red(`无法启动编辑器 "${editor}"：${result.error.message}`));
    console.log(dim(`请手动编辑：${systemPath}`));
    process.exit(1);
  }
  console.log(green(`✓ "${id}" 的系统提示已保存`));
}

// ── delete ───────────────────────────────────────────────────────────────────

function runDelete(mgr: AgentManager, id: string | undefined): void {
  if (!id) { console.error(red("错误：请指定 Agent ID")); process.exit(1); }
  try {
    mgr.delete(id);
    console.log(green(`✓ Agent "${id}" 已删除`));
  } catch (e) {
    console.error(red(`错误：${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

// ── repair ───────────────────────────────────────────────────────────────────

function repairOne(mgr: AgentManager, id: string): void {
  const dirs = [
    mgr.memoryDir(id),
    mgr.skillsDir(id),
    mgr.workspaceDir(id),
    mgr.workspaceDir(id) + "/tmp",
    mgr.workspaceDir(id) + "/output",
  ];
  let createdDirs = 0;
  for (const d of dirs) {
    if (!existsSync(d)) { mkdirSync(d, { recursive: true }); createdDirs++; }
  }
  let createdFiles = 0;
  const templates: Array<[string, string]> = [
    [mgr.systemPromptPath(id), SAMPLE_SYSTEM(id)],
    [mgr.memPath(id), SAMPLE_MEM],
    [mgr.skillsPath(id), SAMPLE_SKILLS],
  ];
  for (const [p, content] of templates) {
    if (!existsSync(p)) { writeFileSync(p, content, "utf-8"); createdFiles++; }
  }
  const summary: string[] = [];
  if (createdDirs > 0) summary.push(`${createdDirs} 个目录`);
  if (createdFiles > 0) summary.push(`${createdFiles} 个模板文件`);
  if (summary.length > 0) {
    console.log(green(`✓ [${id}] 已补全：`) + dim(summary.join("、")));
  } else {
    console.log(dim(`  [${id}] 已是最新，无需补全`));
  }
}

function runRepair(mgr: AgentManager, target: string | undefined): void {
  if (!target || target === "--all") {
    const agents = mgr.loadAll();
    if (agents.length === 0) { console.log(dim("暂无 Agent")); return; }
    for (const a of agents) repairOne(mgr, a.id);
  } else {
    try { mgr.load(target); } catch {
      console.error(red(`错误：Agent "${target}" 不存在`)); process.exit(1);
    }
    repairOne(mgr, target);
  }
}

// ── mcp ──────────────────────────────────────────────────────────────────────

function runMcp(mgr: AgentManager, args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    console.error(dim("用法：agent mcp <id> [set <server...> | clear]"));
    process.exit(1);
  }
  try { mgr.load(id); } catch {
    console.error(red(`错误：Agent "${id}" 不存在`)); process.exit(1);
  }

  const sub = args[1];

  if (!sub || sub === "show") {
    const allowed = mgr.readMcpServers(id);
    console.log(`\n${bold(`Agent "${id}" 的 MCP 访问权限`)}`);
    if (allowed === null) {
      console.log(`  ${dim("不限制（mcp.toml 不存在，可访问所有 server）")}`);
    } else if (allowed.length === 0) {
      console.log(`  ${red("全部禁用")}（servers = []）`);
    } else {
      for (const s of allowed) console.log(`    ${cyan("•")} ${s}`);
    }
    console.log(dim(`  路径：${mgr.agentMcpPath(id)}`));
    console.log();
    return;
  }

  if (sub === "clear") {
    const p = mgr.agentMcpPath(id);
    if (!existsSync(p)) {
      console.log(dim(`Agent "${id}" 没有 mcp.toml，已是全量访问状态。`));
      return;
    }
    unlinkSync(p);
    console.log(green(`✓ Agent "${id}" 的 MCP 白名单已清除`));
    return;
  }

  if (sub === "set") {
    const servers = args.slice(2).filter(Boolean);
    const content = stringify({ servers } as Record<string, unknown>);
    writeFileSync(
      mgr.agentMcpPath(id),
      `# MCP server 白名单 — Agent: ${id}\n# 只有列出的 server 才对此 agent 可见；删除此文件则不限制。\n\n${content}`,
      "utf-8",
    );
    console.log(servers.length === 0
      ? green(`✓ Agent "${id}" MCP 白名单已设为空（禁用所有 server）`)
      : green(`✓ Agent "${id}" MCP 白名单：[${servers.join(", ")}]`));
    return;
  }

  console.error(red(`未知子命令 "${sub}"，可用：show / set / clear`));
  process.exit(1);
}

// ── tools ────────────────────────────────────────────────────────────────────

function runTools(mgr: AgentManager, args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    console.error(dim("用法：agent tools <id> [set-allow|set-deny <tools...> | clear]"));
    process.exit(1);
  }
  try { mgr.load(id); } catch {
    console.error(red(`错误：Agent "${id}" 不存在`)); process.exit(1);
  }

  const sub = args[1];

  if (!sub || sub === "show") {
    const cfg = mgr.readToolsConfig(id);
    console.log(`\n${bold(`Agent "${id}" 的内置工具权限`)}`);
    if (cfg === null) {
      console.log(`  ${dim("不限制（tools.toml 不存在，可使用所有工具）")}`);
    } else if (cfg.mode === "allowlist") {
      console.log(`  ${green("白名单模式")}（只允许以下工具）：`);
      for (const t of cfg.tools) console.log(`    ${green("•")} ${t}`);
    } else {
      console.log(`  ${yellow("黑名单模式")}（禁止以下工具）：`);
      for (const t of cfg.tools) console.log(`    ${yellow("•")} ${t}`);
    }
    console.log(dim(`  路径：${mgr.agentToolsPath(id)}`));
    console.log();
    return;
  }

  if (sub === "clear") {
    const p = mgr.agentToolsPath(id);
    if (!existsSync(p)) {
      console.log(dim(`Agent "${id}" 没有 tools.toml，已是不限制状态。`));
      return;
    }
    unlinkSync(p);
    console.log(green(`✓ Agent "${id}" 的工具限制已清除`));
    return;
  }

  if (sub === "set-allow" || sub === "set-deny") {
    const mode = sub === "set-allow" ? "allowlist" : "denylist";
    const tools = args.slice(2).filter(Boolean);
    writeToolsToml(mgr, id, mode, tools);
    console.log(green(`✓ Agent "${id}" 工具${mode === "allowlist" ? "白" : "黑"}名单已更新：[${tools.join(", ")}]`));
    return;
  }

  console.error(red(`未知子命令 "${sub}"，可用：show / set-allow / set-deny / clear`));
  process.exit(1);
}

/** 写入 tools.toml */
function writeToolsToml(mgr: AgentManager, id: string, mode: "allowlist" | "denylist", tools: string[]): void {
  const content = stringify({ mode, tools } as Record<string, unknown>);
  writeFileSync(
    mgr.agentToolsPath(id),
    `# 内置工具${mode === "allowlist" ? "白" : "黑"}名单 — Agent: ${id}\n# mode = "allowlist"（只允许）或 "denylist"（禁止）\n# MCP 工具(mcp_*)不受此影响，由 mcp.toml 控制。\n\n${content}`,
    "utf-8",
  );
}

/** 写入 mcp.toml */
function writeMcpToml(mgr: AgentManager, id: string, servers: string[]): void {
  const content = stringify({ servers } as Record<string, unknown>);
  writeFileSync(
    mgr.agentMcpPath(id),
    `# MCP server 白名单 — Agent: ${id}\n# 只有列出的 server 才对此 agent 可见；删除此文件则不限制。\n\n${content}`,
    "utf-8",
  );
}

// ── perm（交互式向导）────────────────────────────────────────────────────────

async function runPerm(mgr: AgentManager, id: string | undefined): Promise<void> {
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    console.error(dim("用法：agent perm <id>"));
    process.exit(1);
  }
  try { mgr.load(id); } catch {
    console.error(red(`错误：Agent "${id}" 不存在`)); process.exit(1);
  }

  console.log(`\n${bold(`Agent "${id}" 权限配置向导`)}`);
  console.log(dim("─".repeat(44)));

  // ── Step 1：内置工具模式 ────────────────────────────────────────────
  const currentTools = mgr.readToolsConfig(id);
  const currentToolsDesc = currentTools === null
    ? dim("当前：不限制")
    : currentTools.mode === "allowlist"
      ? green(`当前：白名单 [${currentTools.tools.join(", ")}]`)
      : yellow(`当前：黑名单 [${currentTools.tools.join(", ")}]`);

  console.log(`\n${bold("── 内置工具限制 ──────────────────────────────────")}`);
  console.log(`  ${currentToolsDesc}`);

  type ToolMode = "none" | "allowlist" | "denylist" | "keep";
  const toolMode = await singleSelect<ToolMode>("选择工具限制模式", [
    { label: "不限制", value: "none", note: "删除 tools.toml，允许所有工具" },
    { label: "白名单 —— 只允许勾选的工具", value: "allowlist" },
    { label: "黑名单 —— 禁止勾选的工具", value: "denylist" },
    { label: "保持不变", value: "keep" },
  ]);

  let finalTools: string[] | null = null; // null = 不写入
  if (toolMode === "allowlist" || toolMode === "denylist") {
    const initial = currentTools?.tools ?? [];
    const toolItems = BUILTIN_TOOLS.map((t) => ({ value: t }));
    const modeLabel = toolMode === "allowlist" ? "白名单（勾选允许的工具）" : "黑名单（勾选禁止的工具）";
    finalTools = await multiSelect(modeLabel, toolItems, initial);
  }

  // ── Step 2：MCP servers ─────────────────────────────────────────────
  const currentMcp = mgr.readMcpServers(id);
  const currentMcpDesc = currentMcp === null
    ? dim("当前：不限制")
    : currentMcp.length === 0
      ? red("当前：全禁用")
      : cyan(`当前：白名单 [${currentMcp.join(", ")}]`);

  console.log(`\n${bold("── MCP Server 权限 ────────────────────────────────")}`);
  console.log(`  ${currentMcpDesc}`);

  // 读取全局 mcp.toml 里配置的 server 列表（供勾选）
  let knownServers: string[] = [];
  try {
    const { loadMcpConfig } = await import("../../config/loader.js");
    const mcpCfg = loadMcpConfig();
    knownServers = Object.keys(mcpCfg.servers);
  } catch { /* 无 MCP 配置时忽略 */ }

  type McpMode = "none" | "allowlist" | "keep";
  const mcpMode = await singleSelect<McpMode>("选择 MCP 访问模式", [
    { label: "不限制", value: "none", note: "删除 mcp.toml，允许所有 server" },
    {
      label: "白名单 —— 只允许勾选的 server",
      value: "allowlist",
      note: knownServers.length === 0 ? dim("（当前无已配置 server）") : "",
    },
    { label: "保持不变", value: "keep" },
  ]);

  let finalServers: string[] | null = null;
  if (mcpMode === "allowlist") {
    if (knownServers.length === 0) {
      console.log(yellow("  ⚠ 当前没有已配置的 MCP server，白名单将为空。"));
      finalServers = [];
    } else {
      const initial = currentMcp ?? [];
      const serverItems = knownServers.map((s) => ({ value: s }));
      finalServers = await multiSelect("MCP 白名单（勾选允许的 server）", serverItems, initial);
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────
  console.log(`\n${bold("── 应用配置 ────────────────────────────────────────")}`);

  if (toolMode === "none") {
    const p = mgr.agentToolsPath(id);
    if (existsSync(p)) { unlinkSync(p); console.log(green("  ✓ tools.toml 已删除（不限制）")); }
    else console.log(dim("  ─ tools.toml 本就不存在，无需操作"));
  } else if (toolMode === "allowlist" || toolMode === "denylist") {
    writeToolsToml(mgr, id, toolMode, finalTools!);
    console.log(green(`  ✓ tools.toml 已写入：${toolMode} [${finalTools!.join(", ")}]`));
  } else {
    console.log(dim("  ─ 工具配置：保持不变"));
  }

  if (mcpMode === "none") {
    const p = mgr.agentMcpPath(id);
    if (existsSync(p)) { unlinkSync(p); console.log(green("  ✓ mcp.toml 已删除（不限制）")); }
    else console.log(dim("  ─ mcp.toml 本就不存在，无需操作"));
  } else if (mcpMode === "allowlist") {
    writeMcpToml(mgr, id, finalServers!);
    console.log(green(`  ✓ mcp.toml 已写入：allowlist [${finalServers!.join(", ")}]`));
  } else {
    console.log(dim("  ─ MCP 配置：保持不变"));
  }

  console.log(dim(`\n  运行 tinyclaw agent show ${id} 查看完整权限配置`));
  console.log();
}
