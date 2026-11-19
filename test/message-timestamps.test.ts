import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime, createAgentSession, DefaultResourceLoader, FooterComponent, initTheme, InteractiveMode, ModelRuntime,
	SessionManager, SettingsManager, type AgentSession, type CreateAgentSessionRuntimeFactory, type CustomEntry,
	type ExtensionContext, type ExtensionFactory, type ExtensionUIContext, type SessionEntry, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { formatTime, newestMessageTime, parseArgs } from "../extensions/message-timestamps.ts";

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
	const create = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: Parameters<CreateAgentSessionRuntimeFactory>[0], projectTrusted = true) => {
		const settingsManager = options.mode && options.mode !== "tui" ? SettingsManager.inMemory() :
			SettingsManager.create(cwd, agentDir, { projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
			noThemes: true, noContextFiles: true, extensionFactories: options.extensionFactories,
			additionalExtensionPaths: [join(import.meta.dirname, "../extensions/message-timestamps.ts")],
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, sessionManager, settingsManager,
			tools: options.tools ?? [], sessionStartEvent,
		});
		t.after(() => created.session.dispose());
		const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
		return { ...created, services, diagnostics: [] };
	};
	const sessionManager = managerFor(cwd);
	const created = await create({ cwd, agentDir, sessionManager });
	const { session } = created;
	const statuses = new Map<string, string>();
	const setStatus = t.mock.fn((key: string, text?: string) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
	});
	const notify = t.mock.fn();
	options.beforeBind?.(session);
	const bind = (session: AgentSession) => session.bindExtensions({
		mode: options.mode ?? "tui",
		uiContext: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus, notify,
		} as unknown as ExtensionUIContext,
	});
	await bind(session);
	return { ...created, create, bind, sessionManager, faux, statuses, setStatus, notify, cwd };
}

test("formatTime renders date and time", () => {
	assert.equal(formatTime(new Date("2026-11-19T14:59:00Z"), "en-US", "UTC"), "Nov 19, 02:59 PM");
});

test("newestMessageTime counts every saved message", (t) => {
	t.mock.timers.enable({ apis: ["Date"] });
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("message-timestamp");
	assert.equal(newestMessageTime(manager.getBranch()), undefined);
	const shell = manager.appendMessage({
		role: "bashExecution", command: "echo saved", output: "saved", exitCode: 0,
		cancelled: false, truncated: false, timestamp: Date.now(),
	});
	t.mock.timers.tick(60_000);
	manager.appendCustomEntry("message-timestamp");
	assert.equal(newestMessageTime(manager.getBranch()), manager.getEntry(shell)!.timestamp);
	t.mock.timers.tick(60_000);
	const custom = manager.appendCustomMessageEntry("notice", "Saved notice", true);
	t.mock.timers.tick(60_000);
	manager.appendCustomEntry("message-timestamp");
	assert.equal(newestMessageTime(manager.getBranch()), manager.getEntry(custom)!.timestamp);
});

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

function transcriptFile(cwd: string) {
	projectSettings(cwd, { transcript: true });
	return SessionManager.create(cwd, join(cwd, "sessions"));
}

