// Run: node --experimental-strip-types --no-warnings test/unit.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "psa-unit-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const S = await import("../shared.ts");

let failures = 0;
function check(name: string, ok: boolean): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) failures++;
}

function makeRun(handle: string, patch: Record<string, unknown> = {}) {
	const runDir = join(S.getRunsDir(), handle);
	mkdirSync(join(runDir, "inbox"), { recursive: true });
	writeFileSync(join(runDir, "session.jsonl"), "");
	S.writeMetadata({
		version: 1, handle, runDir, sessionFile: join(runDir, "session.jsonl"), tmuxSession: `pi-subagent-test-${handle}`,
		cwd: "/tmp", provider: "p", model: "m", thinking: "low", state: "idle", hasStarted: true,
		parentSessionId: "parent-A", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch,
	} as never);
	return runDir;
}
const rec = (handle: string, text: string, kind: "finished" | "failed" | "exited" = "finished") =>
	({ handle, kind, text, at: new Date().toISOString() });

// Outbox order and round trip
const a = makeRun("aaa111");
for (let i = 0; i < 12; i++) S.writeOutbox(a, rec("aaa111", `r${i}`));
const read = S.readOutbox(a);
check("outbox keeps write order across 12 records", read.map((e) => e.record.text).join(",") === Array.from({ length: 12 }, (_, i) => `r${i}`).join(","));
S.removeOutboxEntries(read);
check("removeOutboxEntries empties the outbox", S.readOutbox(a).length === 0);

// Invalid records are dropped
writeFileSync(join(S.outboxDir(a), "000-bad.json"), "{not json");
writeFileSync(join(S.outboxDir(a), "001-bad.json"), JSON.stringify({ handle: "x" }));
check("malformed and invalid records are skipped", S.readOutbox(a).length === 0);

// No recreation of removed run dirs
const b = makeRun("bbb222");
rmSync(b, { recursive: true, force: true });
check("writeOutbox on removed run returns false", S.writeOutbox(b, rec("bbb222", "x")) === false);
check("writeOutbox does not recreate run dir", !existsSync(b));
check("updateMetadata on removed run returns undefined", S.updateMetadata(b, { state: "idle" }) === undefined);
check("updateMetadata does not recreate run dir", !existsSync(b));
S.setMarker(b, "stopping");
check("setMarker does not recreate run dir", !existsSync(b));
check("readOutbox on removed run is empty, no throw", S.readOutbox(b).length === 0);

// Markers
const c = makeRun("ccc333");
check("marker absent by default", !S.hasMarker(c, "stopping"));
S.setMarker(c, "stopping");
check("setMarker sets", S.hasMarker(c, "stopping"));
S.clearMarker(c, "stopping");
check("clearMarker clears", !S.hasMarker(c, "stopping"));

// clearExitedRecords keeps real results
S.writeOutbox(c, rec("ccc333", "done", "finished"));
S.writeOutbox(c, rec("ccc333", "bye", "exited"));
S.writeOutbox(c, rec("ccc333", "oops", "failed"));
S.clearExitedRecords(c);
check("clearExitedRecords removes only exited", S.readOutbox(c).map((e) => e.record.kind).join(",") === "finished,failed");

// Cap and kind
check("capResult leaves short text", S.capResult("hi", "h") === "hi");
const long = S.capResult("x".repeat(20_000), "h");
check("capResult cuts long text with pointer", long.length < 8_100 && long.includes("subagent result h"));
check("outcomeKind error → failed", S.outcomeKind("error") === "failed");
check("outcomeKind aborted → failed", S.outcomeKind("aborted") === "failed");
check("outcomeKind stop → finished", S.outcomeKind("stop") === "finished");

// listRuns scoping (used by watcher)
makeRun("ddd444", { parentSessionId: "parent-B" });
check("listRuns(parent-A) excludes parent-B's run", !S.listRuns("parent-A").some((r) => r.handle === "ddd444"));

rmSync(agentDir, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exitCode = failures ? 1 : 0;
