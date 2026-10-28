# pi-subagent v2 spec

## Goal

Add to the existing extension, without changing existing behavior:

1. **Notify:** when a subagent finishes, the parent is told automatically. No blocking `wait`.
2. **Own:** a pi session sees and controls only its own subagents. A subagent can't control or message anyone.

Not doing: subagent↔subagent messaging, revive, a sandbox.

## Workflow

```
parent: subagent spawn ...      → returns immediately (unchanged)
parent: keeps working / chatting
child:  finishes
parent: gets "Subagent X finished: <answer>"   ← new
        idle → reacts right away · busy → after its current turn
parent: subagent stop X                        (unchanged)
```

## Existing behavior: unchanged

Everything below works exactly as today:

- All commands, flags, output text and exit codes.
- Spawn/stop/wait/send/rename/status/list from inside pi.
- Spawn and manage from a plain terminal.
- `wait` blocks and prints the final answer.
- Widget, `/subagent` attach, suspend on quit, relaunch on resume, `/reload`.
- Run folder layout, metadata, inbox.
- Children can't spawn subagents.

Only exceptions, all from the two goals:

| Change | Before | After |
|---|---|---|
| New message after a child finishes | none | `subagent-result` message (turn off: `PI_SUBAGENT_NOTIFY=0`) |
| pi session uses another session's handle | allowed | `Unknown subagent` |
| `subagent` inside a child | only `spawn` refused | all commands refused |
| Child runs `tmux` | your tmux server | its own empty one |
| Child file tools on other subagents' folders | allowed | blocked |

## Who can do what

| Caller | Detected by | Can |
|---|---|---|
| pi session | `PI_SESSION_ID` set | spawn; manage its own subagents |
| Child | `PI_SUBAGENT_RUN_DIR` set | nothing |
| Plain terminal, `!` commands | neither set | everything (as today) |

## Notifications

- Sent for: **finished**, **failed**, **exited** (crashed or killed, not `stop`).
- Each result is sent **at most once**: never twice, even with two pi windows on one session.
  - Rarely it's sent **zero** times: you quit or press Esc while it's queued. Get it with `subagent wait`.
- Sent once the result has been seen on 2 checks in a row (1 s apart).
- Rename doesn't resend. Resume doesn't resend old results.
- `wait` is unchanged. If its result was already notified, it adds a note line on **stderr** (stdout stays the same).
- Long answers cut at 20k chars; `wait` still has the full text.

## Child restrictions

Guardrails against mistakes, not a sandbox.

- The child's own logs and data are written by pi and the extension directly, not by the model's tools, so they are unaffected.
- Blocked: the model's `read`/`write`/`edit`/`grep`/`find`/`ls` on other subagents' folders, and `write`/`edit` anywhere in `~/.pi/agent/subagents/`.
- Not blocked: bash. `echo x > <other subagent's file>` still works. A real fix is a bubblewrap sandbox per child (later, opt-in).
- Normal work (grep, editing repo files, heredocs) is unaffected.

## Implementation notes

- **Result IDs:** finished/failed = assistant entry id; error = entry id + sha256(error); exit = per-launch id.
- **Send once:** the sender creates `claims/<sha256(id)>` with exclusive create; only the creator sends.
- **Intentional stop:** `stop`/suspend writes `stopping` = current launch id before killing. A marker from an old launch is ignored.
- **Check loop:** each subagent checked in its own try/catch; a vanished folder is skipped.
- New files in the run folder: `claims/`, `stopping`, `tmux/`. New metadata field: `launchId`. Old runs without them still work.

## Tests

- **Regression:** a script runs every existing command and flow against `main` and the new branch, then compares output. Must match except for the table above.
- **New:** one test per bullet in Notifications and Child restrictions.
- End-to-end: real parent pi in tmux.

## Decisions needed

| # | Question | Proposed |
|---|---|---|
| 1 | Child gets a private tmux server | Yes |
| 2 | Block a child's `grep -r ~/.pi/agent`? | Only that folder and `subagents/`; wider searches allowed |
| 3 | Bubblewrap sandbox for children | Later, opt-in, separate change |
