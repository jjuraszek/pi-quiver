import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, FooterComponent, initTheme, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type CustomEntry, type ExtensionContext, type ExtensionFactory, type ExtensionUIContext, type Theme,
} from "@earendil-works/pi-coding-agent";

import { formatTime } from "../extensions/message-timestamps.ts";

async function timestampSession(t: TestContext, managerFor: (cwd: string) => SessionManager = SessionManager.inMemory,
	options: {
		cwd?: string;
		tools?: string[];
		mode?: ExtensionContext["mode"];
		beforeBind?: (session: AgentSession) => void;
		extensionFactories?: ExtensionFactory[];
	} = {}) {
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "message-timestamps-"));
	const agentDir = join(cwd, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (!options.cwd) rmSync(cwd, { recursive: true, force: true });
	});
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const sessionManager = managerFor(cwd);
	const settingsManager = options.beforeBind ? SettingsManager.create(cwd, agentDir) : SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
		noThemes: true, noContextFiles: true, extensionFactories: options.extensionFactories,
		additionalExtensionPaths: [join(import.meta.dirname, "../extensions/message-timestamps.ts")],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, sessionManager, settingsManager, tools: options.tools ?? [],
	});
	t.after(() => session.dispose());
	const statuses = new Map<string, string>();
	const setStatus = t.mock.fn((key: string, text?: string) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
	});
	const notify = t.mock.fn();
	options.beforeBind?.(session);
	await session.bindExtensions({
		mode: options.mode ?? "tui",
		uiContext: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus, notify,
		} as unknown as ExtensionUIContext,
	});
	return { session, sessionManager, faux, statuses, setStatus, notify, cwd };
}

test("footer follows the prompt and the final reply", async (t) => {
	const { session, sessionManager, faux, statuses } = await timestampSession(t);
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	let promptStatus: string | undefined;
	faux.setResponses([() => {
		promptStatus = statuses.get("message-timestamps");
		t.mock.timers.tick(60_000);
		return fauxAssistantMessage("Done.");
	}]);
	await session.prompt("What time is it?");
	const messages = sessionManager.getBranch().filter((entry) => entry.type === "message").slice(-2);
	assert.deepEqual(messages.map((entry) => entry.message.role), ["user", "assistant"]);
	const format = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	const expected = messages.map((entry) => `last message ${format.format(new Date(entry.timestamp))}`);
	assert.notEqual(expected[0], expected[1]);
	assert.deepEqual([promptStatus, statuses.get("message-timestamps")], expected);
});

test("default writes no record", async (t) => {
	const { session, sessionManager, faux } = await timestampSession(t, (cwd) => SessionManager.create(cwd, join(cwd, "sessions")));
	const liveCustomTypes: string[] = [];
	t.after(session.subscribe((event) => {
		if (event.type === "entry_appended" && event.entry.type === "custom") liveCustomTypes.push(event.entry.customType);
	}));
	faux.setResponses([fauxAssistantMessage("Done.")]);
	await session.prompt("What time is it?");

	const entries = SessionManager.open(sessionManager.getSessionFile()!).getEntries();
	const messages = entries.filter((entry) => entry.type === "message").slice(-2);
	assert.deepEqual(messages.map((entry) => entry.message.role), ["user", "assistant"]);
	assert.equal(entries.some((entry) => entry.type === "custom" && entry.customType === "message-timestamp"), false);
	assert.equal(liveCustomTypes.includes("message-timestamp"), false);
});

function renderRecord(session: AgentSession, entry: CustomEntry) {
	const theme = { fg: (color: string, text: string) => `${color}:${text}` } as Theme;
	return session.extensionRunner.getEntryRenderer(entry.customType)?.(entry,
		{ expanded: false, keyText: () => "", keyHint: () => "" }, theme)?.render(80).map((line) => line.trim());
}

