# Manual: loop triggers (watch mode)

A loop is *not* a scheduled task. It is a **watcher bound to a conversation**: while it is active it ticks
every `tickSeconds`, and each tick may inject a message into that conversation and run one agent turn.
The user's mental model is: "I said it once in chat, it keeps watching, and it tells me when something
changes." Do not use a loop to run a fixed job on a schedule — that is what cron jobs are for.

Config: `~/.tinyclaw/loops/<id>.json` (one file per trigger).

## 1. Loop versus cron

| | loop trigger | cron job |
|---|---|---|
| Purpose | watch a condition, report changes | run a defined task on a schedule |
| Lives in | a bound conversation (`bindTo`) | its own session (`cron:<id>`) |
| Cadence | `tickSeconds`, "wait after the previous tick ends" | schedule (`once` / `every` / `daily`) |
| Output | injected into the bound conversation | pushed to a configured target |

Never describe a loop to the user as "a scheduled task", and never create a cron job when the user asked
for continuous watching.

## 2. Controlling a running loop

`loop_control`:

- `action: "pause"` — stop ticking (keeps the config); `"resume"` — continue;
- `action: "exit"` — end the **current time window**; the next window resets automatically.

Use it when the user says "stop watching", "pause that", "no need to keep an eye on it", "exit the loop".
`id` defaults to `monitor`, which is usually wrong when several loops exist — pass the real id when known.

If `allowExit` is `false`, the model **cannot** end the window itself and the loop keeps ticking until the
user stops it (correct for permanent monitoring, wrong for "watch until X happens"). When creating or
editing a loop for a finite goal, make sure the user knows how it will end.

## 3. What a tick does

1. Optional `timeRanges` filter — outside every configured window the tick is skipped silently.
2. Optional `preCheckScript` — must exit 0, otherwise the whole tick is skipped. (See the caveat in
   section 5.)
3. Optional `steps` — tool steps run in order and their output is prepended to the injected message.
4. The combined content is injected as a task message and one agent turn runs in the bound session.
5. `notify` decides what is pushed: `always` (every tick's reply), `llm` (only `[NOTIFY]...[/NOTIFY]`
   blocks), `never` (default — the agent must use `notify_user` / `send_report` itself).

`tickSeconds` counts from the **end** of the previous tick, so a slow tick cannot pile up. A tick is
skipped while the previous one is still running, and while the bound session is in `code` mode.

## 4. Sandbox declaration

Same rule as cron jobs: a script started by a tick may write only the agent's own workspace
(`~/.tinyclaw/agents/<id>/workspace`) and the temp directory unless the trigger declares
`writablePaths: [...]`, and it can read only the secret names it declares in `secrets: [...]`.
A watcher that writes a database or reads an API key must declare both, or it will fail at runtime.

## 5. Known limits — do not promise what does not work

- `preCheckScript` is executed as a Node script (`node <path>`), so a shell or Python script "works" only
  by accident of its shebang being ignored. Prefer expressing the pre-check as a `tool` step and letting the
  model decide, or as a plain command run through `exec_shell` in a step.
- A loop's tool steps run unattended and are checked against the unattended allowlist; a tool outside it is
  refused and the refusal text is fed back as the step output rather than silently skipped.
- Ticks are logged to the service log only; unlike cron there is no per-loop log file.
- A tick's payload is **not** stored verbatim in history: when the conversation is sent to the model, the
  newest loop-task message is re-expanded from the trigger's JSON file and older ones collapse to
  `[Loop Task @ <path>]`. Editing the trigger file therefore changes what the model reads back as history.
  Never treat a tick message as a durable record of what was observed — write findings to a file or memory.

## 6. Waking, from a loop

Inside a loop tick you are already in the bound conversation, so an extra `wake` is normally wrong. The
`wake` command is still on `PATH` for scripts started by a tick, but a loop tick does **not** inject the
target/source variables that a background job does — if you truly must call it, pass `-s <session id>`
explicitly (the trigger's `bindTo`).

The permission of that woken turn follows the **target** session, not the loop: passing the trigger's
`bindTo` (usually a QQ chat) means the woken turn gets that chat's full tool set with approvals delivered
there; a target with no reachable channel would fall back to the unattended whitelist.
