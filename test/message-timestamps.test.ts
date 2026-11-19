import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, FooterComponent, initTheme, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import { formatTime } from "../extensions/message-timestamps.ts";

async function timestampSession(t: TestContext, managerFor: (cwd: string) => SessionManager = SessionManager.inMemory) {
	const cwd = mkdtempSync(join(tmpdir(), "message-timestamps-"));
	const agentDir = join(cwd, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	});
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
		noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [join(import.meta.dirname, "../extensions/message-timestamps.ts")],
	});
	await resourceLoader.reload();
	const sessionManager = managerFor(cwd);
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, sessionManager, settingsManager, tools: [],
	});
	t.after(() => session.dispose());
	const statuses = new Map<string, string>();
	const setStatus = t.mock.fn((key: string, text?: string) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
	});
	await session.bindExtensions({
		mode: "tui",
		uiContext: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus,
		} as unknown as ExtensionUIContext,
	});
	return { session, sessionManager, faux, statuses, setStatus };
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
