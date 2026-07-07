#!/usr/bin/env tsx
/**
 * 清理旧 YYYY-MM.md 遗留文件
 *
 * 旧系统按月归档蒸馏笔记 (2026-04.md ~ 2026-07.md)，
 * 新系统已改为 MEMORY.md + topic 文件 + NOTES.md。
 *
 * 用法:
 *   npx tsx scripts/cleanup-legacy-notes.ts            # dry-run 模式
 *   npx tsx scripts/cleanup-legacy-notes.ts --execute  # 实际删除
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AGENTS_DIR = path.join(os.homedir(), ".tinyclaw", "agents");

// YYYY-MM.md 格式
const LEGACY_RE = /^20\d\d-\d\d\.md$/;

interface FoundFile {
  agentId: string;
  project: string;
  name: string;
  size: number;
  path: string;
}

function scan(): FoundFile[] {
  const results: FoundFile[] = [];

  if (!fs.existsSync(AGENTS_DIR)) {
    console.log(`[skip] agents dir not found: ${AGENTS_DIR}`);
    return results;
  }

  const agents = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const projectsDir = path.join(AGENTS_DIR, agent.name, "code", "projects");
    if (!fs.existsSync(projectsDir)) continue;

    const projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projectDir = path.join(projectsDir, proj.name);

      const files = fs.readdirSync(projectDir);
      for (const f of files) {
        if (!LEGACY_RE.test(f)) continue;
        const fp = path.join(projectDir, f);
        const stat = fs.statSync(fp);
        results.push({
          agentId: agent.name,
          project: proj.name,
          name: f,
          size: stat.size,
          path: fp,
        });
      }
    }
  }

  return results;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── main ──

const execute = process.argv.includes("--execute");
const mode = execute ? "EXECUTE" : "DRY-RUN";

console.log(`=== 旧 YYYY-MM.md 清理脚本 (${mode}) ===\n`);

const found = scan().sort((a, b) => b.size - a.size);

if (found.length === 0) {
  console.log("没有发现旧格式文件,无需清理。");
  process.exit(0);
}

let totalSize = 0;
for (const f of found) {
  totalSize += f.size;
  const rel = path.relative(AGENTS_DIR, f.path);
  console.log(`  ${formatSize(f.size).padStart(8)}  ${rel}`);
}

console.log(`\n共 ${found.length} 个文件, 合计 ${formatSize(totalSize)}`);

if (execute) {
  console.log("\n正在删除...");
  let deleted = 0;
  for (const f of found) {
    try {
      fs.unlinkSync(f.path);
      deleted++;
    } catch (err: any) {
      console.error(`  删除失败: ${f.path} (${err.message})`);
    }
  }
  console.log(`已删除 ${deleted}/${found.length} 个文件`);
} else {
  console.log('\n(dry-run, 加 --execute 参数执行实际删除)');
}
