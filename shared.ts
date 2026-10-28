import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	writeMetadataFile(metadata);
}

/** Replace metadata of an existing run. Never recreates a run directory that `stop` already removed. */
function writeMetadataFile(metadata: RunMetadata): void {
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	try {
		writeMetadataFile(next);
	} catch {
		return undefined; // Run directory removed concurrently.
	}
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function tmuxSessionExists(session: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Start the child pi process for a run in its tmux session. `initialArgs` are only passed on first spawn. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const result = spawnSync(
		"tmux",
		[
			"new-session",
			"-d",
			"-s",
			metadata.tmuxSession,
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			metadata.cwd,
			"--",
			"env",
			`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
			launcher,
			"--session",
			metadata.sessionFile,
			"--provider",
			metadata.provider,
			"--model",
			metadata.model,
			"--thinking",
			metadata.thinking,
			...(metadata.launchArgs ?? []),
			...initialArgs,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!tmuxSessionExists(metadata.tmuxSession)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}

// ---------------------------------------------------------------------------------------------------------------
// Outbox: results flowing from a child (or the parent on its behalf) to the parent session.

export type OutboxKind = "finished" | "failed" | "exited";

export interface OutboxRecord {
	handle: string;
	name?: string;
	kind: OutboxKind;
	stopReason?: string;
	text: string;
	at: string;
}

export function outboxDir(runDir: string): string {
	return join(runDir, "outbox");
}

let outboxSeq = 0;

/** Append a record. Returns false if the run directory no longer exists; never recreates it. */
export function writeOutbox(runDir: string, record: OutboxRecord): boolean {
	if (!existsSync(runDir)) return false;
	try {
		const dir = outboxDir(runDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const ts = String(Date.now()).padStart(15, "0");
		const seq = String(outboxSeq++ % 1_000_000).padStart(6, "0");
		const target = join(dir, `${ts}-${seq}-${process.pid}.json`);
		const temporary = `${target}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, target);
		return true;
	} catch {
		return false;
	}
}

export interface OutboxEntry {
	path: string;
	record: OutboxRecord;
}

function isOutboxRecord(value: unknown): value is OutboxRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.handle === "string" &&
		typeof record.text === "string" &&
		(record.kind === "finished" || record.kind === "failed" || record.kind === "exited")
	);
}

/** Records in delivery order. Unreadable files are removed. Never throws. */
export function readOutbox(runDir: string): OutboxEntry[] {
	let names: string[];
	try {
		names = readdirSync(outboxDir(runDir))
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		return [];
	}
	const entries: OutboxEntry[] = [];
	for (const name of names) {
		const path = join(outboxDir(runDir), name);
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isOutboxRecord(value)) entries.push({ path, record: value });
			else rmSync(path, { force: true });
		} catch {
			// Vanished or partially visible; skip this tick.
		}
	}
	return entries;
}

export function removeOutboxEntries(entries: OutboxEntry[]): void {
	for (const entry of entries) rmSync(entry.path, { force: true });
}

/** Remove pending `exited` records (used on resume, where the exit was an intentional suspend). */
export function clearExitedRecords(runDir: string): void {
	removeOutboxEntries(readOutbox(runDir).filter((entry) => entry.record.kind === "exited"));
}

// ---------------------------------------------------------------------------------------------------------------
// Marker files. Kept outside metadata.json, which parent, child and CLI all rewrite concurrently.

export type Marker = "stopping" | "reported-exit" | "reported-nostart";

export function hasMarker(runDir: string, marker: Marker): boolean {
	return existsSync(join(runDir, marker));
}

export function setMarker(runDir: string, marker: Marker): void {
	if (!existsSync(runDir)) return;
	try {
		writeFileSync(join(runDir, marker), "", { mode: 0o600 });
	} catch {
		// Run removed concurrently.
	}
}

export function clearMarker(runDir: string, marker: Marker): void {
	rmSync(join(runDir, marker), { force: true });
}

// ---------------------------------------------------------------------------------------------------------------

export const MAX_RESULT_CHARS = 8_000;

export function capResult(text: string, handle: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated; full answer: subagent result ${handle}]`;
}

export function outcomeKind(stopReason: string | undefined): "finished" | "failed" {
	return stopReason === "error" || stopReason === "aborted" ? "failed" : "finished";
}