test("deferred shell output follows the settle line live but precedes it on replay", async (t) => {
	const { session, sessionManager, faux, statuses } = await timestampSession(t, transcriptFile);
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	const appendMessage = sessionManager.appendMessage.bind(sessionManager);
	// Pi flushes the shell result and settles without waiting between the two saves.
	t.mock.method(sessionManager, "appendMessage", (message: Parameters<SessionManager["appendMessage"]>[0]) => {
		if (message.role !== "bashExecution") return appendMessage(message);
		t.mock.timers.tick(60_000);
		const id = appendMessage(message);
		t.mock.timers.tick(60_000);
		return id;
	});
	const live: string[] = [];
	const promptLine = `dim:${formatTime(new Date())}`;
	t.after(session.subscribe((event) => {
		if (event.type === "entry_appended" && event.entry.type === "custom") live.push(...renderRecord(session, event.entry) ?? []);
		// InteractiveMode moves pending shell components into chat on this session event, not on the extension hook.
		if (event.type === "agent_settled") live.push("deferred");
	}));
	faux.setResponses([() => {
		session.recordBashResult("echo deferred", { output: "deferred", exitCode: 0, cancelled: false, truncated: false });
		assert.ok(session.hasPendingBashMessages);
		t.mock.timers.tick(60_000);
		return fauxAssistantMessage("Done.");
	}]);
	await session.prompt("Wait for my shell command.");
	const [reply, shell, settle] = sessionManager.getBranch().slice(-3);
	assert.ok(reply.type === "message" && reply.message.role === "assistant");
	assert.ok(shell.type === "message" && shell.message.role === "bashExecution");
	assert.ok(settle.type === "custom" && settle.customType === "message-timestamp");
	const [replyTime, shellTime, settleTime] = [reply, shell, settle].map((entry) => formatTime(new Date(entry.timestamp)));
	assert.equal(new Set([replyTime, shellTime, settleTime]).size, 3);
	assert.equal(statuses.get("message-timestamps"), `last message ${shellTime}`);
	const settleLine = `dim:${settleTime}`;
	assert.deepEqual(live, [promptLine, settleLine, "deferred"]);
	t.mock.timers.tick(86_400_000);
	const replay = SessionManager.open(sessionManager.getSessionFile()!).buildContextEntries().flatMap((entry) =>
		entry.type === "custom" ? renderRecord(session, entry) ?? [] :
		entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.output.trim()] : []);
	assert.deepEqual(replay, [promptLine, "deferred", settleLine]);
});

function runOrder(entries: readonly SessionEntry[]) {
	return entries.flatMap((entry) => entry.type === "custom" ? [entry.customType] :
		entry.type === "custom_message" ? [entry.customType] :
		entry.type === "message" && entry.message.role === "user" ? [entry.message.content] :
		entry.type === "message" && entry.message.role === "assistant" ? [entry.message.stopReason] : []);
}

test("queued prompt gets its own record", async (t) => {
	const { session, sessionManager, faux } = await timestampSession(t, transcriptFile, { extensionFactories: [(pi) => {
		pi.on("before_agent_start", () => ({ message: { customType: "sibling", content: "Context", display: true } }));
	}] });
	session.setFollowUpMode("all");
	const live: unknown[] = [];
	t.after(session.subscribe((event) => {
		if (event.type === "message_end") {
			const message = event.message;
			if (message.role === "user") live.push(message.content);
			if (message.role === "custom") live.push(message.customType);
			if (message.role === "assistant") live.push(message.stopReason);
		}
		if (event.type === "entry_appended" && event.entry.type === "custom") live.push(event.entry.customType);
	}));
	faux.setResponses([async () => {
		await session.followUp("Second");
		await session.followUp("Third");
		return fauxAssistantMessage("Done.");
	}, fauxAssistantMessage("Done again.")]);
	await session.prompt("First");
	const prompt = (text: string) => [{ type: "text", text }];
	const expected = [prompt("First"), "message-timestamp", "sibling", "stop",
		prompt("Second"), "message-timestamp", prompt("Third"), "message-timestamp", "stop", "message-timestamp"];
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(live, expected);
	assert.deepEqual(runOrder(SessionManager.open(sessionManager.getSessionFile()!).buildContextEntries()), expected);
});

test("retry writes no second prompt record", async (t) => {
	const { session, sessionManager, faux } = await timestampSession(t, (cwd) => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			quiver: { messageTimestamps: { transcript: true } }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		}));
		return SessionManager.create(cwd, join(cwd, "sessions"));
	});
	const events: string[] = [];
	t.after(session.subscribe((event) => {
		if (event.type === "auto_retry_start" || event.type === "entry_appended" && event.entry.type === "custom") {
			events.push(event.type);
		}
	}));
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" }),
		fauxAssistantMessage("Recovered.")]);
	await session.prompt("Retry me");
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(events, ["entry_appended", "auto_retry_start", "entry_appended"]);
	assert.deepEqual(runOrder(SessionManager.open(sessionManager.getSessionFile()!).buildContextEntries()),
		[[{ type: "text", text: "Retry me" }], "message-timestamp", "error", "stop", "message-timestamp"]);
});

