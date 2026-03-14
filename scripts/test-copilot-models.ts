/**
 * 快速测试脚本：验证 Copilot token 换取和模型列表获取
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx bun run scripts/test-copilot-models.ts
 * 或：
 *   bun run scripts/test-copilot-models.ts <github_token>
 */

import { getCopilotToken, getCopilotModels } from "../src/llm/copilot.js";

const tokenSource = process.argv[2] ?? "env";

console.log("=".repeat(60));
console.log("Copilot 模型发现测试");
console.log("token source:", tokenSource);
console.log("=".repeat(60));

// 1. 换取 Copilot token
console.log("\n[1/2] 换取 Copilot token...");
let copilotToken: string;
try {
  copilotToken = await getCopilotToken(tokenSource);
  console.log("✓ Token 获取成功：" + copilotToken.substring(0, 12) + "...");
} catch (e) {
  console.error("✗ Token 获取失败：", e);
  process.exit(1);
}

// 2. 获取模型列表
console.log("\n[2/2] 获取模型列表...");
let models;
try {
  models = await getCopilotModels(tokenSource);
} catch (e) {
  console.error("✗ 模型列表获取失败：", e);
  process.exit(1);
}

console.log(`✓ 共获取到 ${models.length} 个模型\n`);

// 3. 输出表格
const defaultModel = models.find((m) => m.isDefault);
console.log(`默认模型：${defaultModel?.id ?? "(无)"}\n`);

// 标题行
const cols = {
  id: 36,
  maxOut: 12,
  maxCtx: 14,
  tools: 8,
  picker: 8,
  default: 9,
};
const header =
  "模型 ID".padEnd(cols.id) +
  "maxOutput".padEnd(cols.maxOut) +
  "contextWindow".padEnd(cols.maxCtx) +
  "tools".padEnd(cols.tools) +
  "picker".padEnd(cols.picker) +
  "default";
console.log(header);
console.log("-".repeat(header.length));

for (const m of models) {
  console.log(
    m.id.padEnd(cols.id) +
      String(m.maxOutputTokens).padEnd(cols.maxOut) +
      String(m.maxContextWindow).padEnd(cols.maxCtx) +
      (m.supportsToolCalls ? "yes" : "no").padEnd(cols.tools) +
      (m.isPickerEnabled ? "yes" : "no").padEnd(cols.picker) +
      (m.isDefault ? "★" : "")
  );
}

console.log("\n" + "=".repeat(60));
console.log("测试完成");
