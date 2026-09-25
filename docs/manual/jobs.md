# Manual: background jobs (long-running processes)

`job_start` runs a **process** in the background and returns a job id immediately. No LLM runs inside it.
Use it for builds, downloads, scrapes, training, watchers — anything that outlives one chat turn.

Runtime data: `~/.tinyclaw/jobs/<id>/` (`meta.json`, `stdout.log`, `stderr.log`, `rc`).

## 1. When to use a job, and when not to

- Long command you do not want to block the conversation → `job_start`.
- Something you need to look at only after it finishes → still `job_start`; the framework notifies you on exit.
- A short command whose output you need right now → use `exec_shell` instead of wrapping it in a job.
- Work that needs reasoning, not a process → use a sub-agent (`agent_fork`), not a job.

Jobs are per-agent and capped: a limited number of *running* jobs per process and per agent.
If you hit the cap, `job_kill` something or wait — do not retry in a loop.

## 2. Reading output is incremental

`job_output` returns **only the text you have not seen yet** plus a cursor. Call it repeatedly to follow
progress; do not ask for the whole log every time. Finished jobs keep their logs on disk, so the output is
still readable after a restart. Use `job_list` for an overview and `job_status` for one job's detail.

`job_kill` kills the whole **process group** (children included). It sends `SIGTERM` by default; use
`signal: "SIGKILL"` only when a graceful stop was ignored.

Completion notify is a *notification*, not a new turn: it tells you the job ended, it does not run the LLM.
If you need the LLM to react to the result, wake the session explicitly (section 5).

## 3. `detach`: survive a restart?

- `detach: false` (default) — the job dies with the tinyclaw service.
- `detach: true` — the job survives a tinyclaw restart (equivalent to `&` / `nohup`).

Choose `detach: true` for anything long enough that a restart is plausible (hours, model training,
big downloads). Note that a detached job keeps running even if you forget about it — always tell the user
the job id and how to stop it.

Set `timeout_secs` for tasks that can hang, and `cwd` when the command's meaning depends on the directory
(default: the agent workspace).

## 4. Environment and secrets

The job inherits `process.env` (which already includes `~/.tinyclaw/env`), then the agent's own variables
(`agents/<id>/env`, written by `env_set`), then the `env` object passed to `job_start` — later layers win.
Explicit `env` values are passed through the spawn environment, never on the command line, so `ps -ef`
does not show them. Values may use the `${SECRET:NAME}` reference form.

To let the job read keys from `secrets.toml`, declare them: `secrets: ["NAME", ...]`. In the sandbox a
filtered copy is bound back to the original path, so scripts keep reading `~/.tinyclaw/secrets.toml`
unchanged; undeclared keys are simply absent. Declaring (or referencing) secrets requires the agent to be
authorised in `[secrets].agents` — otherwise the job is refused with a reason.

A job can never see a secret that was not declared or referenced: do not tell the user "it will pick up the
key from the environment" without checking the declaration.

## 5. Waking the LLM from inside a job

The job's environment carries its own identity: `TINYCLAW_JOB_ID`, `TINYCLAW_AGENT_ID`, and
`TINYCLAW_WAKE_TARGET` (the session that started it). The `wake` command is on the job's `PATH`, so a
script can hand a result back to the agent with no arguments at all:

```bash
wake "download finished: 42 new files, 3 failed"        # target/source come from the environment
tail -n 50 build.log | wake --stdin                     # pipe the log as the message
wake -s qqbot:c2c:XXXX --source nightly "…"             # outside a job, be explicit
```

Semantics of `wake`:

- It **injects a message and starts an agent turn** for the target session — it is a queue-jump, not a
  notification: if that session is mid-turn, the running turn is interrupted so the new input is handled now.
- That turn runs with the **target session's permissions**, not the job's: a job started from a QQ chat
  wakes that QQ chat, so the woken turn gets the full tool set and any approval prompt is sent to that chat
  and waits for the user's reply. If the target session has no reachable channel (e.g. a `cli:` session),
  the turn falls back to the unattended whitelist and approvals are refused.
- The woken session's identity, history and channel are the target's own — the job does not get its own
  conversation.
- Delivery is best-effort and **silent on failure**: if nothing can be reached, `wake` exits 0 writing
  nothing. Never rely on it for durability; if the result must not be lost, put it in a file or in the
  job's own log first, then wake.
- Wakes are throttled per session: a burst collapses into a short delay rather than an error, so a loop of
  `wake` calls is safe but pointless — send one meaningful message, not one per log line.

Because the woken agent starts a fresh turn from your message alone, put the *key facts* in the message
(or in a workspace file it can read) instead of saying "see the job log".

## 6. Reporting a job to the user

Always give: job id, what it is doing, whether it survives a restart, and how it will be reported back
(wake/notify or manual `job_output`). Never report a job as "done" before the meta shows a terminal status
with an exit code.