test("multi-tool run writes two records in order", async (t) => {
	const { session, sessionManager, faux, statuses, cwd } = await timestampSession(t, (cwd) => {
		projectSettings(cwd, { transcript: true });
		return SessionManager.create(cwd, join(cwd, "sessions"));
	}, { tools: ["read"] });
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	const live: string[] = [];
	const rendered: (string[] | undefined)[] = [];
	t.after(session.subscribe((event) => {
		if (event.type === "message_end") {
			live.push(event.message.role);
			t.mock.timers.tick(60_000);
		} else if (event.type === "entry_appended" && event.entry.type === "custom") {
			live.push(event.entry.customType);
			rendered.push(renderRecord(session, event.entry));
		}
	}));
	const toolStatuses: (string | undefined)[] = [];
	const requests: string[] = [];
	const capture = (context: TranscriptContext) => requests.push(JSON.stringify(context.messages));
	faux.setResponses([
		...[1, 2, 3].map((id) => (context: TranscriptContext) => {
			capture(context);
			return fauxAssistantMessage(fauxToolCall("read", { path: ".pi/settings.json" }, { id: `read-${id}` }), { stopReason: "toolUse" });
		}),
		async (context) => {
			capture(context);
			toolStatuses.push(statuses.get("message-timestamps"));
			for (const state of ["off", "on"]) {
				await session.prompt(`/timestamps footer ${state}`);
				toolStatuses.push(statuses.get("message-timestamps"));
			}
			return fauxAssistantMessage("Done.");
		},
	]);
	await session.prompt("Read the settings three times.");
	const branch = sessionManager.getBranch();
	const start = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
	const order = ["user", "message-timestamp", "assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult", "assistant", "message-timestamp"];
	assert.deepEqual(branch.slice(start).map((entry) => entry.type === "message" ? entry.message.role : entry.type === "custom" ? entry.customType : entry.type), order);
	assert.deepEqual(live.slice(live.indexOf("user")), order);
	const records = branch.filter((entry) => entry.type === "custom" && entry.customType === "message-timestamp");
	assert.deepEqual(rendered, records.map((entry) => [`dim:${formatTime(new Date(entry.timestamp))}`]));
	const results = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
	assert.ok(results.every((entry) => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError));
	const expected = `last message ${formatTime(new Date(results.at(-1)!.timestamp))}`;
	assert.deepEqual(toolStatuses, [expected, undefined, expected]);
	assert.equal(requests.length, 4);

	await t.test("resume replays records with original times", async (subtest) => {
		t.mock.timers.tick(86_400_000);
		const times = rendered.map((lines) => lines![0]);
		const expected = live.slice(live.indexOf("user")).map((item) => item === "message-timestamp" ? times.shift()! : item);
		const checkReplay = (session: AgentSession) => {
			const rows = session.sessionManager.buildContextEntries().flatMap((entry) => entry.type === "custom" ? renderRecord(session, entry) ?? [] :
				entry.type === "message" ? [entry.message.role] : []);
			assert.deepEqual(rows.slice(rows.indexOf("user")), expected);
		};
		const reopened = await timestampSession(subtest, () => SessionManager.open(sessionManager.getSessionFile()!), { cwd, beforeBind: checkReplay });
		await reopened.session.prompt("/timestamps transcript off");
		await reopened.session.reload({ beforeSessionStart: () => checkReplay(reopened.session) });
	});

	await t.test("no record reaches the model, including after resume", async (t) => {
		const reopened = await timestampSession(t, () => SessionManager.open(sessionManager.getSessionFile()!), { cwd });
		reopened.faux.setResponses([(context) => {
			capture(context);
			return fauxAssistantMessage("Done again.");
		}]);
		await reopened.session.prompt("What did you read?");
		assert.equal(requests.length, 5);
		assert.ok(requests.at(-1)!.includes("Read the settings three times."));
		const savedTimes = reopened.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "message-timestamp")
			.map((entry) => formatTime(new Date(entry.timestamp)));
		assert.equal(savedTimes.length, 4);
		for (const request of requests) {
			assert.doesNotMatch(request, /"message-timestamp"|"(?:role|type)":"custom(?:_message)?"/);
			for (const time of savedTimes) assert.equal(request.includes(time), false, time);
		}
	});
});

test("deferred shell output precedes the settle line live and on replay", async (t) => {
	const { session, sessionManager, faux } = await timestampSession(t, (cwd) => {
		projectSettings(cwd, { transcript: true });
		return SessionManager.create(cwd, join(cwd, "sessions"));
	}, { extensionFactories: [(pi) => {
		// Pi awaits other extensions before it tells the TUI to move the shell output into chat.
		pi.on("agent_settled", () => new Promise<void>((resolve) => setImmediate(resolve)));
	}] });
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	const live: string[] = [];
	let output = "";
	t.after(session.subscribe((event) => {
		if (event.type === "entry_appended" && event.entry.type === "custom") live.push(...renderRecord(session, event.entry) ?? []);
		// InteractiveMode moves pending shell components into chat on this session event, not on the extension hook.
		if (event.type === "agent_settled") live.push(output);
	}));
	faux.setResponses([async () => {
		output = (await session.executeBash("echo deferred")).output.trim();
		assert.ok(session.hasPendingBashMessages);
		t.mock.timers.tick(60_000);
		return fauxAssistantMessage("Done.");
	}]);
	await session.prompt("Wait for my shell command.");
	const replay = SessionManager.open(sessionManager.getSessionFile()!).buildContextEntries().flatMap((entry) =>
		entry.type === "custom" ? renderRecord(session, entry) ?? [] :
		entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.output.trim()] : []);
	assert.equal(replay.length, 3);
	assert.equal(replay[1], "deferred");
	assert.notEqual(replay[0], replay[2]);
	assert.deepEqual(live, replay);
});