test("aborted run still writes the settle record", async (t) => {
	const { session, sessionManager, faux, statuses } = await timestampSession(t, transcriptFile);
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	let promptStatus: string | undefined;
	let abort: Promise<void> | undefined;
	faux.setResponses([() => {
		promptStatus = statuses.get("message-timestamps");
		t.mock.timers.tick(60_000);
		abort = session.abort();
		return fauxAssistantMessage("Interrupted.");
	}]);
	await session.prompt("Cancel me");
	await abort;
	const entries = SessionManager.open(sessionManager.getSessionFile()!).buildContextEntries();
	assert.deepEqual(runOrder(entries), [[{ type: "text", text: "Cancel me" }], "message-timestamp", "aborted", "message-timestamp"]);
	const expected = `last message ${formatTime(new Date(entries.at(-2)!.timestamp))}`;
	assert.notEqual(expected, promptStatus);
	assert.equal(statuses.get("message-timestamps"), expected);
});

test("footer shows the saved entry time", async (t) => {
	let beforeSave: Date | undefined;
	const { session, sessionManager, faux, statuses, cwd } = await timestampSession(t,
		(cwd) => SessionManager.create(cwd, join(cwd, "sessions")), { extensionFactories: [(pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role !== "assistant") return;
				beforeSave = new Date();
				await new Promise<void>((resolve) => setImmediate(resolve));
				t.mock.timers.tick(60_000);
			});
		}] });
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T14:59:00Z") });
	faux.setResponses([fauxAssistantMessage("Done.")]);
	await session.prompt("Save this");
	const live = statuses.get("message-timestamps");
	const reopened = await timestampSession(t, () => SessionManager.open(sessionManager.getSessionFile()!), { cwd });
	const reply = reopened.sessionManager.getLeafEntry();
	assert.ok(reply?.type === "message" && reply.message.role === "assistant");
	assert.ok(beforeSave);
	assert.notEqual(formatTime(beforeSave), formatTime(new Date(reply.timestamp)));
	assert.equal(live, `last message ${formatTime(new Date(reply.timestamp))}`);
	assert.equal(reopened.statuses.get("message-timestamps"), live);
});

test("replay before session_start uses the destination settings", async (t) => {
	for (const { name, launchOn, destinationOn, projectTrusted, expected } of [
		{ name: "off to on", launchOn: false, destinationOn: true, projectTrusted: true, expected: true },
		{ name: "on to off", launchOn: true, destinationOn: false, projectTrusted: true, expected: false },
		{ name: "untrusted destination", launchOn: true, destinationOn: true, projectTrusted: false, expected: false },
	]) {
		await t.test(name, async (t) => {
			const launch = await timestampSession(t, (cwd) => {
				projectSettings(cwd, { transcript: launchOn });
				writeTimestampSettings(join(cwd, "agent"), { transcript: false });
				return SessionManager.inMemory(cwd);
			});
			const destination = join(launch.cwd, "destination");
			projectSettings(destination, { transcript: destinationOn });
			const saved = SessionManager.create(destination, join(launch.cwd, "sessions"));
			saved.appendMessage(fauxAssistantMessage("Done."));
			const record = saved.getEntry(saved.appendCustomEntry("message-timestamp"));
			assert.ok(record?.type === "custom");

			const checkReplay = (session: AgentSession, operation: string) => {
				assert.equal(session.sessionManager.getCwd(), destination);
				assert.equal(renderRecord(session, record) !== undefined, expected, operation);
			};
			const checkBound = async (session: AgentSession, value: boolean) => {
				await session.prompt("/timestamps");
				assert.deepEqual(launch.notify.mock.calls.at(-1)?.arguments,
					[`Message timestamps: footer on, transcript ${value ? "on" : "off"}`, "info"]);
			};
			await checkBound(launch.session, launchOn);
			const runtime = new AgentSessionRuntime(launch.session, launch.services, (options) => launch.create(options, projectTrusted));
			runtime.setRebindSession(async (session) => {
				checkReplay(session, "/resume");
				await launch.bind(session);
			});
			assert.deepEqual(await runtime.switchSession(saved.getSessionFile()!), { cancelled: false });
			await checkBound(runtime.session, expected);

			await runtime.session.prompt(`/timestamps transcript ${expected ? "off" : "on"}`);
			await runtime.session.reload({ beforeSessionStart: () => checkReplay(runtime.session, "/reload") });
			await checkBound(runtime.session, expected);
		});
	}
});

