# Manual: environment, secrets and sandbox for unattended runs

This is the shared reference for what a **cron job**, a **loop tick** and a **background job** actually see:
which variables exist, where they come from, which files are readable/writable, and how a script gets a key
without the key ever entering the repository or a command line.

## 1. Environment layering (lowest to highest)

1. `process.env` — the service process, which already includes `~/.tinyclaw/env` loaded at startup;
2. `~/.tinyclaw/agents/<agentId>/env` — the agent's own variables, written by `env_set` (`KEY=VALUE` per line,
   `#` comments, values may be quoted, file mode 0600);
3. the explicit `env` object of a single `job_start` call (or the per-run extras injected by cron).

Later layers win. Values may use the `${SECRET:NAME}` form; the reference is resolved **only** when a child
process is constructed, from `secrets.toml`.

Rules:

- A variable whose value is a `${SECRET:NAME}` reference is *still a secret*: `env_set` on a
  secret-looking name (KEY/TOKEN/SECRET/PASS/AUTH/API/...) needs the user's approval, and tool output only
  ever shows **key names**, never values. Never echo a value back to the user or into a file in the repo.
- Cron runs do **not** mutate the service environment: a cron worker is shared across agents and jobs, so
  the agent env is passed as a per-run delta down to the tool context and child processes. Two jobs running
  in parallel with different agent envs cannot contaminate each other.
- The same layering applies to the LLM turn itself (`runAgent`), so `env_set` variables are visible both to
  `exec_shell` and to tools that build subprocess environments.

## 2. Secrets: declare per task, never globally

`~/.tinyclaw/secrets.toml` is the key store referenced by `${SECRET:NAME}`. Access is gated twice:

1. **Agent authorisation** — `[secrets].agents` must list the agent; otherwise any `${SECRET:...}` reference
   or `secrets: [...]` declaration is denied (and audited). A name being guessable does not grant access.
2. **Per-task declaration** — under the sandbox, `secrets.toml` is masked to an empty file. A cron job or
   loop trigger that declares `secrets: ["NAME"]` gets a temporary file containing **only those keys**,
   bound back to the original path, so existing scripts need no change. `job_start` uses the same idea via
   its `secrets` parameter. Undeclared keys are simply absent, and the failure mode is a plain
   "missing key" error inside the script.

Prefer the reference form (`KEY=${SECRET:NAME}` in the agent env) over writing values into a task config:
the reference is stored as text, resolves at spawn time, and never appears in `ps -ef`.

Reading secrets is not the same as writing them: this manual's rules never let a task *create* or *change*
a secret, and `[secrets]` itself is outside what the agent may modify through config tooling.

## 3. Sandbox: default-deny for writes

Unattended runs are confined. For anything that spawns a **process** (`exec_shell`, `job_start`, a script
inside a cron step) the writable set is exactly:

- the agent's own workspace, `~/.tinyclaw/agents/<id>/workspace` (with `tmp/`, `output/`, `downloads/`),
- the system temp directory, and
- whatever the task declares (`writablePaths` on a cron job / loop trigger) plus the global
  `[sandbox].extraRwPaths`.

That is narrower than "the agent's directory": `agents/<id>/memory`, `agents/<id>/env` and the rest of
`~/.tinyclaw` are not writable from a shell unless declared. Declaring a path widens writes only, for that
task only, and it does not widen secret access. Readable-but-not-writable normally includes the repository,
system directories and other `~/.tinyclaw` data (cache, data, scripts, reports, sessions).

The sandbox wraps **subprocesses**; the agent's own file tools (`write_file`, `edit_file`, ...) are governed
by path-guard and `fs_grant` instead, so "the agent can write X" and "a script started by the agent can
write X" are different questions — check the right one before concluding a task is blocked.

`exec_shell` runs inside the sandbox when `[sandbox].execShell = "sandbox"`. `elevate: true` is the escape
hatch (one approval per distinct command), and it is **not** available to unattended runs — nobody is there
to approve it, so do not write tasks that depend on it.

## 4. The `wake` command on `PATH`

tinyclaw materialises a small executable named `wake` in its own runtime directory and prepends that
directory to `PATH` for every job, cron shell and sandboxed command. It exposes exactly one capability —
deliver a message to a session and start an agent turn there — and nothing else of the CLI.

Inside a cron or background job the target, agent and source are pre-filled from the task's own identity,
so the zero-argument form works:

```bash
wake "hourly check done: 3 new alerts"
some_command | wake --stdin
```

Outside a job (or in a loop tick, which does not inject a target) pass them explicitly:
`wake -s <session id> -a <agent id> --source <label> "<message>"`.

Delivery is best-effort and **silent on failure** — undeliverable wakes are dropped, not queued, and the
command still exits 0. Consequence for task design: the *durable* output of a task must be written to a file,
a report or the job log first; `wake` only says "look at this now".

The woken turn inherits the **target session's** permissions, which is what makes the zero-argument form
inside a job so useful: the job was started from a chat, so waking that chat runs the turn with that chat's
full tool set and sends any approval prompt to it. A target with no reachable channel (a `cli:` session)
instead falls back to the unattended whitelist. Either way, put the facts in the message — the woken agent
starts from your text, not from your context.

## 5. Diagnosing "it worked in chat but not in the task"

Check in this order:

1. **Working directory** — jobs default to the agent workspace, not the repository; use absolute paths or
   pass `cwd`.
2. **Writable path** — a sandbox denial looks like a normal write error in the script output; compare the
   target against the task's declared `writablePaths`.
3. **Secrets** — an undeclared key is an empty file, not an error from the sandbox; verify the declaration
   *and* the `[secrets].agents` authorisation.
4. **PATH** — a script that calls a tool installed in the user's login shell may not find it; use an
   absolute path.
5. **Environment name** — variables set with `env_set` belong to the *agent*, so a task running as a
   different `agentId` will not see them.

Prefer reproducing with `exec_shell` (same sandbox, same env layering) before blaming the scheduler.
