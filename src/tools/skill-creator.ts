import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerTool } from "./registry.js";

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");

const SKILL_GUIDE = `# tinyclaw Skill 创建指南

## Skill 是什么

Skill 是封装了特定领域知识和工作流程的文档，注册到 Agent 后在每次对话初始化时加载到上下文。
它让 Agent 无需重新摸索就能执行特定任务。

## 目录结构

每个 Skill 是一个目录，位于：

    ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/

其中主文档文件名任意（建议 \`SKILL.md\` 或 \`README.md\`），路径在 SKILLS.md 中显式声明。

可选子目录：
- \`scripts/\`    — 可被 exec_shell 调用的脚本
- \`references/\` — 详细参考文档（篇幅较长时从主文档拆出）
- \`assets/\`     — 模板、样例文件等

## SKILL.md 格式

文件必须以 YAML frontmatter 开头（name 和 description 为必填）：

\`\`\`markdown
---
name: my-skill
description: 一句话说明此 skill 的用途（≤1024 字符，不含 < >）
---

# My Skill

...正文内容...
\`\`\`

**名称规范**：小写字母、数字、连字符，不以连字符开头/结尾，不含连续连字符，≤64 字符。

## SKILLS.md 格式

Agent 的技能目录文件位于 \`~/.tinyclaw/agents/<agent-id>/SKILLS.md\`，每行一条：

\`\`\`
- <skill-name>: <skill主文档绝对路径> — <简短描述>
\`\`\`

示例：
\`\`\`
- weather-reporter: /home/user/.tinyclaw/agents/default/skills/weather-reporter/SKILL.md — 查询并格式化天气报告
- sql-helper: /home/user/.tinyclaw/agents/default/skills/sql-helper/README.md — 生成和优化 SQL 查询
\`\`\`

## 创建步骤

### 1. 确定 agent-id

如果用户没有指定，默认使用 \`default\`。

### 2. 创建 skill 目录和主文档

使用 \`write_file\` 创建主文档。路径：

    ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/SKILL.md

示例内容（替换 TODO 部分）：

\`\`\`markdown
---
name: <skill-name>
description: <一句话描述>
---

# <Skill Title>

## 概述

<此 skill 解决什么问题，适用于什么场景>

## 工作流程

<分步骤描述如何完成任务>

## 注意事项

<容易出错的地方、前置条件、特殊情况处理>
\`\`\`

### 3. 注册到 SKILLS.md

用 \`exec_shell\` 追加一行到 \`~/.tinyclaw/agents/<agent-id>/SKILLS.md\`：

\`\`\`bash
echo "- <skill-name>: ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/SKILL.md — <描述>" >> ~/.tinyclaw/agents/<agent-id>/SKILLS.md
\`\`\`

若文件不存在则先创建：

\`\`\`bash
touch ~/.tinyclaw/agents/<agent-id>/SKILLS.md
\`\`\`

### 4. 验证

\`\`\`bash
cat ~/.tinyclaw/agents/<agent-id>/SKILLS.md
cat ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/SKILL.md
\`\`\`

确认目录已创建：

\`\`\`bash
ls ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/
\`\`\`

## 设计原则

- **简洁优先**：上下文窗口是有限资源，只写 Agent 真正需要的信息，不写 Agent 本身已知的通识
- **自包含**：Skill 文档要让 Agent 无需外部上下文就能执行任务
- **自由度匹配任务**：操作易出错时用精确步骤；方案多样时用高层指导
- **不过度设计**：不是所有任务都需要 Skill，简单的一次性任务直接交给 Agent 即可
`;

function buildGuide(agentId: string): string {
  const skillsPath = path.join(AGENTS_ROOT, agentId, "SKILLS.md");
  const skillsDir = path.join(AGENTS_ROOT, agentId, "skills");

  let existingSkills = "";
  if (fs.existsSync(skillsPath)) {
    const content = fs.readFileSync(skillsPath, "utf-8").trim();
    if (content.length > 0) {
      existingSkills = `\n\n## 当前已注册的 Skills（agent: ${agentId}）\n\n${content}`;
    }
  } else {
    existingSkills = `\n\n## 当前已注册的 Skills（agent: ${agentId}）\n\n（暂无，SKILLS.md 不存在）`;
  }

  const note = `\n\n## 路径参考（agent: ${agentId}）\n\n- SKILLS.md：\`${skillsPath}\`\n- skills 目录：\`${skillsDir}\``;

  return SKILL_GUIDE + note + existingSkills;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "create_skill",
      description:
        "获取 tinyclaw Skill 创建指南。调用后按照指南使用 write_file 和 exec_shell 完成 skill 创建和注册。",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description:
              "要在哪个 Agent 下创建 skill，默认为 \"default\"。",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const agentId = typeof args["agent_id"] === "string" && args["agent_id"].trim()
      ? args["agent_id"].trim()
      : "default";
    return buildGuide(agentId);
  },
});