test("transcript off hides stored records and writes none", async (t) => {
	const records = (manager: SessionManager) => manager.buildContextEntries().filter((entry): entry is CustomEntry =>
		entry.type === "custom" && entry.customType === "message-timestamp");
	const checkHidden = (session: AgentSession) => {
		assert.deepEqual(records(session.sessionManager).map((entry) => renderRecord(session, entry)), [undefined, undefined]);
	};
	const { session, sessionManager, faux } = await timestampSession(t, (cwd) => {
		writeTimestampSettings(join(cwd, "agent"), { transcript: true });
		projectSettings(cwd, { transcript: false });
		const saved = SessionManager.create(cwd, join(cwd, "sessions"));
		saved.appendMessage({ role: "user", content: "First prompt", timestamp: Date.now() });
		saved.appendCustomEntry("message-timestamp");
		saved.appendMessage(fauxAssistantMessage("First reply"));
		saved.appendCustomEntry("message-timestamp");
		return SessionManager.open(saved.getSessionFile()!);
	}, { beforeBind: checkHidden });
	const original = records(sessionManager);
	await session.prompt("/timestamps transcript on");
	await session.reload({ beforeSessionStart: () => checkHidden(session) });
	faux.setResponses([fauxAssistantMessage("Second reply")]);
	await session.prompt("Second prompt");
	const reopened = SessionManager.open(sessionManager.getSessionFile()!);
	const last = reopened.getLeafEntry();
	assert.ok(last?.type === "message" && last.message.role === "assistant");
	assert.deepEqual(last.message.content, [{ type: "text", text: "Second reply" }]);
	assert.deepEqual(records(reopened), original);
});

test("mounted and omitted lines follow host redraw and rebuild rules", async (t) => {
	initTheme();
	const { session, services, create, sessionManager } = await timestampSession(t, (cwd) => {
		projectSettings(cwd, { transcript: true });
		const saved = SessionManager.inMemory(cwd);
		saved.appendCustomEntry("message-timestamp");
		return saved;
	});
	const mode = new InteractiveMode(new AgentSessionRuntime(session, services, create)) as unknown as {
		chatContainer: Container;
		showStatus: (message: string) => void;
		toggleToolOutputExpansion: () => void;
		rebuildChatFromMessages: () => void;
	};
	t.mock.method(mode, "showStatus", () => {});
	const time = formatTime(new Date(sessionManager.getLeafEntry()!.timestamp));
	const showsTime = () => mode.chatContainer.render(80).some((line) => line.includes(time));
	mode.rebuildChatFromMessages();
	assert.equal(mode.chatContainer.children.length, 1);
	assert.ok(showsTime());

	await session.prompt("/timestamps transcript off");
	assert.ok(showsTime(), "the toggle does not redraw the mounted line");
	mode.toggleToolOutputExpansion(); // Ctrl+O
	assert.equal(showsTime(), false);
	assert.equal(mode.chatContainer.children.length, 1, "redraw does not unmount the component");

	mode.rebuildChatFromMessages();
	assert.equal(mode.chatContainer.children.length, 0, "rebuild while off omits the component");
	await session.prompt("/timestamps transcript on");
	mode.toggleToolOutputExpansion();
	assert.deepEqual(mode.chatContainer.render(80), []);
	mode.rebuildChatFromMessages();
	assert.ok(showsTime());
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

function writeTimestampSettings(dir: string, switches: Record<string, boolean>) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ quiver: { messageTimestamps: switches } }));
}

function projectSettings(cwd: string, switches: Record<string, boolean>) {
	writeTimestampSettings(join(cwd, ".pi"), switches);
}

test("parseArgs accepts five forms", () => {
	for (const [args, expected] of [
		["", { kind: "status" }],
		["  footer on ", { kind: "set", target: "footer", on: true }],
		["footer off", { kind: "set", target: "footer", on: false }],
		["transcript on", { kind: "set", target: "transcript", on: true }],
		["transcript off", { kind: "set", target: "transcript", on: false }],
		["footer", { kind: "usage" }],
	] as const) assert.deepEqual(parseArgs(args), expected, args);
});

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
			writeTimestampSettings(join(cwd, "agent"), { footer: true, transcript: true });
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
