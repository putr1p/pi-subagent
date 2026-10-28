// Run: node --experimental-strip-types --no-warnings test/watcher.test.ts  (needs tmux, and the pi packages resolvable)
// Drives deliverResults' guard with a fake ctx: idle=false & signal=undefined (compacting) must not send.
const sent: unknown[] = [];
let idle = false; let signal: AbortSignal | undefined = undefined;
const handlers: Record<string, Function> = {};
const pi: any = {
	on: (ev: string, h: Function) => (handlers[ev] = h), registerCommand() {}, registerMessageRenderer() {},
	sendMessage: (m: unknown) => sent.push(m), setSessionName() {},
};
const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
const agentDir = mkdtempSync(join(tmpdir(), "psa-cmp-")); process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_SUBAGENT_RUN_DIR;
const S = await import("../shared.ts");
const runDir = join(S.getRunsDir(), "cmp111"); mkdirSync(join(runDir, "inbox"), { recursive: true });
writeFileSync(join(runDir, "session.jsonl"), "");
const { spawnSync } = await import("node:child_process"); spawnSync("tmux", ["new-session", "-d", "-s", "pi-subagent-cmp111", "sleep", "30"]);
S.writeMetadata({ version: 1, handle: "cmp111", runDir, sessionFile: join(runDir, "session.jsonl"), tmuxSession: "pi-subagent-cmp111", cwd: "/tmp", provider: "p", model: "m", thinking: "low", state: "idle", hasStarted: true, parentSessionId: "P1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
S.writeOutbox(runDir, { handle: "cmp111", kind: "finished", text: "X", at: "" });
const ext = (await import("../index.ts")).default; ext(pi);
const ctx: any = { isIdle: () => idle, get signal() { return signal; }, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "P1" } };
await handlers["session_start"]({}, ctx);
await new Promise((r) => setTimeout(r, 2300));
console.log(`compacting: sent=${sent.length} outbox=${S.readOutbox(runDir).length}  ${sent.length === 0 ? "PASS" : "FAIL"}`);
idle = true; await new Promise((r) => setTimeout(r, 1300));
console.log(`idle:       sent=${sent.length} outbox=${S.readOutbox(runDir).length}  ${sent.length === 1 ? "PASS" : "FAIL"}`);
spawnSync("tmux", ["kill-session", "-t", "pi-subagent-cmp111"]); process.exit(0);
