/**
 * MCP 配置写入器 + `${SECRET:NAME}` 解析单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:mcp-writer
 *
 * 重点：
 * 1. 块级补丁不破坏用户手写内容（注释、未知键、其它 server 块）
 * 2. 写前校验拦得住坏内容（坏内容永不落盘）
 * 3. 原子写 + 备份 + 备份份数上限
 * 4. `${SECRET:NAME}` 只在连接时解析；缺失引用要能被诊断出来
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeMcpTomlText } from "../src/config/loader.js";
import { checkSecretRefs, isSecretRef, resolveSecretRefs, secretRefName } from "../src/mcp/secret-ref.js";
import {
  removeServerBlock,
  renderServerBlock,
  setServerEnabled,
  upsertServerBlock,
  writeMcpTomlText,
} from "../src/mcp/config-writer.js";
import type { MCPConfig, SecretsConfig } from "../src/config/schema.js";

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-mcp-writer-"));
function tmpFile(name: string): string {
  return path.join(tmpRoot, name);
}

// ── 1. 渲染 ─────────────────────────────────────────────────────

test("renderServerBlock:stdio（含 args / env / description）能被解析回同样字段", () => {
  const block = renderServerBlock("exa", {
    transport: "stdio",
    command: "bun",
    args: ["/home/lyy/tinyclaw/mcp-servers/exa/index.ts"],
    env: { EXA_API_KEY: "${SECRET:EXA_API_KEY}" },
    description: "Exa 搜索",
  });
  const parsed = analyzeMcpTomlText(block);
  assert.equal(parsed.diagnostics.filter((d) => d.level === "error").length, 0);
  const srv = parsed.config.servers["exa"];
  assert.ok(srv);
  assert.equal(srv.transport, "stdio");
  if (srv.transport === "stdio") {
    assert.equal(srv.command, "bun");
    assert.deepEqual(srv.args, ["/home/lyy/tinyclaw/mcp-servers/exa/index.ts"]);
    assert.equal(srv.env?.["EXA_API_KEY"], "${SECRET:EXA_API_KEY}");
  }
  assert.equal(srv.description, "Exa 搜索");
  assert.equal(srv.enabled, true);
});

test("renderServerBlock:sse（含 headers / enabled=false）", () => {
  const block = renderServerBlock("win-mcp", {
    transport: "sse",
    url: "http://192.168.10.81:13333/sse",
    headers: { Authorization: "${SECRET:WIN_TOKEN}" },
    enabled: false,
  });
  const parsed = analyzeMcpTomlText(block);
  const srv = parsed.config.servers["win-mcp"];
  assert.ok(srv);
  if (srv?.transport === "sse") {
    assert.equal(srv.url, "http://192.168.10.81:13333/sse");
    assert.equal(srv.headers?.["Authorization"], "${SECRET:WIN_TOKEN}");
  }
  assert.equal(srv?.enabled, false);
});

test("renderServerBlock:含引号/反斜杠/中文的值可安全往返", () => {
  const tricky = 'a"b\\c\nd 中文';
  const block = renderServerBlock("tricky", {
    transport: "stdio",
    command: "node",
    args: [tricky],
    description: tricky,
  });
  const srv = analyzeMcpTomlText(block).config.servers["tricky"];
  assert.ok(srv);
  if (srv?.transport === "stdio") assert.deepEqual(srv.args, [tricky]);
  assert.equal(srv?.description, tricky);
});

// ── 2. 块级补丁：保留用户内容 ───────────────────────────────────

const USER_FILE = `# 我的 MCP 配置（这段注释必须活着）
[servers.notes]
enabled   = false
transport = "stdio"
command   = "bun"
args      = ["/home/lyy/tinyclaw/mcp-servers/notes/index.ts"]

# 自定义段落，写入器不该碰
[custom]
keep = "me"

[servers.old]
transport = "stdio"
command = "node"
`;

test("upsert:追加新 server 到文件末尾，保留注释与 [custom] 段", () => {
  const next = upsertServerBlock(USER_FILE, "exa", renderServerBlock("exa", {
    transport: "stdio",
    command: "bun",
    args: ["exa.ts"],
  }));
  assert.match(next, /# 我的 MCP 配置/);
  assert.match(next, /\[custom\]\nkeep = "me"/);
  const parsed = analyzeMcpTomlText(next);
  assert.equal(parsed.diagnostics.filter((d) => d.level === "error").length, 0);
  assert.deepEqual(Object.keys(parsed.config.servers).sort(), ["exa", "notes", "old"]);
});

test("upsert:覆盖已有块（不产生重复 header，不影响其它块）", () => {
  const next = upsertServerBlock(USER_FILE, "notes", renderServerBlock("notes", {
    transport: "stdio",
    command: "node",
    args: ["notes.js"],
  }));
  const occurrences = next.split("\n").filter((l) => l.trim() === "[servers.notes]").length;
  assert.equal(occurrences, 1);
  const parsed = analyzeMcpTomlText(next);
  const notes = parsed.config.servers["notes"];
  assert.ok(notes);
  if (notes?.transport === "stdio") {
    assert.equal(notes.command, "node");
    assert.deepEqual(notes.args, ["notes.js"]);
  }
  assert.equal(notes?.enabled, true);
  assert.deepEqual(Object.keys(parsed.config.servers).sort(), ["notes", "old"]);
  assert.match(next, /\[custom\]\nkeep = "me"/);
});

test("remove:只删目标块，其它块与注释保留", () => {
  const r = removeServerBlock(USER_FILE, "old");
  assert.equal(r.removed, true);
  const parsed = analyzeMcpTomlText(r.content);
  assert.deepEqual(Object.keys(parsed.config.servers), ["notes"]);
  assert.match(r.content, /# 我的 MCP 配置/);
  assert.match(r.content, /\[custom\]\nkeep = "me"/);
});

test("remove:目标不存在时原样返回", () => {
  const r = removeServerBlock(USER_FILE, "nope");
  assert.equal(r.removed, false);
  assert.equal(r.content, USER_FILE);
});

test("remove:删掉最后一个块后文件仍是合法 TOML", () => {
  const only = '[servers.solo]\ntransport = "stdio"\ncommand = "node"\n';
  const r = removeServerBlock(only, "solo");
  const parsed = analyzeMcpTomlText(r.content);
  assert.equal(parsed.diagnostics.filter((d) => d.level === "error").length, 0);
  assert.deepEqual(Object.keys(parsed.config.servers), []);
});

test("setEnabled:改已有 enabled 行；缺失时补一行", () => {
  const on = setServerEnabled(USER_FILE, "notes", true);
  assert.equal(on.found, true);
  assert.equal(analyzeMcpTomlText(on.content).config.servers["notes"]?.enabled, true);
  assert.match(on.content, /enabled = true/);

  const off = setServerEnabled(USER_FILE, "old", false);
  assert.equal(off.found, true);
  assert.equal(analyzeMcpTomlText(off.content).config.servers["old"]?.enabled, false);
});

// ── 3. 写入：校验 / 原子 / 备份 ─────────────────────────────────

test("write:坏内容（stdio 缺 command）被拒绝，原文件不变", () => {
  const p = tmpFile("mcp-invalid.toml");
  fs.writeFileSync(p, USER_FILE, "utf-8");
  assert.throws(
    () => writeMcpTomlText('[servers.bad]\ntransport = "stdio"\n', p),
    /已拒绝/
  );
  assert.equal(fs.readFileSync(p, "utf-8"), USER_FILE);
});

test("write:合法内容落盘 + 生成 .bak 备份 + 权限 0600", () => {
  const p = tmpFile("mcp-ok.toml");
  fs.writeFileSync(p, USER_FILE, "utf-8");
  const next = upsertServerBlock(USER_FILE, "exa", renderServerBlock("exa", {
    transport: "stdio",
    command: "bun",
    args: ["exa.ts"],
  }));
  const { backupPath } = writeMcpTomlText(next, p);
  assert.ok(backupPath && fs.existsSync(backupPath));
  assert.equal(fs.readFileSync(backupPath, "utf-8"), USER_FILE);
  assert.equal(fs.readFileSync(p, "utf-8"), next);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${p}.tmp`), false);
});

test("write:备份最多保留 5 份", () => {
  const p = tmpFile("mcp-prune.toml");
  fs.writeFileSync(p, USER_FILE, "utf-8");
  const next = upsertServerBlock(USER_FILE, "exa", renderServerBlock("exa", {
    transport: "stdio",
    command: "bun",
  }));
  for (let i = 0; i < 8; i++) writeMcpTomlText(next, p);
  const backups = fs.readdirSync(tmpRoot).filter((f) => f.startsWith("mcp-prune.toml.bak-"));
  assert.equal(backups.length, 5);
});

test("write:文件原本不存在时不备份（backupPath=null）", () => {
  const p = tmpFile("mcp-fresh.toml");
  const { backupPath } = writeMcpTomlText(
    renderServerBlock("solo", { transport: "stdio", command: "node" }) + "\n",
    p
  );
  assert.equal(backupPath, null);
  assert.equal(analyzeMcpTomlText(fs.readFileSync(p, "utf-8")).config.servers["solo"]?.transport, "stdio");
});

// ── 4. ${SECRET:NAME} ───────────────────────────────────────────

const SECRETS: SecretsConfig = {
  EXA_API_KEY: { value: "sk-real-value", allowed_hosts: [] },
  LEGACY: "legacy-bare-string",
};

test("isSecretRef / secretRefName:只认整值引用", () => {
  assert.equal(isSecretRef("${SECRET:FOO}"), true);
  assert.equal(isSecretRef("prefix-${SECRET:FOO}"), false);
  assert.equal(secretRefName("${SECRET:FOO}"), "FOO");
  assert.equal(secretRefName("plain"), null);
});

test("resolveSecretRefs:引用取值、明文透传、缺失只记录不抛错", () => {
  const r = resolveSecretRefs(
    { A: "${SECRET:EXA_API_KEY}", B: "plain", C: "${SECRET:NOPE}", D: "${SECRET:LEGACY}" },
    SECRETS
  );
  assert.equal(r.values["A"], "sk-real-value");
  assert.equal(r.values["B"], "plain");
  assert.equal(r.values["C"], undefined);
  assert.equal(r.values["D"], "legacy-bare-string");
  assert.deepEqual(r.missing, ["NOPE"]);
});

test("checkSecretRefs:缺失引用产出 error 诊断，含 server 名与键名（不含值）", () => {
  const config: MCPConfig = {
    servers: {
      exa: {
        transport: "stdio",
        command: "bun",
        args: [],
        enabled: true,
        env: { EXA_API_KEY: "${SECRET:MISSING_KEY}" },
      },
    },
  };
  const diags = checkSecretRefs(config, SECRETS);
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.ok(d);
  assert.equal(d.level, "error");
  assert.equal(d.code, "secret");
  assert.equal(d.server, "exa");
  assert.match(d.message, /MISSING_KEY/);
  assert.match(d.message, /env\.EXA_API_KEY/);
  assert.equal(JSON.stringify(diags).includes("sk-real-value"), false);
});

test("checkSecretRefs:引用齐全时无诊断", () => {
  const config: MCPConfig = {
    servers: {
      exa: {
        transport: "stdio",
        command: "bun",
        args: [],
        enabled: true,
        env: { EXA_API_KEY: "${SECRET:EXA_API_KEY}", PLAIN: "x" },
      },
    },
  };
  assert.deepEqual(checkSecretRefs(config, SECRETS), []);
});

// ── 收尾 ────────────────────────────────────────────────────────

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响测试结论 */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
