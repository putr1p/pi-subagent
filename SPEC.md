# pi-subagent v2 spec

## Goal

1. **Notify:** when a subagent finishes, the parent is told automatically. No blocking `wait`.
2. **Own:** a parent sees and controls only its own subagents. A subagent can't control or message anyone.

Not doing: subagent↔subagent messaging, revive, a real sandbox.

## Workflow

```
parent: subagent spawn ...      → returns immediately
parent: keeps working / chatting
child:  finishes
parent: gets "Subagent X finished: <answer>" as a message
        idle → reacts right away · busy → after its current turn
parent: subagent stop X
```

## Who can do what

| Caller | How it's detected | Can |
|---|---|---|
| Parent | `PI_SESSION_ID` set | spawn; manage its own subagents |
| Child | `PI_SUBAGENT_RUN_DIR` set | nothing |
| Operator (you, plain terminal) | `subagent --operator ...` | manage any subagent; not spawn |
| Anything else | | nothing |

- Another session's subagent → `Unknown subagent` (same as nonexistent).
- `--operator` only counts as the first argument.
- `!` commands in pi count as plain terminal → need `--operator`.

## Notifications

- Sent for: **finished**, **failed**, **exited** (crashed / killed, not `stop`).
- Each result is sent **once at most**. Never twice, even with two pi windows on one session.
  - Rarely it's sent **zero** times: you quit or press Esc while it's queued. Get it with `subagent wait`.
- Sent after the result is seen on 2 checks in a row (1 s apart), so a brief idle doesn't trigger it.
- Rename doesn't resend. Resuming a session doesn't resend old results.
- If you `wait` on a result that was already notified, `wait` still prints it, with a note.
- Long answers are cut at 20k chars; `wait` has the full text.
- `PI_SUBAGENT_NOTIFY=0` turns it off.

## Child restrictions

Guardrails against mistakes, not a sandbox. A child that deliberately tries can get around them.

- `subagent` command refuses to run inside a child.
- Child gets its own private tmux server, so it can't touch yours.
- File tools can't read other subagents' folders or write anywhere in `~/.pi/agent/subagents/`.
- Normal work (grep, editing repo files, heredocs) is not affected.

## How it works (implementation notes)

- **Result IDs:** finished/failed = assistant entry id; error = entry id + hash of error; exit = per-launch id.
- **Send once:** the sender creates `claims/<sha256(id)>` with exclusive create; only the creator sends.
- **Intentional stop:** `stop` / suspend writes `stopping` = current launch id before killing. A stale marker from an old launch is ignored.
- **Check loop:** each subagent checked in its own try/catch; a vanished folder is skipped.

## Tests

Every bullet above gets a test. Fake run folders for logic; a real parent pi in tmux for end-to-end.

## Decisions needed

| # | Question | Proposed |
|---|---|---|
| 1 | Can operator spawn? | No |
| 2 | `wait` on an already-notified result | Print it with a note |
| 3 | Child gets a private tmux server | Yes |
| 4 | Block `grep -r ~/.pi/agent` from a child? | Yes, only that folder and `~/.pi/agent/subagents/`; wider searches allowed |
