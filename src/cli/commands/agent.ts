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
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bold, dim, green, red, cyan, printTable } from "../ui.js";
import { AgentManager } from "../../core/agent-manager.js";

export const description = "管理 Agent 工作区（独立人格与记忆命名空间）";
export const usage = "agent <list|new|show|edit|delete|repair> [id|--all]";

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

function printHelp(): void {
  console.log(`
${bold("用法：")}
  agent list                  列出所有 Agent
  agent new <id>              创建新 Agent
  agent show <id>             显示 Agent 详情
  agent edit <id>             用 $EDITOR 编辑系统提示（SYSTEM.md）
  agent delete <id>           删除 Agent（default 不可删除）
  agent repair [id|--all]     补全缺失目录和配置文件

${bold("说明：")}
  每个 Agent 是独立工作区 ${dim("~/.tinyclaw/agents/<id>/")}
    ${dim("agent.toml")}      — 元数据与绑定规则
    ${dim("SYSTEM.md")}       — 自定义系统提示（可选，叠加在全局 SYSTEM.md 之上）
    ${dim("MEM.md")}          — 持久记忆（跨 session 偏好和结论）
    ${dim("SKILLS.md")}       — 技能目录（工具/脚本使用说明）
    ${dim("memory/")}         — 独立向量记忆与压缩摘要
    ${dim("skills/")}         — 技能脚本目录
    ${dim("workspace/")}      — 工作区根目录（exec_shell 默认 cwd）
    ${dim("workspace/tmp/")}  — 临时文件
    ${dim("workspace/output/")} — 输出文件

  将终端会话绑定到 Agent：
    tinyclaw chat -s <sessionId> bind <agentId>

  repair 用于补全旧版 Agent 缺失的新目录和模板文件，幂等操作。
`);
}

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
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
      process.exit(1);
  }
}

function runList(mgr: AgentManager): void {
  const agents = mgr.loadAll();
  if (agents.length === 0) {
    console.log(dim("暂无 Agent，使用 tinyclaw agent new <id> 创建"));
    return;
  }
  const rows = agents.map((a) => {
    const hasPrompt = existsSync(mgr.systemPromptPath(a.id));
    const bindings =
      a.bindings.length > 0
        ? a.bindings.map((b) => b.source).join(", ")
        : dim("—");
    return [
      a.id === "default" ? cyan(a.id) + dim(" (default)") : cyan(a.id),
      hasPrompt ? green("✓") : dim("—"),
      String(a.bindings.length),
      bindings,
    ];
  });
  printTable(["ID", "SYSTEM.md", "绑定数", "绑定来源"], rows);
}

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
  } catch { /* expected - not found, proceed */ }

  mgr.save({ id, createdAt: new Date().toISOString(), bindings: [] });
  console.log(green(`✓ Agent "${id}" 已创建`));
  console.log(dim(`  工作区：  ${mgr.agentDir(id)}`));
  console.log(dim(`  设置提示：tinyclaw agent edit ${id}`));
}

function runShow(mgr: AgentManager, id: string | undefined): void {
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    process.exit(1);
  }
  let def;
  try {
    def = mgr.load(id);
  } catch {
    console.error(red(`错误：Agent "${id}" 不存在`));
    process.exit(1);
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
  console.log();
}

function runEdit(mgr: AgentManager, id: string | undefined): void {
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    process.exit(1);
  }
  try {
    mgr.load(id);
  } catch {
    console.error(red(`错误：Agent "${id}" 不存在`));
    process.exit(1);
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

function runDelete(mgr: AgentManager, id: string | undefined): void {
  if (!id) {
    console.error(red("错误：请指定 Agent ID"));
    process.exit(1);
  }
  try {
    mgr.delete(id);
    console.log(green(`✓ Agent "${id}" 已删除`));
  } catch (e) {
    console.error(red(`错误：${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

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
      console.error(red(`错误：Agent "${target}" 不存在`));
      process.exit(1);
    }
    repairOne(mgr, target);
  }
}
