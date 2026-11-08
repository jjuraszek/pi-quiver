import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderToolSample } from "@earendil-works/pi-codemode/declarations";
import docToMdExtension from "../extensions/doc_to_md.ts";
import fetchExtension from "../extensions/fetch.ts";
import slackExtension from "../extensions/slack.ts";

// The host's catalog builder is internal, so resolve it beside its public SDK entry point.
const { createCodemodeDescription, toCodemodeDeclaration } = await import(new URL(
	"./extensions/codemode/tool.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);

const expectedNames = [
	"doc_to_md", "fetch", "slack_search", "slack_thread", "slack_post", "slack_update",
	"slack_delete", "slack_pin", "slack_upload", "slack_cache_refresh",
];

test("production tool descriptions", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "quiver-tool-descriptions-"));
	const savedEnv = { ...process.env };
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	try {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, {
			PATH: savedEnv.PATH, HOME: root, XDG_CONFIG_HOME: root, APPDATA: root,
			PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1",
		});
		writeFileSync(join(root, "settings.json"), JSON.stringify({ quiver: { slack: { enabled: true } } }));
		const api = {
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		docToMdExtension(api);
		fetchExtension(api);
		slackExtension(api);
		t.mock.method(globalThis, "fetch", () => { throw new Error("catalog verification must not use network"); });
		await handlers.get("session_start")!({}, { cwd: root, hasUI: false } as ExtensionContext);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, savedEnv);
		rmSync(root, { recursive: true, force: true });
	}
	assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expectedNames].sort());
	const guidelines = new Map(tools.map((tool) => [tool.name, tool.promptGuidelines ?? []]));
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	await t.test("declaration renderer is an explicit development dependency", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert.equal(pkg.devDependencies["@earendil-works/pi-codemode"], "^1.5.0");
	});

	await t.test("measures complete production declarations including guidelines and output schemas", (t) => {
		for (const tool of tools) {
			const declaration = toCodemodeDeclaration(tool, guidelines.get(tool.name));
			assert.equal(declaration.inputSchema, tool.parameters);
			assert.deepEqual(declaration.outputSchema, tool.outputSchema ?? { type: "string" });
			for (const guideline of guidelines.get(tool.name)!) assert.ok(declaration.description.includes(guideline));
			const sample = renderToolSample(declaration);
			assert.ok(sample.includes(`${tool.name}(args:`));
			// Ceilings remain a user decision; record the full production render, not a reduced schema.
			t.diagnostic(`${tool.name}: production declaration ${sample.length} characters`);
		}
	});

	await t.test("mode-only catalog includes every tool at inlineBudget 3000", () => {
		// Mode only passes every callable tool, including direct tools, to this production builder.
		const catalog = createCodemodeDescription(tools, { guidelines, inlineBudget: 3000 });
		const listed = [...catalog.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]);
		const missing = expectedNames.filter((name) => !listed.includes(name));
		assert.deepEqual(missing, [], `production catalog omitted: ${missing.join(", ")}`);
	});

	for (const { name, patterns } of [
		{ name: "doc_to_md", patterns: [
			/local file path.*fetch.*URLs/i, /never inlined/i, /read the Saved-To file.*offset\/limit/i,
			/info: true.*pick `pages`/i, /OCR is capped at quiver\.docToMd\.ocrMaxPages.*settings-only/i,
		] },
		{ name: "slack_thread", patterns: [
			/`messages`.*`file`/i, /`complete`/, /`next_cursor`/, /`message_count`/, /`caveat`/,
			/passing `next_cursor` as `cursor`/i,
		] },
		{ name: "slack_post", patterns: [/re-invoke with `thread_ts` set.*second headline is never sent/i] },
	]) {
		await t.test(`${name} keeps call-shaping description guidance`, () => {
			const description = byName.get(name)!.description;
			for (const pattern of patterns) assert.match(description, pattern);
			if (name === "slack_thread") assert.doesNotMatch(description, /JSON\.parse/);
		});
	}

	for (const name of ["slack_post", "slack_update"]) {
		await t.test(`${name} prompt guidelines end with the native list example`, () => {
			const example = guidelines.get(name)!.at(-1)!;
			assert.match(example, /^Native list example: /);
			const payload = JSON.parse(example.slice("Native list example: ".length));
			assert.equal(payload.blocks[0].elements[0].type, "rich_text_list");
			assert.equal(payload.blocks[0].elements[0].style, "bullet");
			assert.equal(payload.text, "- First\n- Second");
		});
	}
});
