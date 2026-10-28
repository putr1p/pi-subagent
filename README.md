# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own tmux session with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- tmux

## Install

Clone into Pi's global extension directory and expose the CLI on `PATH`:

```sh
git clone git@github.com:earendil-works/pi-subagent.git ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent result a1b2c3
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

## Results

Subagents never block the parent. When a child finishes a turn, fails, or exits unexpectedly, its result is injected into the parent session as a `subagent_result` message: an idle parent starts a new turn, a busy one receives it after its current turn. Results found in the same second arrive as one message.

- The child writes each result to `outbox/` in its run directory; the parent extension delivers and deletes it. Results produced while the parent is suspended are delivered when it resumes.
- The parent also reports a child that died without saying so, and one that has not started 60 s after spawn.
- `stop` and parent suspension are not reported.
- Results over 8 KB are cut; `subagent result <handle>` prints the full answer without blocking.
- `subagent wait` still blocks, for scripts and terminals. A result it returns is not also notified.
- Delivery is best effort: a parent crash at the wrong moment can duplicate a result or, rarely, lose one.
- `PI_SUBAGENT_NOTIFY=0` in the parent's environment shows results in the chat without starting a turn.
- Results from turns you run yourself in an attached child are delivered too. With several follow-ups queued, only the final answer is reported.

## Ownership

Inside a Pi session, `status`, `send`, `wait`, `result`, `rename`, and `stop` only act on subagents spawned by that session; other handles are reported as unknown. Plain terminals, `!` commands, and subagents themselves keep unrestricted access. After `/new` or `/fork`, the previous session's subagents can be managed from a plain terminal.

Use `/subagent` to select and attach to an active child. The status widget shows active names (or handles for unnamed runs) and their current state.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.
