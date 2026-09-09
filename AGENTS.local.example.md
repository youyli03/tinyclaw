# AGENTS.local.md（模板）

> 用法：把本文件复制为 `AGENTS.local.md` 再按本机情况填写。
> `AGENTS.local.md` 已在 `.gitignore` 中，**永不进 git**（见 `AGENTS.md` §11）。
> AI 在开始任务前会读它；其中的约束**优先于** `AGENTS.md` 的通用规则，
> 但与 `AGENTS.md` §0 五条硬规则冲突时，以 §0 为准。

---

## 环境

- 操作系统 / 发行版：
- Node 版本：
- 包管理器：npm（本仓库已迁离 bun）
- Python 解释器：python3
- 其他工具版本（chromium / libreoffice / mmdc 等）：

## SSH / 远端

```
SSH_HOST   = HOST
SSH_PORT   = 22
SSH_USER   = USER
SSH_KEY    = ~/.ssh/id_ed25519_deploy
```

- 完整连接命令：`ssh -i ~/.ssh/id_ed25519_deploy -p 22 USER@HOST`
- 部署目标目录：`/home/USER/tinyclaw`
- 远端服务名：`tinyclaw.service`（`systemctl --user restart tinyclaw`）

## 本地路径

- 仓库根：
- 运行时数据：`~/.tinyclaw`
- 临时目录：`<repo>/tmp`（按 `AGENTS.md` §5）
- 代码模式工作区：

## 机器特定差异

- 本机 `python3` 实为：
- 本机 mermaid / 图表渲染依赖：
- 本机 SQLite（`better-sqlite3` 是否已装）：
- 需要走代理的域名：
- 其他：

## 凭据引用（只写"在哪"，不写明文）

- LLM key → `~/.tinyclaw/config.toml` 的 `[providers.*]`
- 第三方 token → `~/.tinyclaw/secrets.toml` 的 `$SECRET_NAME`
- GitHub → `gh auth` / `~/.tinyclaw/.github_token`
- MFA → `~/.tinyclaw/auth/totp.key`

## 个人偏好

- 默认分支：`main`
- 提交署名：
- 通知方式：
