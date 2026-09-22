/**
 * McpWatcher 纯逻辑单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:mcp-watcher
 *
 * 覆盖"用内容哈希而不是 mtime 判断变更"这条硬要求（`AGENTS.md` §7.4：本机 mtime 不可靠），
 * 以及"哪些文件名算变更"的过滤规则（`.tmp` 中间态、`.bak-*` 备份都不算）。
 */
import assert from "node:assert/strict";
import { digestOfContent, isMcpConfigFileName, mcpTomlDigest } from "../src/mcp/watcher.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${(e as Error).message}`);
  }
}

test("isMcpConfigFileName:只认正式文件", () => {
  assert.equal(isMcpConfigFileName("mcp.toml"), true);
  assert.equal(isMcpConfigFileName("mcp.toml.tmp"), false);
  assert.equal(isMcpConfigFileName("mcp.toml.bak-20260922-235900"), false);
  assert.equal(isMcpConfigFileName("mcp.toml.bak-20260922-235900-2"), false);
  assert.equal(isMcpConfigFileName("config.toml"), false);
  assert.equal(isMcpConfigFileName("mcp.toml", "other.toml"), false);
});

test("digest:内容相同 → 哈希相同（touch 不该触发重载）", () => {
  const a = "[servers.x]\ntransport = \"stdio\"\ncommand = \"node\"\n";
  assert.equal(mcpTomlDigest(a), mcpTomlDigest(a.slice()));
});

test("digest:只改注释也视为变更（用户可能靠注释切换配置）", () => {
  const a = "[servers.x]\ncommand = \"node\"\n";
  const b = "[servers.x]\n# 改了注释\ncommand = \"node\"\n";
  assert.notEqual(mcpTomlDigest(a), mcpTomlDigest(b));
});

test("digestOfContent:文件不存在（null）保持 null，不伪造哈希", () => {
  assert.equal(digestOfContent(null), null);
  assert.equal(digestOfContent(""), mcpTomlDigest(""));
  assert.notEqual(digestOfContent(""), null);
});

test("digest:顺序不同 → 哈希不同（不会漏判等价改写）", () => {
  const a = "[servers.x]\ncommand = \"a\"\n[servers.y]\ncommand = \"b\"\n";
  const b = "[servers.y]\ncommand = \"b\"\n[servers.x]\ncommand = \"a\"\n";
  assert.notEqual(mcpTomlDigest(a), mcpTomlDigest(b));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
