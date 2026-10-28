# pi-subagent v2 spec

## Goal

Subagents never block the parent. Results are injected into the parent's chat when they're ready.

Also: a parent only sees and controls its own subagents.

Not doing: revive, a sandbox, restricting what subagents can do.

## Workflow

```
agent:  subagent spawn ...        → returns immediately
agent:  keeps working, or ends its turn; user keeps chatting
child:  finishes a turn           → writes outbox/<seq>.json
parent ext (1 s poll):            → reads outbox, injects into parent chat, deletes file
agent:  gets "Subagent X finished: <answer>" and reacts
          idle → new turn right away · busy → after its current turn
agent:  subagent send X ...       (optional follow-up; result arrives the same way)
agent:  subagent stop X
```

## Design

### Outbox (child → parent)

- Child extension writes `runDir/outbox/<seq>-<ts>.json` on:
  - `agent_settled` with child idle → `finished` / `failed` (from stopReason)
  - transition to `error` → `failed`
  - `session_shutdown` with reason `quit` → `exited`
- Record: `{ handle, name, seq, kind, stopReason, text, errorMessage?, at }`.
- Text comes from `ctx.sessionManager.getBranch()` (last assistant message), not from re-parsing `session.jsonl`.
- Written tmp + rename, like the inbox. One writer (child), one reader (parent).
- A crash with no `session_shutdown` is detected by the parent instead: tmux gone, not suspended, no stop marker → parent injects `exited` itself.

### Parent watcher

- Runs whenever the session runs, **not** gated on `hasUI`.
- Every 1 s: for each run with `parentSessionId == this session`, read `outbox/*.json` in order.
- All records found in one tick → **one** `pi.sendMessage({ customType: "subagent_result", display: true, ... }, { triggerTurn: true, deliverAs: "followUp" })`.
- Unlink each file **after** `sendMessage`. A parent crash between the two can duplicate a result; it never loses one.
- Each subagent's files are handled in their own try/catch; a run that vanishes is skipped.
- A message renderer for `subagent_result`.

### Lifecycle

- Suspend/quit: the outbox stays on disk. Resume: the watcher drains it, so results produced before the quit are delivered.
- `/reload`: watcher torn down and recreated; nothing lost.
- `stop`: removes the run dir, so no stale results.
- Intentional stop: `stop` and suspend write a `stopping` file before killing, so the parent doesn't report them as a crash.

### Ownership

| Caller | Detected by | Can |
|---|---|---|
| pi session | `PI_SESSION_ID` | spawn; manage its own subagents |
| Child | `PI_SUBAGENT_RUN_DIR` | everything except spawn (as today) |
| Plain terminal, `!` commands | neither | everything (as today) |

Another session's handle → `Unknown subagent` (same as a missing handle).

Children are exempt from this check. A child's bash has its own `PI_SESSION_ID`, so without the exemption it would lose the access it has today.

## CLI changes

| Command | Change |
|---|---|
| `spawn` | Output unchanged, plus one new line: `You'll be notified when it finishes.` |
| `result <handle>` | **New.** Non-blocking: prints the last answer or `X is still running`. |
| `wait` | **OPEN-1** |
| `status`/`send`/`rename`/`stop` | Ownership-scoped for pi sessions; children unchanged |

Everything else stays as today (flags, `list`, widget, `/subagent`, suspend/resume).

## Skill changes

- After `spawn`, hand control back. **Don't call `wait`.** The result arrives as a `subagent_result` message; respond then.
- Use `subagent result X` to check on demand.
- Remove the "bash timeout above 1800 s" line.

## Upstream bugs fixed in this branch

These would make the parent never hear back:

- **Inbox drops messages.** Two messages drained together while the child is idle lose the second. Fix: always pass `deliverAs`, and don't decide based on `isIdle()` when messages arrive back-to-back.
- **Lost metadata writes.** Parent, child and CLI all rewrite the whole `metadata.json`. Fix: new facts (`stopping`, outbox) go in separate files; nothing new is added to metadata.

Other upstream bugs (from the Astra/Fable reviews) stay as they are.

## Tests

- **Regression:** run every existing command and flow against `main` and the branch; output must match, except for the CLI changes above.
- **Unit (fake run folders):** outbox write/read/order, batching, unlink after send, vanished run, ownership, child keeps today's access.
- **Live (real parent pi in tmux):**
  - spawn → parent ends turn → result arrives
  - parent busy → arrives after its turn
  - quit with a pending result → resume → delivered
  - crash → `exited`
  - `stop` → nothing reported

## Decisions needed

| # | Question | Proposed |
|---|---|---|
| 1 | `wait`: remove it, or keep it for users only? | Keep it as-is for plain terminals and scripts; the skill tells the agent not to use it |
| 2 | Results that arrive unprompted start a turn, which costs tokens. Add a setting? | `PI_SUBAGENT_NOTIFY=0` → inject without `triggerTurn` (appears in chat, no new turn) |
| 3 | Register a `spawn_subagent` tool instead of the CLI? | Later |
