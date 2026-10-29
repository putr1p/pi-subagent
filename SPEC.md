# pi-subagent v2 spec

## Goal

Subagents never block the parent. Results are injected into the parent's chat when they're ready.

Also: a pi session only sees and controls its own subagents.

Not doing: revive, a sandbox, restricting what subagents can do.

## Workflow

```
agent:  subagent spawn ...        → returns immediately
agent:  keeps working, or ends its turn; user keeps chatting
child:  finishes a turn           → writes outbox/<ts>-<seq>.json
parent ext (1 s poll):            → reads outbox, injects into parent chat, deletes file
agent:  gets "Subagent X finished: <answer>" and reacts
          idle → new turn right away · busy → after its current turn
agent:  subagent send X ...       (optional follow-up; result arrives the same way)
agent:  subagent stop X
```

## Design

### Outbox (child → parent)

- Child extension writes `runDir/outbox/<ts>-<seq>.json` (ts and seq zero-padded) on:
  - `agent_settled` with child idle → `finished`, or `failed` if stopReason is `error`/`aborted`
  - `session_shutdown` reason `quit` **and no `stopping` file** → `exited`
- Record: `{ handle, name, kind, stopReason?, text, at }`.
- Text = last assistant message from `ctx.sessionManager.getBranch()`.
- Written tmp + rename. Never recreates a missing run dir.

### Parent-side reports

The parent writes these into the same outbox when the child can't:

| Situation | Report | Once-only marker |
|---|---|---|
| tmux gone, no `stopping`, not suspended, not `starting` younger than 30 s | `exited` | `reported-exit` |
| `hasStarted` false 60 s after spawn, tmux alive | `failed`: "hasn't started; check `tmux attach`" | `reported-nostart` |
| Relaunch on resume fails | `failed` with the error | none (one-shot) |

### Parent watcher

- Runs whenever the parent session runs, in every mode (TUI, RPC, `-p`).
- Every 1 s: for each run with `parentSessionId == this session`, read `outbox/*.json` sorted by name.
- Delivers only when the parent is idle (`ctx.isIdle()`) or mid-turn (`ctx.signal` set); skips the tick while compacting.
- All records from one tick → **one** `pi.sendMessage({ customType: "subagent_result", display: true, ... }, { triggerTurn: true, deliverAs: "followUp" })`.
- Text over 8 KB is cut, with `full answer: subagent result X`.
- Files unlinked **after** `sendMessage`. Best effort: a parent crash can duplicate a result or, rarely, lose one.
- Each run handled in its own try/catch; vanished runs skipped.
- Renderer registered for `subagent_result`.
- `PI_SUBAGENT_NOTIFY=0` → same message without `triggerTurn` (appears in chat, no new turn).

### Lifecycle

- `stop` and suspend write `stopping` before killing, so neither side reports `exited`.
- Resume: delete `stopping` and any `exited` records, then relaunch. Pending `finished`/`failed` records are delivered.
- `/reload`: watcher recreated; nothing lost.
- `stop` removes the run dir. Late child writes must not recreate it.

### Ownership

| Caller | Detected by | Handle commands |
|---|---|---|
| Child | `PI_SUBAGENT_RUN_DIR` | any handle, as today |
| pi session | `PI_SESSION_ID` | own subagents only |
| Plain terminal, `!` commands | neither | any handle, as today |

Another session's handle → `Unknown subagent` (same as a missing handle). Note: after `/new` or `/fork`, the old session's subagents can only be managed from a plain terminal.

### Inbox fix (upstream bug)

Two messages drained in one tick while the child is idle start two runs, and the second is lost. Fix: when idle, send **one** message per tick and wait for `agent_start` before the next. When mid-turn, send all with `deliverAs`.

## CLI changes

| Command | Change |
|---|---|
| `spawn` | Output unchanged, plus a line: `You'll be notified when it finishes.` |
| `result <handle>` | **New.** Non-blocking. Prints the last answer, or `X is still running` / `X exited` / `X failed: …` (exit 1 for the last two). Deletes the outbox records it covered. |
| `wait` | Unchanged. Deletes the outbox records it covered, so no duplicate notice. |
| `status`/`send`/`rename`/`stop` | Scoped for pi sessions (see Ownership) |

Everything else unchanged: flags, output, `list`, widget, `/subagent`, suspend/resume.

## Skill changes

- After `spawn`, hand control back. **Don't call `wait`.** The result arrives as a `subagent_result` message; respond to it then.
- `subagent result X` checks on demand.
- Remove the "bash timeout above 1800 s" line.

## Known, documented

- If you attach to a child and run turns, press Esc, or `/quit` there, the parent is notified.
- With several follow-ups queued, only the final answer is reported.

## Tests

- **Regression:** every existing command and flow against `main` and the branch; output must match except for the CLI changes.
- **Unit (fake run folders):** outbox order, batching, unlink after send, 8 KB cap, vanished run, ownership, child access unchanged, no dir recreation, once-only markers, starting grace period, compaction skip.
- **Live (parent pi in tmux):**
  - spawn → parent ends turn → result arrives
  - parent busy → arrives after its turn
  - two `send`s to an idle child → both run
  - quit with a pending result → resume → delivered, no false `exited`
  - crash → `exited` once
  - `stop` → nothing reported
  - `wait` after a result arrived → no duplicate
  - bad model → "hasn't started" after 60 s

## Later

- A `spawn_subagent` tool in place of the CLI, so there's nothing blocking to call.
