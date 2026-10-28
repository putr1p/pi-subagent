# pi-subagent v2: notifications and ownership

Status: **draft**. Items marked **OPEN** need a decision before implementation.

This spec changes the upstream extension at `4fc1fe5`. Anything it does not mention keeps its upstream behavior.

## 1. Scope

In scope:

1. **Completion notifications.** A parent learns that a child finished, failed, or exited without blocking on `subagent wait`.
2. **Ownership.** Parents and children form a strict tree. A parent manages only its own children. A child manages and messages no one.

Out of scope (explicit non-goals):

- Child-to-child or child-to-parent messaging ("mesh"). A child's only output is its own replies.
- Archive, revive, or `spawn --from-session` (closed PR #2).
- A security boundary against a child that deliberately tries to escape. See §6.1.
- Guaranteed (at-least-once) notification delivery. See §4.4.

## 2. Terms

- **Run**: one subagent, stored in `~/.pi/agent/subagents/<handle>/` (the *run dir*).
- **Parent**: the Pi session whose ID is recorded as `parentSessionId` when the run is spawned.
- **Caller**: the process invoking the `subagent` CLI. Its **caller session** is `PI_SESSION_ID` from its environment, if set.
- **Child context**: a process whose environment has `PI_SUBAGENT_RUN_DIR` set. The extension sets it when launching the child in tmux (`launchRun`). The bash tool inherits it, so every child tool process has it.
- **Outcome**: a reportable result of a run (§4.1).
- **Delivery**: injecting an outcome into the parent session as a `subagent-result` message.

Facts about Pi 1.4.0 this spec relies on:

- The bash tool sets `PI_SESSION_ID` from the *current* session on every execution, and removes any inherited value (`core/tools/bash.js` `resolveSpawnContext`). After `/new`, `/fork`, or `/resume` in the parent, later bash calls carry the new session's ID.
- User-typed `!` and `!!` commands do not receive `PI_SESSION_ID`.
- File tools strip a leading `@` and expand `~` before resolving paths relative to cwd (`core/tools/path-utils.js` `resolveToCwd`).
- `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` returns `void`. It starts a turn if the parent is idle and queues the message in memory if the parent is busy. There is no delivery acknowledgement.

## 3. Ownership

### 3.1 Caller classes

Every CLI invocation is classified before parsing the subcommand:

| Class | Condition | Allowed |
|---|---|---|
| **Child** | `PI_SUBAGENT_RUN_DIR` set | Nothing. Every subcommand fails with `subagent commands are not available inside a subagent`. |
| **Parent** | `PI_SESSION_ID` set, not a child | `spawn`; handle commands and `list` scoped to runs where `parentSessionId == PI_SESSION_ID`. |
| **Operator** | Neither variable set, and `--operator` given | Handle commands and `list` on any run. |
| **Anonymous** | Neither variable set, no `--operator` | Nothing; fails with a message pointing to `--operator`. |

Rules:

- R3.1: `--operator` is recognized **only as the first argument** (`subagent --operator <command> ...`). Anywhere else it is ordinary data (a name, a message word).
- R3.2: `--operator` with `PI_SESSION_ID` set fails with `--operator is only allowed outside a Pi session`. With `PI_SUBAGENT_RUN_DIR` set, the child rule wins.
- R3.3: A handle that does not exist and a handle owned by another session produce the **same** error, `Unknown subagent: <handle>`, so other sessions' runs are not revealed.
- R3.4: `spawn` requires a parent caller. **OPEN-1:** may an operator spawn? Proposed: **no**. A run nobody owns gets no notifications and is never suspended, so every spawn needs an owning session.
- R3.5: Ownership never changes after spawn. Nothing reassigns `parentSessionId`.

### 3.2 Session changes in the parent

- R3.6: `/new`, `/fork`, and `/resume` of another session replace the parent session, so upstream `session_shutdown` suspends the old session's running children. The new session does not own them: they are not listed, notified, or manageable from it.
- R3.7: Resuming the original session relaunches its suspended children (upstream) and restores ownership, because its `PI_SESSION_ID` matches again. `/reload` changes nothing.
- R3.8: User `!` commands are anonymous callers (§2), so they need `--operator`. Document this.

## 4. Notifications

### 4.1 Outcomes

The parent extension evaluates each owned run once per poll (every 1 s). A run has at most one current outcome:

| Kind | When | Key |
|---|---|---|
| `finished` | State `idle`, `hasStarted`, inbox empty, latest assistant entry on the active branch has `stopReason` other than `error`/`aborted` | `entry:<assistantEntryId>` |
| `failed` | Same as `finished` but `stopReason` is `error`/`aborted`; **or** metadata state `error` | `entry:<id>` for the former; `error:<lastAssistantEntryId or none>:<sha256(errorText)>` for the latter |
| `exited` | tmux session gone, run not suspended, no stop intent (§5) | `exit:<launchId>` |

- R4.1: Keys depend only on facts that do not change on rename or other metadata updates.
- R4.2: `launchId` is a random ID written to metadata each time the child process is launched (spawn or resume relaunch). It makes each process lifetime produce at most one `exited` outcome.
- R4.3: Hashes are full SHA-256 hex. No truncation.

### 4.2 Debounce

- R4.4: An outcome is delivered only after it is the current outcome on **two consecutive polls** of the same parent process. This keeps a child that idles briefly between queued messages from triggering a report.

### 4.3 Claims (exactly one deliverer)

- R4.5: Before delivering, the deliverer creates `<runDir>/claims/<sha256(key)>` with exclusive create (`O_EXCL`). Only the process that creates it delivers. If it already exists, or the create fails for any reason, the outcome is not delivered.
- R4.6: Claiming must not recreate a removed run dir. `claims/` is created non-recursively; if the run dir is gone, the claim fails.
- R4.7: `subagent wait`, run by the **owning parent**, claims the exact outcome it returns, using the key it computed from what it printed, not a second evaluation. Operator `wait` never claims.
- R4.8: **OPEN-2:** if the owner's `wait` loses the claim because the poller already queued a notification, what does `wait` do? Options:
  - **(a)** Print the result anyway. `wait` is a read and may return a result that was also notified. Docs say "notifications are deduplicated against each other; `wait` may repeat one".
  - **(b)** Print the result with a marker line `(already delivered as a notification)`.

  Proposed: **(b)**. The agent sees it happened and nothing is hidden.
- R4.9: Claim files are removed with the run dir on `stop`. Their growth is bounded by the number of outcomes in the run's lifetime. This is acceptable and documented.

### 4.4 Delivery semantics

- R4.10: Delivery is **at most once** per outcome, across all processes.
- R4.11: A delivery can be lost in these cases, and the docs must list them:
  1. Claimed while the parent is busy, then the parent quits or its queue is cleared (Esc) before the follow-up runs.
  2. The parent quits or switches session between the first and second debounce poll.

  Recovery in both cases is `subagent wait` or `subagent status`.
- R4.12: On resume of a suspended child, its latest assistant entry at that moment is claimed **before** relaunch, so old history is not reported as new.
- R4.13: Notification text is the assistant text, truncated at 20 000 characters with a pointer to `subagent wait <handle>`.
- R4.14: `PI_SUBAGENT_NOTIFY=0|off|false|no` in the parent's environment disables polling and delivery. The rest of the behavior is unchanged.

### 4.5 Robustness

- R4.15: The poll callback never throws. Each run is evaluated in its own error boundary. A run that disappears mid-poll is skipped.
- R4.16: A failed claim (R4.5) is never retried in a way that resends. The next poll sees the claim or the missing run and skips it.

### 4.6 Upgrade

- R4.17: **OPEN-3:** runs created by earlier unreleased builds may contain a `reported` file. Proposed: **ignore it**. Those builds were never merged, and the only such runs are local test runs. The PR must not ship migration code for unreleased formats.

## 5. Lifecycle and stop intent

- R5.1: Stop intent is the file `<runDir>/stopping` containing the current `launchId`. It is kept outside `metadata.json` because the child rewrites that file concurrently.
- R5.2: `subagent stop` and parent suspension write stop intent **before** killing tmux.
- R5.3: An `exited` outcome is suppressed only if `stopping` contains the run's current `launchId`. Intent left over from an earlier, failed stop attempt names an older launch and is ignored.
- R5.4: Every launch (spawn, resume relaunch) writes a fresh `launchId`, which invalidates any old intent.
- R5.5: Exits not covered by R5.3 are reported as `exited`. That includes crash, SIGTERM/SIGHUP, `tmux kill-session`, `/quit` typed inside an attached child, and the child writing `state: exited` itself.
- R5.6: `stop` keeps upstream behavior: it removes the run dir after shutdown (no archive).

## 6. Child restrictions

### 6.1 Threat model

Goal: keep a child from *accidentally* or *naively* reaching other runs, because of a confused model or a careless instruction. Not a goal: stopping a child that deliberately tries to escape (for example by `cat`-ing files through bash or pointing tmux at the real socket). All runs share one Unix user. Docs must say so plainly and recommend OS-level sandboxing (e.g. bubblewrap) for untrusted input.

### 6.2 Enforced restrictions

| # | Restriction | Mechanism |
|---|---|---|
| R6.1 | No `subagent` CLI use | CLI refuses in child context (§3.1). No bash text matching. |
| R6.2 | No access to the parent's tmux server | Child is launched with `TMUX_TMPDIR=<runDir>/tmux`, so `tmux` inside the child talks to an empty private server. |
| R6.3 | File tools cannot reach other runs | `tool_call` hook on `read`, `write`, `edit`, `grep`, `find`, `ls` (§6.3) |
| R6.4 | File tools cannot modify the run root | `write`/`edit` under `~/.pi/agent/subagents/` are blocked, **including the child's own run dir** (its metadata, inbox, and claims are infrastructure). |

**OPEN-4:** R6.2 changes what `tmux` means inside a child. A child doing legitimate work that uses tmux, such as testing a tmux-based tool, gets the private server. That seems fine, but confirm.

### 6.3 Path rules for file tools

- R6.5: Paths are normalized the way Pi does it: strip a leading `@`, expand `~`, resolve relative to the tool's cwd, normalize `..`.
- R6.6: An omitted `path` means the tool's default (cwd), and is checked like any other path.
- R6.7: `read`: blocked if the target is inside another run's dir.
- R6.8: `grep`, `find`, `ls`: blocked if the target is inside another run's dir, **or** if the target is an ancestor of the runs root (e.g. `~/.pi/agent`, `~`, `/`) and the search is recursive. **OPEN-5:** blocking `grep -r ~` or `find /` from a child is a real restriction on normal work. Alternative: allow it and accept that recursive searches can see other runs. Proposed: **block only when the target is the runs root itself or `~/.pi/agent`**, and accept broader searches (like `~` or `/`) as outside the threat model (§6.1).
- R6.9: The child's *own* run dir is readable (its transcript), not writable (R6.4).

### 6.4 Not enforced (documented)

- Bash commands that read or write run dirs, or use the real tmux socket via `-S`/`-L`.
- Reading other runs through recursive searches that R6.8 allows.

## 7. CLI surface changes

| Command | Change |
|---|---|
| all | Caller classification (§3.1); `--operator` as first argument only |
| `spawn` | Requires a parent caller (R3.4); writes `launchId`; launches with `TMUX_TMPDIR` |
| `status`, `send`, `wait`, `rename`, `stop` | Ownership-scoped (R3.3) |
| `wait` | Owner claims the outcome it returns (R4.7, R4.8) |
| `stop` | Writes stop intent before kill (R5.2) |
| `list` | Parent: own runs. Operator: all runs. Anonymous: error |

No new subcommands.

## 8. Acceptance tests

Each rule gets at least one automated test. Tests that need no model use a temporary `PI_CODING_AGENT_DIR` and fake run dirs. Live tests use a real parent Pi in tmux with a small model.

| Test | Rules |
|---|---|
| Child context: every subcommand refused, including `--operator` | R3.1, R6.1 |
| Other session's handle → `Unknown subagent`, same text as a missing handle | R3.3 |
| `--operator` only as the first argument; `send h hello --operator` sends the literal text | R3.1 |
| `--operator` inside a session refused; anonymous refused | R3.2 |
| Spawn without a session refused | R3.4 |
| Keys stable across rename; error key changes when the error text changes | R4.1 |
| Each new launch produces a new `exit` key | R4.2 |
| Two-poll debounce | R4.4 |
| 4 processes × N keys concurrently → each key claimed exactly once | R4.5 |
| Claim on removed run dir fails and does not recreate it | R4.6 |
| Owner `wait` claims exactly the printed outcome; operator `wait` claims nothing | R4.7 |
| Owner `wait` after the poller claimed it prints the marker | R4.8 |
| Resume does not re-report old history | R4.12 |
| Poller survives a run dir removed mid-poll | R4.15 |
| `stop` → no `exited`; stale `stopping` from an old launch does not suppress a later crash | R5.3, R5.4 |
| SIGTERM, `tmux kill-session`, child `/quit` → `exited` | R5.5 |
| Child `tmux ls` sees only the private server | R6.2 |
| `@path`, `~`, relative, `..`, omitted path all normalized and checked | R6.5, R6.6 |
| Child can read its own transcript; cannot write its own metadata | R6.4, R6.9 |
| Normal child work unaffected: `grep -E '(tmux\|subagent)'`, heredocs mentioning those words, editing files in the repo | §6 (no false positives) |
| Live: spawn → parent ends turn → notification arrives and starts a turn | §4 |
| Live: parent busy → notification arrives after its turn | R4.10 |

## 9. Documentation requirements

README and SKILL.md must:

- Describe delivery as at-most-once and list the loss cases (R4.11).
- Describe what `wait` does when a notification already went out (R4.8).
- State the threat model (§6.1) and list exactly what is and isn't enforced (§6.2, §6.4). No claims like "children have no channel" that go beyond §6.2.
- Explain `--operator` and that `!` commands need it (R3.8).

## 10. Open questions (summary)

| ID | Question | Proposed |
|---|---|---|
| OPEN-1 | May an operator spawn? | No |
| OPEN-2 | Owner `wait` after the poller already delivered | Print with a marker line |
| OPEN-3 | Migrate `reported` files from unreleased builds? | No, ignore |
| OPEN-4 | Private tmux server per child | Yes |
| OPEN-5 | How broad is the recursive-search block? | Only the runs root and `~/.pi/agent` |
