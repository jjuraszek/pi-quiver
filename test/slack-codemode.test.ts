import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import slackExtension from "../extensions/slack.ts";

// The host exports the SDK publicly, but its built-in codemode factory is internal.
const { createCodemodeExtension } = await import(new URL(
	"./extensions/codemode/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);

const directSlackTools = [
	"slack_search", "slack_thread", "slack_post", "slack_update", "slack_delete", "slack_pin", "slack_upload",
];

for (const mode of ["on", "only"] as const) {
	test(`host session keeps cache refresh script-only and executes it in mode ${mode}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "quiver-slack-codemode-"));
		const agentDir = join(root, "agent");
		const cachePath = join(root, "cache.json");
		mkdirSync(agentDir);
		const savedEnv = { ...process.env };
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, {
			PATH: savedEnv.PATH, HOME: root, XDG_CONFIG_HOME: root, APPDATA: root,
			PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", TEST_SLACK_TOKEN: `xoxp-fixture-${mode}`,
		});
		t.after(() => {
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, savedEnv);
			rmSync(root, { recursive: true, force: true });
		});
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			quiver: { slack: { enabled: true, userTokenEnv: "TEST_SLACK_TOKEN", botTokenEnv: "NO_BOT_TOKEN", cachePath } },
		}));
		const calls: string[] = [];
		t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			assert.equal(url.origin, "https://slack.com", "no external transport is permitted");
			const method = url.pathname.replace("/api/", "");
			calls.push(method);
			const fixtures: Record<string, object> = {
				"auth.test": { ok: true, team_id: "TLOCAL" },
				"conversations.list": { ok: true, channels: [{ id: "CLOCAL1", name: "renamed" }] },
				"users.list": { ok: true, members: [{ id: "ULOCAL1", name: "alice", profile: { display_name: "Alice", real_name: "Alice", email: "alice@example.test" } }] },
			};
			assert.ok(fixtures[method], `unexpected transport call: ${method}`);
			return Response.json(fixtures[method]);
		});
		const settingsManager = SettingsManager.inMemory({ codemode: { mode } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [slackExtension, createCodemodeExtension({ mode, models: false })],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: null,
			modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false,
		});
		const { session, extensionsResult } = await createAgentSession({
			cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime,
			sessionManager: SessionManager.inMemory(root), noTools: "builtin",
		});
		t.after(() => session.dispose());
		assert.deepEqual(extensionsResult.errors, []);
		assert.deepEqual(modelRuntime.getAvailableSnapshot(), []);
		assert.equal(session.model?.provider, "unknown", "the host uses its no-model sentinel");
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		assert.deepEqual(errors, []);
		session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
		assert.equal(session.getToolDefinition("slack_cache_refresh")?.exposure, "codemode");
		assert.ok(!session.getActiveToolNames().includes("slack_cache_refresh"));
		assert.ok(session.getCallableToolNames().includes("slack_cache_refresh"));
		if (mode === "on") {
			assert.deepEqual(session.getActiveToolNames().filter((name) => name.startsWith("slack_")).sort(), [...directSlackTools].sort());
		}
		assert.deepEqual(calls, [], "registration must not run a refresh");
		const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
		assert.ok(codemode);
		const args = { code: "text(await tools.slack_cache_refresh({}));" };
		// Nested calls require an issuing assistant message; this fixture replaces a model request.
		session.sessionManager.appendMessage({
			role: "assistant", api: "fixture", provider: "fixture", model: "fixture", timestamp: 0,
			content: [{ type: "toolCall", id: "refresh-script", name: "codemode", arguments: args }],
			stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		session.refreshContext();
		// Use the session-wrapped tool so executeCodemode receives the real nested-call context.
		const result = await codemode.execute("refresh-script", args);
		assert.notEqual(result.isError, true);
		assert.deepEqual(errors, []);
		assert.match(JSON.stringify(result.content), /channels: 1, users: 1/);
		assert.deepEqual(calls, ["auth.test", "conversations.list", "users.list"]);
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		assert.deepEqual(cache.channels, { renamed: "CLOCAL1" });
		assert.equal(cache.users.alice.id, "ULOCAL1");
		assert.equal(cache.users.alice.email, "alice@example.test");
	});
}