test("resume shows the newest message time", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	let latest!: string;
	const { statuses } = await timestampSession(t, (cwd) => {
		const saved = SessionManager.create(cwd, join(cwd, "sessions"));
		saved.appendMessage(fauxAssistantMessage("Done."));
		t.mock.timers.tick(60_000);
		const id = saved.appendCustomMessageEntry("notice", "Saved notice", true);
		latest = saved.getEntry(id)!.timestamp;
		t.mock.timers.tick(60_000);
		saved.appendCustomEntry("message-timestamp");
		return SessionManager.open(saved.getSessionFile()!);
	});
	assert.equal(statuses.get("message-timestamps"), `last message ${formatTime(new Date(latest))}`);
});

test("tree navigation updates the footer", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	let earlier!: string;
	const { session, sessionManager, statuses } = await timestampSession(t, (cwd) => {
		const tree = SessionManager.inMemory(cwd);
		const root = tree.appendMessage({ role: "user", content: "Pick one.", timestamp: Date.now() });
		earlier = tree.appendMessage(fauxAssistantMessage("First choice."));
		tree.branch(root);
		t.mock.timers.tick(60_000);
		tree.appendMessage(fauxAssistantMessage("Second choice."));
		return tree;
	});
	const expected = `last message ${formatTime(new Date(sessionManager.getEntry(earlier)!.timestamp))}`;
	assert.notEqual(statuses.get("message-timestamps"), expected);
	await session.navigateTree(earlier);
	assert.equal(statuses.get("message-timestamps"), expected);
});

test("empty session shows no time", async (t) => {
	const { statuses, setStatus } = await timestampSession(t);
	assert.deepEqual(setStatus.mock.calls.at(-1)?.arguments, ["message-timestamps", undefined]);
	assert.equal(statuses.has("message-timestamps"), false);
});

function projectSettings(cwd: string, switches: Record<string, unknown>) {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ quiver: { messageTimestamps: switches } }));
}

test("command reports both switches and changes only the requested one", async (t) => {
	const { session, sessionManager, statuses, notify, cwd } = await timestampSession(t, (cwd) => {
		projectSettings(cwd, { footer: false, transcript: true });
		const manager = SessionManager.inMemory(cwd);
		manager.appendMessage(fauxAssistantMessage("Done."));
		manager.appendCustomEntry("message-timestamp");
		return manager;
	});
	const record = sessionManager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "message-timestamp");
	assert.ok(record?.type === "custom");
	const settingsFile = join(cwd, ".pi", "settings.json");
	const original = readFileSync(settingsFile);
	for (const [args, footer, transcript, usage] of [
		["", false, true], ["   ", false, true], ["footer on", true, true], ["transcript off", true, false],
		["footer", true, false, true], ["footer on please", true, false, true], ["other on", true, false, true],
		["footer off", false, false], ["transcript on", false, true], ["footer on", true, true], ["transcript off", true, false],
	] as const) {
		const command = args ? `/timestamps ${args}` : "/timestamps";
		const count = notify.mock.callCount();
		await session.prompt(command);
		assert.equal(notify.mock.callCount(), count + 1, command);
		assert.deepEqual(notify.mock.calls.at(-1)?.arguments, usage
			? ["Usage: /timestamps [footer|transcript] [on|off]", "warning"]
			: [`Message timestamps: footer ${footer ? "on" : "off"}, transcript ${transcript ? "on" : "off"}`, "info"], command);
		assert.equal(statuses.has("message-timestamps"), footer, command);
		assert.equal(renderRecord(session, record) !== undefined, transcript, command);
		assert.deepEqual(readFileSync(settingsFile), original, command);
	}
	await t.test("new session starts from the same settings file", async (t) => {
		const fresh = await timestampSession(t, SessionManager.inMemory, { cwd });
		await fresh.session.prompt("/timestamps");
		assert.deepEqual(fresh.notify.mock.calls.at(-1)?.arguments, ["Message timestamps: footer off, transcript on", "info"]);
	});
});

