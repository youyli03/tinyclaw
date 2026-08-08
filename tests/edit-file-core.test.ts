/**
 * edit_file 核心层单测(node:assert + tsx,零框架依赖)
 * 运行: npm run test:edit-file
 */
import assert from "node:assert/strict";
import {
  FULL_TO_HALF_PUNCT,
  normalizePunct,
  closestMatchDiagnostic,
  locateAndReplace,
} from "../src/tools/edit-file-core.js";

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

// ── 1. 映射表完整性 ──────────────────────────────────────────────
test("映射表:无恒等条目(key !== value)", () => {
  for (const [k, v] of Object.entries(FULL_TO_HALF_PUNCT)) {
    assert.notEqual(k, v, `key "${k}" 与 value 相同(恒等映射,归一化失效)`);
  }
});

test("映射表:key 均为全角(码点 ≥ 0xFF00 或已知 U+2xxx 标点)", () => {
  const knownHalf = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x3000, 0x3001, 0x3002]);
  for (const k of Object.keys(FULL_TO_HALF_PUNCT)) {
    const cp = k.codePointAt(0) as number;
    assert.ok(
      cp >= 0xff00 || knownHalf.has(cp),
      `key "${k}"(U+${cp.toString(16).toUpperCase()}) 不是全角字符`,
    );
  }
});

test("映射表:value 均为 ASCII 半角", () => {
  for (const [k, v] of Object.entries(FULL_TO_HALF_PUNCT)) {
    assert.ok(
      v.length === 1 && v.charCodeAt(0) < 0x80,
      `value "${v}"(U+${v.charCodeAt(0).toString(16)}) 不是 ASCII,key="${k}"`,
    );
  }
});

// ── 2. 半角 old_str → 全角文件 ───────────────────────────────────
test("容错:半角冒号匹配全角冒号并替换", () => {
  const r = locateAndReplace("本轮工具：exec_shell, code_note_write", "本轮工具:exec_shell", "本轮工具:done");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "本轮工具:done, code_note_write");
});

test("容错:半角括号匹配全角括号", () => {
  const r = locateAndReplace("调用(测试)完成", "调用(测试)", "调用(通过)");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "调用(通过)完成");
});

test("容错:半角逗号/感叹号/问号/分号", () => {
  const cases: Array<[string, string, string]> = [
    ["A，B，C", "A,B", "A;B"],
    ["你好！世界", "你好!", "你好?"],
    ["为什么？因为", "为什么?", "为什么!"],
    ["a；b；c", "a;b", "a:b"],
  ];
  for (const [content, oldStr, newStr] of cases) {
    const r = locateAndReplace(content, oldStr, newStr);
    assert.equal(r.status, "ok", `${content} 匹配 ${oldStr} 失败`);
  }
});

// ── 3. U+2026 省略号 ────────────────────────────────────────────
test("容错:U+2026 省略号展开匹配且替换偏移正确", () => {
  // 中文省略号 = 2 个 U+2026,展开为 6 个点;old_str 用 6 个半角点匹配
  const content = "等等……然后继续……结束";
  const r = locateAndReplace(content, "等等......然后", "然后");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "然后继续……结束");
});

test("容错:归一化+省略号混合(全角冒号+省略号)", () => {
  const content = "提示：请稍候……感谢";
  const r = locateAndReplace(content, "提示:请稍候......", "提示:请稍候");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "提示:请稍候感谢");
});

// ── 4. 诊断定位 ─────────────────────────────────────────────────
test("诊断:2000 行文件首字符空格的长 old_str 定位准确", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 2000; i++) lines.push(`line-${i}: padding content for filler`);
  lines[1499] = "  const target = computeValue(alpha, beta); // 目标行";
  lines[1500] = "  const next = computeValue(gamma, delta);";
  const content = lines.join("\n");
  // old_str 与目标行几乎一致,但有一个字符不同(故意写错),首字符是空格
  const oldStr = "  const target = computeValue(alpha, beta); // 目标行X";
  const diag = closestMatchDiagnostic(normalizePunct(content), normalizePunct(oldStr));
  assert.match(diag, /第 1500 行附近/, `诊断行号错误: ${diag}`);
});

test("诊断:差异字符报告包含 Unicode 码点", () => {
  const content = "function foo(a, b) { return a + b; }";
  const oldStr = "function foo(a，b) { return a + b; }"; // 全角逗号→归一化后一致,再改一个字符
  const diag = closestMatchDiagnostic(normalizePunct(content), normalizePunct(oldStr));
  assert.match(diag, /U\+/, "诊断应包含码点信息");
});

// ── 5. trim 重试 ────────────────────────────────────────────────
test("trim:old_str 末尾多一个换行仍可替换", () => {
  const r = locateAndReplace("const a = 1;\nconst b = 2;", "const a = 1;\n", "const a = 42;\n");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "const a = 42;\nconst b = 2;");
});

test("trim:old_str 前导多空格可替换且不叠加缩进", () => {
  const r = locateAndReplace("  return true;", "   return true;", "  return false;");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "  return false;");
});

// ── 6. 唯一性 ───────────────────────────────────────────────────
test("唯一性:重复文本返回 ambiguous", () => {
  const r = locateAndReplace("foo bar foo", "foo", "baz");
  assert.equal(r.status, "ambiguous");
  if (r.status === "ambiguous") assert.match(r.message, /出现 2 次/);
});

test("唯一性:归一化后多处命中返回 ambiguous", () => {
  const r = locateAndReplace("a：b\na：b", "a:b", "x");
  assert.equal(r.status, "ambiguous");
});

// ── 7. \\n 陷阱提示 ─────────────────────────────────────────────
test("提示:old_str 含真实换行且未匹配时给出转义提示", () => {
  const r = locateAndReplace("const s = 'a\\nb';", "const s = 'a\nb';", "x");
  assert.equal(r.status, "notfound");
  if (r.status === "notfound") assert.match(r.message, /真实换行符/);
});

test("提示:old_str 含字面 \\n 时提示换行意图", () => {
  const r = locateAndReplace("const s = 'a\nb';", "const s = 'a\\nb';", "x");
  assert.equal(r.status, "notfound");
  if (r.status === "notfound") assert.match(r.message, /字面 \\n/);
});

// ── 8. 精确匹配回归 ─────────────────────────────────────────────
test("回归:精确匹配正常替换", () => {
  const r = locateAndReplace("hello world", "world", "tinyclaw");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.content, "hello tinyclaw");
});

test("回归:未找到时诊断给出行号(锚字符存在于文件中)", () => {
  const r = locateAndReplace("hello world", "worlds", "x");
  assert.equal(r.status, "notfound");
  if (r.status === "notfound") {
    assert.doesNotMatch(r.message, /真实换行符/);
    assert.match(r.message, /第 \d+ 行附近/);
  }
});

test("回归:未找到且锚字符完全不存在时不报错", () => {
  const r = locateAndReplace("hello world", "zzz", "x");
  assert.equal(r.status, "notfound");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
