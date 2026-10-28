import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import {
	assistantText,
	effectiveRunState,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	tmuxSessionExists,
	updateMetadata,
	waitForRunShutdown,
	writeOutbox,
	hasMarker,
	setMarker,
	clearMarker,
	outcomeKind,
	capResult,
	readOutbox,
	removeOutboxEntries,
	clearExitedRecords,
	type OutboxEntry,
	type OutboxRecord,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

const RESULT_MESSAGE_TYPE = "subagent_result";
/** A run still `starting` this long after its last metadata write, with no tmux session, has died. */
const STARTING_GRACE_MS = 30_000;
/** A child that has not started its first turn this long after spawn is reported once. */
const NO_START_MS = 60_000;

/** PI_SUBAGENT_NOTIFY=0 delivers results into the chat without starting a turn. */
function notificationsTriggerTurn(): boolean {
	const value = process.env.PI_SUBAGENT_NOTIFY?.trim().toLowerCase();
	return !(value === "0" || value === "off" || value === "false" || value === "no");
}

function formatResult(record: OutboxRecord): string {
	const label = record.name ? `${record.name} (${record.handle})` : record.handle;
	const heading =
		record.kind === "finished"
			? `Subagent ${label} finished:`
			: record.kind === "failed"
				? `Subagent ${label} failed${record.stopReason ? ` (${record.stopReason})` : ""}:`
				: `Subagent ${label} exited:`;
	return `${heading}\n\n${capResult(record.text, record.handle)}`;
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		// ---- Result watcher: delivers outbox records of this session's children into the parent chat. ----
		let watchTimer: ReturnType<typeof setInterval> | undefined;
		let watchContext: ExtensionContext | undefined;
		const triggerTurn = notificationsTriggerTurn();

		const ageMs = (iso: string | undefined): number => (iso ? Date.now() - Date.parse(iso) : 0);

		/** Reports the child cannot write itself: an unexpected death, or a child that never started. */
		const writeParentReports = (run: RunMetadata): void => {
			const state = effectiveRunState(run);
			if (state === "exited") {
				if (run.suspended || hasMarker(run.runDir, "stopping") || hasMarker(run.runDir, "reported-exit")) return;
				// tmux is created right after metadata on spawn and relaunch; don't mistake that gap for a death.
				if (run.state === "starting" && ageMs(run.updatedAt) < STARTING_GRACE_MS) return;
				setMarker(run.runDir, "reported-exit");
				writeOutbox(run.runDir, {
					handle: run.handle,
					name: run.name,
					kind: "exited",
					text: "The subagent process ended unexpectedly (crashed or was killed).",
					at: new Date().toISOString(),
				});
				return;
			}
			if (!run.hasStarted && state !== "error" && ageMs(run.createdAt) > NO_START_MS) {
				if (hasMarker(run.runDir, "reported-nostart")) return;
				setMarker(run.runDir, "reported-nostart");
				writeOutbox(run.runDir, {
					handle: run.handle,
					name: run.name,
					kind: "failed",
					text: `The subagent has not started after ${NO_START_MS / 1000} s. Check it with: tmux attach -t ${run.tmuxSession}`,
					at: new Date().toISOString(),
				});
			}
		};

		const deliverResults = (): void => {
			const ctx = watchContext;
			if (!ctx) return;
			try {
				// Deliver while idle or mid-turn; skip while compacting (idle is false and no run is active).
				if (!ctx.isIdle() && ctx.signal === undefined) return;
				const entries: OutboxEntry[] = [];
				for (const run of listRuns(ctx.sessionManager.getSessionId())) {
					try {
						writeParentReports(run);
						entries.push(...readOutbox(run.runDir));
					} catch {
						// Run changing underneath us; retried next tick.
					}
				}
				if (entries.length === 0) return;
				const records = entries.map((entry) => entry.record);
				pi.sendMessage(
					{
						customType: RESULT_MESSAGE_TYPE,
						content: records.map(formatResult).join("\n\n---\n\n"),
						display: true,
						details: { results: records.map(({ handle, name, kind }) => ({ handle, name, kind })) },
					},
					triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
				);
				removeOutboxEntries(entries);
			} catch {
				// Never let a delivery problem escape the timer.
			}
		};

		pi.registerMessageRenderer(RESULT_MESSAGE_TYPE, (message, options, theme) => {
			const text = typeof message.content === "string" ? message.content : contentText(message.content);
			const lines = text.split("\n");
			const shown = options.expanded || lines.length <= 12 ? lines : [...lines.slice(0, 12), "…"];
			const [first, ...rest] = shown;
			return new Text([theme.fg("accent", first ?? ""), ...rest].join("\n"), 1, 0);
		});

		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended || tmuxSessionExists(run.tmuxSession)) continue;
				if (!existsSync(run.sessionFile)) {
					removeRunDir(run.runDir);
					continue;
				}
				// The suspend was intentional: drop its stop marker and any exit it produced.
				clearMarker(run.runDir, "stopping");
				clearMarker(run.runDir, "reported-exit");
				clearExitedRecords(run.runDir);
				const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
				try {
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					writeOutbox(run.runDir, {
						handle: run.handle,
						name: run.name,
						kind: "failed",
						text: `Could not resume the subagent: ${message}`,
						at: new Date().toISOString(),
					});
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			// The watcher runs in every mode (TUI, RPC, print); only the widget needs a UI.
			watchContext = ctx;
			if (!watchTimer) {
				watchTimer = setInterval(deliverResults, 1000);
				watchTimer.unref();
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (watchTimer) clearInterval(watchTimer);
			watchTimer = undefined;
			watchContext = undefined;
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!tmuxSessionExists(run.tmuxSession)) {
					if (!run.suspended) removeRunDir(run.runDir);
					continue;
				}
				updateMetadata(run.runDir, { suspended: true });
				// Marker file too: the child may overwrite metadata concurrently and drop `suspended`.
				setMarker(run.runDir, "stopping");
				spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
				await waitForRunShutdown(run.runDir);
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	// Set once a message has been handed to an idle child and cleared on agent_start. While set, the
	// child is about to start a run but still reports idle, so no further message may be sent as a new
	// prompt: Pi would start a second run and drop it.
	// Expires after 15 s: if Pi rejects the prompt internally (e.g. auth failure), agent_start never fires.
	let promptPendingSince: number | undefined;
	const PROMPT_PENDING_MS = 15_000;

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const idle = currentContext.isIdle();
				// Idle child: send exactly one message, then wait for agent_start before the next.
				if (idle && promptPendingSince !== undefined && Date.now() - promptPendingSince < PROMPT_PENDING_MS) return;
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (idle) {
						promptPendingSince = Date.now();
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					promptPendingSince = undefined;
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				if (idle) return;
			}
		} finally {
			processing = false;
		}
	};

	const lastAssistant = (ctx: ExtensionContext): { text: string; stopReason?: string } | undefined => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message as Parameters<typeof assistantText>[0] & { stopReason?: string };
			return { text: assistantText(message), stopReason: message.stopReason };
		}
		return undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		promptPendingSince = undefined;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (!ctx.isIdle()) return;
		const metadata = updateMetadata(runDir, { state: "idle" });
		const last = lastAssistant(ctx);
		if (!metadata || !last) return;
		writeOutbox(runDir, {
			handle: metadata.handle,
			name: metadata.name,
			kind: outcomeKind(last.stopReason),
			stopReason: last.stopReason,
			text: last.text,
			at: new Date().toISOString(),
		});
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason !== "quit") return;
		const metadata = updateMetadata(runDir, { state: "exited" });
		// Intentional stop or suspend: nothing to report.
		if (!metadata || hasMarker(runDir, "stopping")) return;
		writeOutbox(runDir, {
			handle: metadata.handle,
			name: metadata.name,
			kind: "exited",
			text: "The subagent process ended (it quit, or its tmux session was killed).",
			at: new Date().toISOString(),
		});
		// The parent must not report this exit a second time.
		setMarker(runDir, "reported-exit");
	});
}