test("transcript toggle applies from the next message", async (t) => {
	const { session, sessionManager, faux } = await timestampSession(t, (cwd) => {
		projectSettings(cwd, { transcript: true });
		return SessionManager.create(cwd, join(cwd, "sessions"));
	});
	for (const [before, during, expected] of [
		["off", undefined, ["user", "assistant"]],
		["on", undefined, ["user", "message-timestamp", "assistant", "message-timestamp"]],
		["on", "off", ["user", "message-timestamp", "assistant"]],
		["off", "on", ["user", "assistant", "message-timestamp"]],
	] as const) {
		const start = sessionManager.getBranch().length;
		await session.prompt(`/timestamps transcript ${before}`);
		faux.setResponses([async () => {
			if (during) await session.prompt(`/timestamps transcript ${during}`);
			return fauxAssistantMessage("Done.");
		}]);
		await session.prompt("What time is it?");
		const saved = SessionManager.open(sessionManager.getSessionFile()!).getBranch().slice(start);
		assert.deepEqual(saved.flatMap((entry) => entry.type === "custom" ? [entry.customType] :
			entry.type === "message" && entry.message.role !== "system" ? [entry.message.role] : []), expected);
	}
});

for (const mode of ["print", "json", "rpc"] as const) {
	test(`${mode} mode leaves timestamps inert`, async (t) => {
		const reads = t.mock.method(fs, "readFileSync");
		syncBuiltinESMExports();
		t.after(() => { reads.mock.restore(); syncBuiltinESMExports(); });
		const { session, sessionManager, faux, setStatus, notify, cwd } = await timestampSession(t, (cwd) => {
			projectSettings(cwd, { footer: true, transcript: true });
			return SessionManager.create(cwd, join(cwd, "sessions"));
		}, { mode });
		await session.prompt("/timestamps footer off");
		faux.setResponses([fauxAssistantMessage("Done.")]);
		await session.prompt("What time is it?");
		const branch = SessionManager.open(sessionManager.getSessionFile()!).getBranch();
		assert.deepEqual(branch.filter((entry) => entry.type === "message").slice(-2).map((entry) => entry.message.role), ["user", "assistant"]);
		assert.equal(branch.some((entry) => entry.type === "custom" && entry.customType === "message-timestamp"), false);
		assert.equal(setStatus.mock.callCount(), 0);
		assert.equal(notify.mock.callCount(), 0);
		const files = [join(cwd, ".pi", "settings.json"), join(cwd, "agent", "settings.json")];
		assert.deepEqual(reads.mock.calls.map((call) => call.arguments[0]).filter((path) => files.includes(String(path))), []);
		// Inspect the same closure without session_start resetting the switches.
		session.extensionRunner.setUIContext(session.extensionRunner.getUIContext(), "tui");
		await session.prompt("/timestamps");
		assert.deepEqual(notify.mock.calls.at(-1)?.arguments, ["Message timestamps: footer on, transcript off", "info"]);
	});
}

test("footer off in settings shows no status", async (t) => {
	const { session, faux, setStatus } = await timestampSession(t, (cwd) => {
		projectSettings(cwd, { footer: false });
		return SessionManager.inMemory(cwd);
	});
	faux.setResponses([fauxAssistantMessage("Done.")]);
	await session.prompt("What time is it?");
	assert.ok(setStatus.mock.calls.every(({ arguments: [, text] }) => text === undefined));
});

for (const { title, otherStatus } of [
	{ title: "footer shares the status row", otherStatus: "pruner ready" },
	{ title: "footer adds one row when alone", otherStatus: undefined },
]) {
	test(title, async (t) => {
		initTheme();
		const heights: number[] = [];
		for (const footer of [false, true]) {
			await t.test(`footer ${footer ? "on" : "off"}`, async (t) => {
				const { statuses, session } = await timestampSession(t, (cwd) => {
					projectSettings(cwd, { footer });
					const saved = SessionManager.inMemory(cwd);
					saved.appendMessage(fauxAssistantMessage("Done."));
					return saved;
				});
				if (otherStatus) statuses.set("context-prune", otherStatus);
				const rows = new FooterComponent(session, {
					getExtensionStatuses: () => statuses, getGitBranch: () => null,
					getAvailableProviderCount: () => 1, onBranchChange: () => () => {},
				}).render(120);
				heights.push(rows.length);
				if (otherStatus) assert.ok(rows.at(-1)!.includes(otherStatus));
				assert.equal(rows.at(-1)!.includes("last message "), footer);
			});
		}
		assert.equal(heights[1] - heights[0], otherStatus ? 0 : 1);
	});
}
