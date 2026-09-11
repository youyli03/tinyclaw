import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerTool } from "./registry.js";

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");

const SKILL_GUIDE = `# tinyclaw Skill Authoring Guide

## What a Skill is

A Skill is a document that packages domain knowledge and a workflow. Once registered to an Agent
it is loaded into context every time a conversation is initialized, so the Agent can perform that
task without exploring from scratch.

## Directory layout

Each Skill is a directory rooted at:

    ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/

The main document may use any file name (\`SKILL.md\` or \`README.md\` are recommended); its path is
declared explicitly in SKILLS.md.

Optional subdirectories:
- \`scripts/\`    — scripts that can be invoked through exec_shell
- \`references/\` — long-form reference material split out of the main document
- \`assets/\`     — templates, sample files, and similar

## SKILL.md format

The file must start with YAML frontmatter (\`name\` and \`description\` are required):

\`\`\`markdown
---
name: my-skill
description: One sentence describing what this skill is for (<=1024 chars, no < >)
---

# My Skill

...body content...
\`\`\`

**Naming rules**: lowercase letters, digits and hyphens only; must not start or end with a hyphen;
no consecutive hyphens; <=64 characters.

## SKILLS.md format

The Agent's skill registry lives at \`~/.tinyclaw/agents/<agent-id>/SKILLS.md\`, one entry per line:

\`\`\`
- <skill-name>: <absolute path to the skill main document> — <short description>
\`\`\`

Example:
\`\`\`
- weather-reporter: /home/user/.tinyclaw/agents/default/skills/weather-reporter/SKILL.md — 查询并格式化天气报告
- sql-helper: /home/user/.tinyclaw/agents/default/skills/sql-helper/README.md — 生成和优化 SQL 查询
\`\`\`

The text after the em dash is the description shown to the user in the registry — keep it in the
user's language.

## Creation steps

### 1. Determine the agent-id

If the user did not specify one, use \`default\`.

### 2. Create the skill directory and main document

Use \`write_file\` to create the main document at:

    ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/SKILL.md

Sample content (replace every TODO / placeholder):

\`\`\`markdown
---
name: <skill-name>
description: <one-sentence description, in the user's language>
---

# <Skill Title>

## 概述

<此 skill 解决什么问题，适用于什么场景>

## 工作流程

<分步骤描述如何完成任务>

## 注意事项

<容易出错的地方、前置条件、特殊情况处理>
\`\`\`

⚠️ Write the whole skill document in the user's language (the headings above are Chinese because
this sample targets a Chinese user; translate them when the user speaks another language).
The frontmatter keys \`name\` and \`description\` stay byte-identical. Replace the \`<...>\` markers
with real content — never leave literal placeholders such as \`<...>\` in the written file.

### 3. Register it in SKILLS.md

Append one line to \`~/.tinyclaw/agents/<agent-id>/SKILLS.md\` with \`exec_shell\`:

\`\`\`bash
echo "- <skill-name>: ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/SKILL.md — <description>" >> ~/.tinyclaw/agents/<agent-id>/SKILLS.md
\`\`\`

Create the file first if it does not exist:

\`\`\`bash
touch ~/.tinyclaw/agents/<agent-id>/SKILLS.md
\`\`\`

### 4. Verify

\`\`\`bash
cat ~/.tinyclaw/agents/<agent-id>/SKILLS.md
cat ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/SKILL.md
\`\`\`

Confirm the directory was created:

\`\`\`bash
ls ~/.tinyclaw/agents/<agent-id>/skills/<skill-name>/
\`\`\`

## Design principles

- **Brevity first**: the context window is a scarce resource — write only what the Agent genuinely
  needs, and skip general knowledge the Agent already has
- **Self-contained**: the document must let the Agent finish the task with no external context
- **Match the freedom level to the task**: use exact steps when an operation is error-prone, and
  high-level guidance when several approaches are valid
- **No over-design**: not every task needs a Skill; simple one-off work can go straight to the Agent
`;

function buildGuide(agentId: string): string {
  const skillsPath = path.join(AGENTS_ROOT, agentId, "SKILLS.md");
  const skillsDir = path.join(AGENTS_ROOT, agentId, "skills");

  let existingSkills = "";
  if (fs.existsSync(skillsPath)) {
    const content = fs.readFileSync(skillsPath, "utf-8").trim();
    if (content.length > 0) {
      existingSkills = `\n\n## Currently registered Skills (agent: ${agentId})\n\n${content}`;
    }
  } else {
    existingSkills =
      `\n\n## Currently registered Skills (agent: ${agentId})` +
      `\n\n(none yet, no SKILLS.md)`;
  }

  const note =
    `\n\n## Path reference (agent: ${agentId})` +
    `\n\n- SKILLS.md: \`${skillsPath}\`\n- skills dir: \`${skillsDir}\``;

  return SKILL_GUIDE + note + existingSkills;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "create_skill",
      description: "Get the Skill creation guide (including the target agent's registered skills)",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: 'Target agent, defaults to "default"',
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const agentId =
      typeof args["agent_id"] === "string" && args["agent_id"].trim()
        ? args["agent_id"].trim()
        : "default";
    return buildGuide(agentId);
  },
});
