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
subagent wait a1b2c3
subagent stop a1b2c3
subagent revive a1b2c3
subagent list
```

Use `/subagent` to select and attach to an active child. The status widget shows active names (or handles for unnamed runs) and their current state.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` archives a run; `subagent stop --purge` removes it permanently.

## Archive and revive

`subagent stop` moves the run directory, including the full `session.jsonl` transcript, to `~/.pi/agent/subagents-archive/<handle>-<timestamp>/` instead of deleting it. Children that crashed or were killed are archived the same way when the parent session quits. Runs that never wrote a transcript are removed.

```sh
subagent list --archived                 # archived runs, newest first
subagent revive a1b2c3                   # relaunch idle with full history
subagent revive a1b2c3 --prompt "Continue"
subagent stop a1b2c3 --purge             # delete instead of archiving
subagent spawn --from-session /path/to/session.jsonl --prompt "Continue"
```

- `revive` works for archived runs and for live runs whose process exited or failed. It keeps the handle, name, model, thinking level, tools, isolation flags, and working directory, and adopts the run into the calling parent session. Messages still queued in the inbox when a run was archived are discarded.
- `--from-session` starts a new run from a copy of any pi session transcript. It uses the transcript's recorded working directory unless `--cwd` is given.
- Archived handles are never reused for new subagents.
- Set `PI_SUBAGENT_ARCHIVE=0` to restore delete-on-stop behavior. The archive is not pruned automatically.
