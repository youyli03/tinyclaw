# Manual: cron jobs (scheduled tasks)

Scheduled tasks live in `~/.tinyclaw/cron/jobs/<id>.json` (one file per job) and are managed with
`cron_add` / `cron_list` / `cron_remove` / `cron_enable` / `cron_disable` / `cron_run`.
Run logs: `~/.tinyclaw/cron/logs/<jobId>.jsonl`.

## 1. Never create a scheduled task silently

Creating a job changes the machine's future behaviour. Before calling `cron_add`, confirm with the user:

1. **intent** — what exactly should happen, and what is *not* supposed to happen;
2. **schedule** — `once` / `every` / `daily` / `manual`, plus the concrete time or interval;
3. **output** — where the result goes (which chat / peer) and **notify policy**;
4. **LLM or not** — pipeline mode (no LLM, zero cost) versus message mode (LLM runs every tick);
5. **output requirements** — content and format the user expects.

If any of these is vague, use `ask_user` instead of guessing. Echo the created job back to the user
so they can review schedule, target and notify policy.

## 2. Pick the cheapest execution mode that works

| Mode | How to select | Behaviour | Cost |
|---|---|---|---|
| **pipeline** | pass `steps` | Runs tool calls directly; `{type:"msg"}` steps trigger the LLM | No LLM unless a `msg` step exists |
| **message** | omit `steps` | Injects `message` as a user turn and runs a full agent turn | One LLM run per tick |
| **manual** | `type: "manual"` | No schedule at all; only `cron_run` fires it | Depends on mode |

Prefer **pipeline** for anything deterministic (fetch → parse → write → push). Use **message** only when
the task genuinely needs judgement, summarisation or free-form output.

In pipeline mode `message` is only a description (min 5 chars). In message mode it is the actual prompt
and must contain all four elements (intent / execution flow / constraints / output requirements,
min 15 chars) — a short prompt produces a shallow, unreliable job.

Pipeline results: the last `msg` step's LLM output is pushed; if there is no `msg` step, the last tool
step's output is pushed.

## 3. Scheduling rules

- `once` — requires `runAt` (ISO 8601, e.g. `2026-08-02T15:00:00+08:00`). The job deletes itself after firing.
- `every` — requires `intervalSecs`; optional `timeRange` limits when it may fire
  (`{start, end, weekdays?, timezone?}`, weekday `0=Sunday`, crossing midnight is supported, ticks outside
  the window are skipped). Use `timeRange` for "every 5 minutes during trading hours" style tasks.
- `daily` — requires `timeOfDay` (`"HH:MM"`) or `timesOfDay` (`["09:00","20:00"]`; takes precedence).
- `manual` — no automatic schedule.

Times are **local time** unless the schedule carries a timezone. Do not invent a schedule format;
the schema rejects missing `runAt` / `intervalSecs` / `timeOfDay`.

## 4. Output and notify policy

`output.notify`:

- `always` — push every run (default);
- `on_change` — push only when the result differs from the previous run (good for "tell me only if it changed");
- `on_error` — push only on failure;
- `never` — log only;
- `llm` — the model decides: push only what it wraps in `[NOTIFY]...[/NOTIFY]`.

If the job has no push target, it logs only — say so explicitly instead of promising the user a message.
Pass `peerId` / `msgType` / `botId` only when the target is not inferable from the session.

## 5. Sandbox declaration: writable paths and secrets

Unattended runs are sandboxed and a script may write, by default, only the agent's own workspace
(`~/.tinyclaw/agents/<id>/workspace`) plus the system temp directory. Anything else must be declared per job:

- `writablePaths: ["~/.tinyclaw/data", "~/FinanceSkill", ...]` — widen *writes* for this job only.
  This does not widen secret access.
- `secrets: ["DEEPSEEK_API_KEY", ...]` — the names from `secrets.toml` this job may read at runtime.
  Without a declaration the script sees an **empty** `secrets.toml`, so a task that needs a key and does
  not declare it fails with "missing key", not with a permission prompt.

Both are per-job and take effect immediately; see the `env` manual for how a script actually sees them.

## 6. MFA, statefulness, model

- `mfaExempt` defaults to **false**: high-risk tools (write/delete) still ask once when a human can be
  reached, and fall back to `[sandbox.unattended].mfaFallback` when not. Pass `true` only when you are
  certain the task needs no review.
- `stateful: false` (default) gives each run a fresh session (`cron:<id>:<ts>`) that is deleted afterwards.
  `stateful: true` keeps one session across runs (`cron:<id>`) — use it only for jobs that must remember.
- `model` — `"provider/model-id"` from `config.toml` `[providers.*]`; omit to use the daily backend.

## 7. Verify before you report success

1. `cron_list` with `logs: true` and confirm schedule, target and last run status.
2. For a new pipeline job, run it once with `cron_run` and show the user the real output.
3. Report to the user: job id, schedule (next fire time), where output goes, and what happens on failure.
