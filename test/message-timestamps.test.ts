import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

async function timestampSession(t: TestContext) {
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
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, sessionManager, settingsManager, tools: [],
	});
	t.after(() => session.dispose());
	const statuses = new Map<string, string>();
	await session.bindExtensions({
		mode: "tui",
		uiContext: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus(key: string, text?: string) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		} as ExtensionUIContext,
	});
	return { session, sessionManager, faux, statuses };
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
