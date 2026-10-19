import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../bin/pi-quiver.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as cli from "../bin/pi-quiver.ts";
import { SlackError, makeApiCall, userConfigEnvPath, type ApiCall, type ApiOpts } from "../lib/slack-core.ts";

test("Slack parser accepts commands and offline variants", () => {
	for (const args of [
		["post", "--channel", "C123456", "--text", "hello"],
		["post", "--channel", "G1", "--text", "hello", "--as", "user"],
		["reply", "--channel", "D1", "--thread-ts", "100.1", "--text-file", "body"],
		["dm", "--user", "U123456", "--text", "@literal", "--as", "bot"],
		["canvas", "--id", "F123456", "--markdown-file", "body"],
		["post", "--channel", "C1", "--text", "hi", "--no-unfurl", "--token-from-env", "--dry-run"],
		["dm", "--user", "U1", "--text", "hi", "--blocks-file", "blocks", "--no-unfurl"],
		["reply", "--channel", "C1", "--thread-ts", "100.1", "--text", "hi", "--no-unfurl", "--dry-run"],
		["canvas", "--id", "F1", "--markdown-file", "body", "--token-from-env", "--dry-run"],
	]) {
		const r = parseCliArgs(["slack", ...args]);
		assert.ok(r.ok && r.cmd === "slack", JSON.stringify(args));
		assert.equal(r.as, args.includes("bot") ? "bot" : "user");
		assert.equal(r.noUnfurl, args.includes("--no-unfurl") ? true : undefined);
		assert.equal(r.tokenFromEnv, args.includes("--token-from-env") ? true : undefined);
		assert.equal(r.dryRun, args.includes("--dry-run") ? true : undefined);
	}
	assert.deepEqual(parseCliArgs(["slack", "--help"]), { ok: true, cmd: "slack-help" });
	assert.deepEqual(parseCliArgs(["--version"]), { ok: true, cmd: "version" });
});

test("Slack parser rejects malformed and out-of-scope inputs", () => {
	for (const args of [[], ["search"], ["post"], ["post", "--channel"],
		["post", "--channel", "#name", "--text", "hi"],
		["post", "--channel", "C1", "--text", "hi", "--text-file", "x"],
		["post", "--channel", "C1", "--text", "hi", "--detail", "a", "--detail-file", "b"],
		["post", "--channel", "C1", "--text", "hi", "--as", "other"],
		["post", "--channel", "C1", "--text", "hi", "extra"],
		["post", "--channel", "C1", "--text", "hi", "--wat"],
		["post", "--channel", "c1", "--text", "hi"],
		["post", "--channel", "C", "--text", "hi"],
		["reply", "--channel", "C1", "--text", "hi"],
		["dm", "--user", "@name", "--text", "hi"],
		["dm", "--user", "U1", "--text", "hi", "--text-file", "x"],
		["canvas", "--id", "F1", "--markdown-file", "x", "--text", "hi"],
		["canvas", "--id", "F1", "--markdown-file", "x", "--no-unfurl"],
		["post", "--channel", "C1", "--text", "hi", "--dry-run=true"],
		["post", "--channel", "C1", "--text", "hi", "--no-unfurl", "false"],
		["post", "--channel", "C1", "--text", "hi", "--token-from-env", "true"],
	]) assert.equal(parseCliArgs(["slack", ...args]).ok, false, JSON.stringify(args));
});


interface ScriptEntry { method: string; result?: Record<string, unknown>; error?: Error }
function scriptedApiCall(script: ScriptEntry[]) {
	const calls: { method: string; token: string; params: Record<string, unknown>; opts?: ApiOpts }[] = [];
	const apiCall: ApiCall = async (method, token, params, opts) => {
		calls.push({ method, token, params, opts });
		const entry = script.shift();
		assert.ok(entry, `unexpected ${method}`);
		assert.equal(method, entry.method);
		if (entry.error) throw entry.error;
		return entry.result ?? {};
	};
	return { apiCall, calls, exhausted: () => assert.equal(script.length, 0) };
}
function fixture(t?: { after: (fn: () => void) => void }) {
	const cwd = mkdtempSync(join(tmpdir(), "quiver-slack-cli-"));
	const close = () => rmSync(cwd, { recursive: true, force: true });
	t?.after(close);
	execFileSync("git", ["init", "--quiet", cwd]);
	const env: NodeJS.ProcessEnv = { HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "xdg"), APPDATA: join(cwd, "appdata"), PI_CODING_AGENT_DIR: join(cwd, "agent"), SLACK_USER_TOKEN: "synthetic-user", SLACK_BOT_TOKEN: "synthetic-bot" };
	function file(path: string, text: string) { const full = join(cwd, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, text); return full; }
	async function run(args: string[], script: ScriptEntry[], overrides: Partial<Parameters<typeof cli.runSlack>[1]> = {}) {
		const parsed = parseCliArgs(["slack", ...args]);
		assert.ok(parsed.ok && parsed.cmd === "slack");
		const transport = scriptedApiCall(script);
		let stdout = "", stderr = "";
		const code = await cli.runSlack(parsed, { cwd, env, apiCall: transport.apiCall, uploadBytes: async () => {}, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...overrides });
		transport.exhausted();
		for (const token of [env.SLACK_USER_TOKEN, env.SLACK_BOT_TOKEN]) if (token) assert.ok(!stdout.includes(token) && !stderr.includes(token));
		return { code, stdout, stderr, calls: transport.calls };
	}
	return { cwd, env, file, run, close };
}
const post = ["post", "--channel", "C123456", "--text", "hello"];
const sent = { method: "chat.postMessage", result: { ts: "100.1" } };
const link = { method: "chat.getPermalink", result: { permalink: "https://example.test/p/1001" } };

test("Slack wire dispatch preserves text, blocks, thread coordinates, retries and result order", async (t) => {
	for (const kind of ["plain", "detail", "detail-file", "blocks", "reply", "dm", "canvas"]) {
		const f = fixture(t);
		if (["detail-file", "reply", "canvas"].includes(kind)) f.file("body", "detail\nunchanged\n");
		const blocks = [{ type: "section", text: { type: "mrkdwn", text: "literal" } }];
		if (kind === "detail-file" || kind === "blocks") f.file("blocks", JSON.stringify(blocks));
		let args = [...post];
		let script: ScriptEntry[] = [sent, link];
		if (kind === "detail") args.push("--detail", "detail");
		if (kind === "detail-file") args.push("--detail-file", "body", "--blocks-file", "blocks");
		if (kind === "blocks") args.push("--blocks-file", "blocks");
		if (kind.startsWith("detail")) script.push({ method: "chat.postMessage", result: { ts: "100.2" } });
		if (kind === "reply") args = ["reply", "--channel", "C123456", "--thread-ts", "100.1", "--text-file", "body"];
		if (kind === "dm") { args = ["dm", "--user", "U123456", "--text", "@literal"]; script = [{ method: "conversations.open", result: { channel: { id: "D123456" } } }, ...script]; }
		if (kind === "canvas") { args = ["canvas", "--id", "F123456", "--markdown-file", "body"]; script = [{ method: "canvases.edit" }]; }
		const r = await f.run(args, script);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stderr, "");
		assert.equal(r.stdout, kind === "canvas" ? "canvas=F123456\n" : `ts=100.1 permalink=https://example.test/p/1001${kind.startsWith("detail") ? " detail_ts=100.2" : ""}\n`);
		for (const c of r.calls) assert.equal(c.token, "synthetic-user");
		if (kind === "canvas") assert.deepEqual(r.calls[0].params, { canvas_id: "F123456", changes: [{ operation: "replace", document_content: { type: "markdown", markdown: "detail\nunchanged\n" } }] });
		else {
			const c = r.calls[kind === "dm" ? 1 : 0];
			assert.deepEqual(c.params, { channel: kind === "dm" ? "D123456" : "C123456", text: kind === "dm" ? "@literal" : kind === "reply" ? "detail\nunchanged\n" : "hello", ...(kind === "reply" ? { thread_ts: "100.1" } : {}), ...(kind === "blocks" ? { blocks } : {}) });
			assert.equal(c.opts?.retry, !kind.startsWith("detail"));
			if (kind.startsWith("detail")) { assert.deepEqual(r.calls[2].params, { channel: "C123456", text: kind === "detail" ? "detail" : "detail\nunchanged\n", thread_ts: "100.1", ...(kind === "detail-file" ? { blocks } : {}) }); assert.equal(r.calls[2].opts?.retry, true); }
			if (kind === "dm") assert.deepEqual(r.calls[0].params, { users: "U123456" });
		}
	}
});

test("bot multiline dispatch and unfurl preserve parent, detail and DM blocks", async (t) => {
	for (const kind of ["plain", "detail", "detail-file", "blocks-detail", "upload", "dm", "reply", "announce"]) {
		const f = fixture(t);
		const blocks = [{ type: "divider" }];
		f.file("blocks", JSON.stringify(blocks)); f.file("detail", "detail body");
		const multiline = "first\nsecond";
		let args = ["post", "--channel", "C123456", "--text", multiline, "--as", "bot", "--no-unfurl"];
		let script: ScriptEntry[] = [{ ...sent }, { ...link }];
		const detail = ["detail", "detail-file", "blocks-detail", "upload", "announce"].includes(kind);
		if (detail) {
			args.push(...(kind === "detail-file" ? ["--detail-file", "detail"] : ["--detail", "detail body"]));
			script.push({ method: "chat.postMessage", result: { ts: "100.2" } });
		}
		if (kind === "announce") args[4] = "headline";
		if (kind === "plain" || kind === "blocks-detail") args.push("--blocks-file", "blocks");
		if (kind === "upload") {
			f.env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS = "3";
			script.push({ method: "files.getUploadURLExternal", result: { upload_url: "https://example.test/upload", file_id: "F1" } }, { method: "files.completeUploadExternal", result: { files: [] } });
		}
		if (kind === "dm") {
			args = ["dm", "--user", "U1", "--text", multiline, "--as", "bot", "--blocks-file", "blocks", "--no-unfurl"];
			script.unshift({ method: "conversations.open", result: { channel: { id: "D1" } } });
		}
		if (kind === "reply") args = ["reply", "--channel", "C1", "--thread-ts", "99.1", "--text", multiline, "--no-unfurl"];
		const r = await f.run(args, script);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout, `ts=100.1 permalink=https://example.test/p/1001${detail ? " detail_ts=100.2" : ""}\n`);
		const messages = r.calls.filter((c) => c.method === "chat.postMessage");
		for (const c of kind === "upload" ? messages.slice(0, 1) : messages) { assert.equal(c.params.unfurl_links, false); assert.equal(c.params.unfurl_media, false); }
		if (kind === "upload") { assert.equal(messages[1].params.unfurl_links, undefined); assert.equal(messages[1].params.unfurl_media, undefined); }
		assert.equal(messages[0].params.text, kind === "announce" ? "headline" : multiline);
		if (detail) {
			assert.equal(messages[0].params.blocks, undefined);
			assert.equal(messages[1].params.thread_ts, "100.1");
			assert.equal(messages[1].params.text, kind === "upload" ? "Detail attached." : "detail body");
			assert.deepEqual(messages[1].params.blocks, kind === "blocks-detail" ? blocks : undefined);
		} else if (kind !== "reply") assert.deepEqual(messages[0].params.blocks, blocks);
	}
});

test("multiline bot detail failures keep only acknowledged parent and structured definitive code", async (t) => {
	for (const code of ["invalid_blocks", "transport", "outcome_unknown"]) {
		const f = fixture(t);
		const r = await f.run(["post", "--channel", "C1", "--text", "first\nsecond", "--as", "bot", "--detail", "body"], [
			{ ...sent }, { ...link }, { method: "chat.postMessage", error: new SlackError(code, "misleading invalid_auth", { ts: "untrusted" }) },
		]);
		assert.equal(r.code, code === "invalid_blocks" ? 4 : 5);
		assert.equal(r.stdout, code === "invalid_blocks" ? "ts=100.1 error=invalid_blocks\n" : "");
	}
	for (const code of ["transport", "invalid_auth"]) {
		const f = fixture(t);
		f.env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS = "3";
		const r = await f.run(["post", "--channel", "C1", "--text", "first\nsecond", "--as", "bot", "--detail", "body"], [
			{ ...sent }, { ...link }, { method: "chat.postMessage", result: { ts: "100.2" } },
			{ method: "files.getUploadURLExternal", result: { upload_url: "https://example.test/upload", file_id: "F1" } },
			{ method: "files.completeUploadExternal", error: new SlackError(code, "upload rejected") },
		]);
		assert.equal(r.code, code === "transport" ? 5 : 4);
		assert.equal(r.stdout, code === "transport" ? "" : "ts=100.1 error=invalid_auth\n");
		assert.match(r.stderr, new RegExp(code));
		assert.equal(r.stderr.includes("Check the channel before retrying."), code === "transport");
	}
	const redacted = fixture(t);
	const partial = await redacted.run(post, [{ method: "chat.postMessage", error: new SlackError("detail_failed", "detail failed", { ts: "synthetic-user" }) }]);
	assert.equal(partial.code, 4); assert.equal(partial.stdout, "ts=<redacted> error=detail_failed\n");
	const oversized = await redacted.run(["post", "--channel", "C1", "--text", "x".repeat(4001), "--as", "bot"], []);
	assert.equal(oversized.code, 4); assert.equal(oversized.stdout, "error=text_too_long\n");
	for (const code of ["invalid_auth", "missing_scope", "channel_not_found", "synthetic-user"]) {
		const f = fixture(t);
		const r = await f.run(post, [{ method: "chat.postMessage", error: new SlackError(code, "misleading detail_failed", { ts: "synthetic-user" }) }]);
		assert.equal(r.code, 4);
		assert.equal(r.stdout, `error=${code === "synthetic-user" ? "<redacted>" : code}\n`);
	}
});

test("dry-run covers every command and identity without API or upload", async (t) => {
	const f = fixture(t); f.file("body", "body");
	for (const identity of ["user", "bot"]) for (const envOnly of [false, true]) for (const sub of ["post", "reply", "dm", "canvas"]) {
		const args = sub === "post" ? post : sub === "reply" ? ["reply", "--channel", "C1", "--thread-ts", "100.1", "--text", "body"] : sub === "dm" ? ["dm", "--user", "U1", "--text-file", "body"] : ["canvas", "--id", "F1", "--markdown-file", "body"];
		const r = await f.run([...args, "--as", identity, "--dry-run", ...(envOnly ? ["--token-from-env"] : [])], [], {
			apiCall: async () => { assert.fail("dry-run called API"); }, uploadBytes: async () => { assert.fail("dry-run uploaded"); },
		});
		assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
	}
});

test("env-only selects configured identity and never reads alternate files or commands", async (t) => {
	for (const identity of ["default", "user", "bot"]) for (const custom of [false, true]) for (const selected of ["present", "empty", "missing"]) {
		const f = fixture(t);
		const key = custom ? identity === "bot" ? "CUSTOM_BOT" : "CUSTOM_USER" : identity === "bot" ? "SLACK_BOT_TOKEN" : "SLACK_USER_TOKEN";
		f.env.CUSTOM_USER = "alternate-user"; f.env.CUSTOM_BOT = "alternate-bot";
		const marker = join(f.cwd, "command-ran");
		f.file("agent/settings.json", JSON.stringify({ quiver: { slack: {
			userTokenCommand: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('alternate')`],
			...(custom ? { userTokenEnv: "CUSTOM_USER", botTokenEnv: "CUSTOM_BOT" } : {}),
		} } }));
		mkdirSync(join(f.cwd, ".env"));
		const homeEnv = userConfigEnvPath(f.env)!; mkdirSync(homeEnv, { recursive: true });
		if (selected === "missing") delete f.env[key]; else f.env[key] = selected === "empty" ? "" : "chosen\nsecret";
		const args = [...post, ...(identity === "default" ? [] : ["--as", identity]), "--token-from-env"];
		const r = await f.run(args, selected === "present" ? [{ ...sent }, { ...link }] : []);
		assert.equal(r.code, selected === "present" ? 0 : 3, r.stderr);
		if (selected === "present") assert.equal(r.calls[0].token, "chosen\nsecret");
		assert.ok(!r.stderr.includes("chosen\nsecret"));
		assert.throws(() => readFileSync(marker));
	}
});

test("dry-run validates plain sizes but permits upload candidates before credentials", async (t) => {
	for (const row of [
		{ args: [...post, "--as", "user"], code: 0 },
		{ args: ["post", "--channel", "C1", "--text", "two\nlines"], code: 2 },
		{ args: ["post", "--channel", "C1", "--text", "", "--as", "bot"], code: 2 },
		{ args: ["post", "--channel", "C1", "--text", "x".repeat(4001), "--as", "bot"], code: 2 },
		{ args: ["dm", "--user", "U1", "--text", "x".repeat(4001)], code: 2 },
		{ args: ["reply", "--channel", "C1", "--thread-ts", "100.1", "--text", "x".repeat(4001)], code: 0 },
		{ args: [...post, "--detail", "x".repeat(4001)], code: 0 },
		{ args: ["post", "--channel", "C1", "--text", "two\nlines", "--as", "bot", "--detail", "x".repeat(4001)], code: 0 },
		{ args: ["dm", "--user", "U1", "--text", "hi", "--blocks-file", "bad"], code: 2 },
	]) {
		const f = fixture(t); f.file("bad", "{}");
		const r = await f.run([...row.args, "--dry-run"], []);
		assert.equal(r.code, row.code, r.stderr); assert.equal(r.stdout, "");
	}
});

const BIN = fileURLToPath(new URL("../bin/pi-quiver.ts", import.meta.url));

test("help and version are offline even with invalid settings and absent credentials", () => {
	const f = fixture();
	try {
		delete f.env.SLACK_USER_TOKEN; delete f.env.SLACK_BOT_TOKEN;
		mkdirSync(f.env.PI_CODING_AGENT_DIR!, { recursive: true });
		writeFileSync(join(f.env.PI_CODING_AGENT_DIR!, "settings.json"), "invalid");
		for (const args of [["slack", "--help"], ["--version"]]) {
			const result = spawnSync(process.execPath, [BIN, ...args], { env: f.env, cwd: f.cwd, encoding: "utf8" });
			assert.equal(result.status, 0);
			assert.equal(result.stderr, "");
			if (args[0] === "--version") assert.equal(result.stdout, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version + "\n");
			else for (const flag of ["post", "reply", "dm", "canvas", "--channel", "--text", "--detail", "--detail-file", "--blocks-file", "--as", "--thread-ts", "--text-file", "--user", "--id", "--markdown-file", "--no-unfurl", "--token-from-env", "--dry-run"]) assert.ok(result.stdout.includes(flag));
		}
	} finally { f.close(); }
});

test("local file and headline usage failures precede credentials and transport", async () => {
	const cases = [
		["post", "--channel", "C1", "--text", ""],
		["post", "--channel", "C1", "--text", "two\nlines"],
		["post", "--channel", "C1", "--text", "two\nlines", "--as", "user"],
		["post", "--channel", "C1", "--text", "", "--as", "bot"],
		["post", "--channel", "C1", "--text", "x".repeat(4001)],
		["post", "--channel", "C1", "--text", "hi", "--detail-file", "missing"],
		["post", "--channel", "C1", "--text", "hi", "--blocks-file", "missing"],
		["reply", "--channel", "C1", "--thread-ts", "100.1", "--text-file", "missing"],
		["dm", "--user", "U1", "--text", ""],
		["dm", "--user", "U1", "--text-file", "empty"],
		["canvas", "--id", "F1", "--markdown-file", "missing"],
	];
	for (const args of cases) {
		const f = fixture();
		try {
			delete f.env.SLACK_USER_TOKEN;
			if (args.includes("empty")) f.file("empty", "");
			const r = await f.run(args, []);
			assert.equal(r.code, 2);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, /^usage: /);
			if (args.includes("missing")) assert.match(r.stderr, /missing/);
		} finally { f.close(); }
	}
	for (const sub of ["post", "dm"]) for (const content of ["{}", "{bad"]) {
		const f = fixture();
		try {
			f.file("blocks", content);
			const r = await f.run([sub, ...(sub === "post" ? ["--channel", "C1"] : ["--user", "U1"]), "--text", "hi", "--blocks-file", "blocks"], []);
			assert.equal(r.code, 2);
			assert.match(r.stderr, /^usage: .*blocks/);
		} finally { f.close(); }
	}
});

test("error classification distinguishes definitive, unknown and non-mutating failures and redacts literal tokens", async () => {
	for (const row of [
		{ sub: "post", error: new SlackError("channel_not_found", "channel_not_found"), code: 4, err: "channel_not_found; check the name or run slack_cache_refresh\n" },
		{ sub: "post", error: new SlackError("transport", "bad synthetic\nsecret"), code: 5, err: "transport: bad <redacted>\nCheck the channel before retrying.\n" },
		{ sub: "post", error: new SyntaxError("bad JSON"), code: 5, err: "slack failed: bad JSON\nCheck the channel before retrying.\n" },
		{ sub: "dm", error: new SlackError("transport", "offline"), code: 4, err: "transport: offline\n" },
		{ sub: "dm", error: new SlackError("unexpected_response", "malformed"), code: 4, err: "unexpected_response: malformed\n" },
		...['internal_error', 'fatal_error', 'transport', 'invalid_auth', 'http_500', 'rate_limited'].map((code) => ({ sub: "canvas", error: new SlackError(code, code), code: ["internal_error", "fatal_error", "transport"].includes(code) ? 5 : 4, err: code + "\n" + (["internal_error", "fatal_error", "transport"].includes(code) ? "Check the channel before retrying.\n" : "") })),
	]) {
		const f = fixture();
		try {
			f.env.SLACK_USER_TOKEN = "synthetic\nsecret";
			if (row.sub === "canvas") f.file("md", "markdown");
			const args = row.sub === "post" ? ["post", "--channel", "C1", "--text", "hi"] : row.sub === "dm" ? ["dm", "--user", "U1", "--text", "hi"] : ["canvas", "--id", "F1", "--markdown-file", "md"];
			const method = row.sub === "post" ? "chat.postMessage" : row.sub === "dm" ? "conversations.open" : "canvases.edit";
			const r = await f.run(args, [{ method, error: row.error }]);
			assert.equal(r.code, row.code);
			assert.equal(r.stdout, row.code === 4 ? `error=${(row.error as SlackError).code}\n` : "");
			assert.equal(r.stderr, row.err);
			assert.ok(!r.stderr.includes(f.env.SLACK_USER_TOKEN));
		} finally { f.close(); }
	}
});

test("DM missing channel and over-limit text never post; permalink failure stays successful", async () => {
	const f = fixture();
	try {
		const absent = await f.run(["dm", "--user", "U1", "--text", "hi"], [{ method: "conversations.open" }]);
		assert.deepEqual({ code: absent.code, out: absent.stdout, err: absent.stderr }, { code: 4, out: "error=unexpected_response\n", err: "unexpected_response: conversations.open returned no channel.id\n" });
		const long = await f.run(["dm", "--user", "U1", "--text", "x".repeat(4001)], [{ method: "conversations.open", result: { channel: { id: "D1" } } }]);
		assert.equal(long.code, 4);
		assert.equal(long.stdout, "error=text_too_long\n");
		assert.equal(long.stderr, "text_too_long: text is 4001 UTF-16 code units, over the 4000 limit; use thread_body for announcements or slack_upload for documents.\n");
		const warning = await f.run(["post", "--channel", "C1", "--text", "hi"], [{ ...sent }, { method: "chat.getPermalink", error: new SlackError("transport", "synthetic-user") }]);
		assert.equal(warning.code, 0);
		assert.equal(warning.stdout, "ts=100.1\n");
		assert.equal(warning.stderr, "Could not fetch a permalink for this message: <redacted>\n");
	} finally { f.close(); }
});

test("missing credentials and unreadable .env stay pre-send failures", async () => {
	const f = fixture();
	try {
		delete f.env.SLACK_USER_TOKEN;
		const missing = await f.run(["post", "--channel", "C1", "--text", "hi"], []);
		assert.equal(missing.code, 3);
		assert.equal(missing.stdout, "");
		assert.match(missing.stderr, /^missing_token: No Slack user token:/);
		const dryMissing = await f.run([...post, "--dry-run"], []);
		assert.equal(dryMissing.code, 3); assert.equal(dryMissing.stdout, "");
		mkdirSync(join(f.cwd, ".env"));
		const runtime = await f.run(["post", "--channel", "C1", "--text", "hi"], []);
		assert.equal(runtime.code, 1);
		assert.equal(runtime.stdout, "");
		assert.match(runtime.stderr, /^slack failed: /);
		const dryRuntime = await f.run([...post, "--dry-run"], []);
		assert.equal(dryRuntime.code, 1); assert.equal(dryRuntime.stdout, "");
	} finally { f.close(); }
});

test("credentials follow command/env/worktree/primary/user precedence for user, default and bot", async (t) => {
	for (const identity of ["default", "user", "bot"]) {
		for (const winner of identity === "bot" ? ["env", "repo", "primary", "home"] : ["command", "env", "repo", "primary", "home"]) {
			const f = fixture(t);
			const primary = f.cwd;
			execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: primary });
			const worktree = join(primary, "linked");
			execFileSync("git", ["worktree", "add", "--quiet", "-b", "fixture", worktree], { cwd: primary });
			const cwd = join(worktree, "nested"); mkdirSync(cwd);
			const key = identity === "bot" ? "SLACK_BOT_TOKEN" : "SLACK_USER_TOKEN";
			delete f.env.SLACK_USER_TOKEN; delete f.env.SLACK_BOT_TOKEN;
			const order = ["command", "env", "repo", "primary", "home"];
			const rank = order.indexOf(winner);
			const tokens = Object.fromEntries(order.map((source) => [source, `synthetic-${identity}-${source}`]));
			const command = [process.execPath, "-e", `process.stdout.write(${JSON.stringify(tokens.command)})`];
			f.file("agent/settings.json", JSON.stringify({ quiver: { slack: { userTokenCommand: identity === "bot" ? [process.execPath, "-e", "process.exit(9)"] : rank === 0 ? command : undefined } } }));
			f.env[key] = rank <= 1 ? tokens.env : "";
			writeFileSync(join(worktree, ".env"), `${key}=${rank <= 2 ? tokens.repo : ""}\n`);
			writeFileSync(join(primary, ".env"), `${key}=${rank <= 3 ? tokens.primary : ""}\n`);
			const homeEnv = userConfigEnvPath(f.env)!; mkdirSync(join(homeEnv, ".."), { recursive: true }); writeFileSync(homeEnv, `${key}=${tokens.home}\n`);
			const r = await f.run([...post, ...(identity === "default" ? [] : ["--as", identity])], [{ ...sent }, { ...link }], { cwd });
			assert.equal(r.code, 0, r.stderr); assert.equal(r.stderr, "");
			assert.ok(r.calls.every((call) => call.token === tokens[winner]), `${identity}/${winner}`);
			const dry = await f.run([...post, ...(identity === "default" ? [] : ["--as", identity]), "--dry-run"], [], { cwd });
			assert.equal(dry.code, 0, dry.stderr); assert.equal(dry.stdout, "");
			for (const value of Object.values(tokens)) assert.ok(!(r.stdout + r.stderr).includes(value));
		}
	}
});

test("configured user command is sole-source, times out, and bot never invokes it", async (t) => {
	for (const mode of ["failure", "empty", "timeout"]) {
		const f = fixture(t);
		f.file(".env", "SLACK_USER_TOKEN=synthetic-repo-fallback\n");
		const code = mode === "failure" ? "process.exit(7)" : mode === "empty" ? "" : "setTimeout(() => {}, 10000)";
		f.file("agent/settings.json", JSON.stringify({ quiver: { slack: { userTokenCommand: [process.execPath, "-e", code], userTokenCommandTimeoutSeconds: mode === "timeout" ? 0.01 : 2 } } }));
		const r = await f.run(post, []);
		assert.equal(r.code, 3); assert.equal(r.stdout, ""); assert.match(r.stderr, mode === "empty" ? /missing_token/ : /credential_command_failed/);
		if (mode === "timeout") assert.match(r.stderr, /timed out after 10ms/);
		const dry = await f.run([...post, "--dry-run"], []);
		assert.equal(dry.code, 3); assert.equal(dry.stdout, "");
		const bot = await f.run([...post, "--as", "bot"], [{ ...sent }, { ...link }]);
		assert.equal(bot.code, 0); assert.equal(bot.calls[0].token, "synthetic-bot");
	}
});

test("repo settings and env overlay agent settings, enabled false still opts in", async (t) => {
	for (const overlay of [false, true]) {
		const f = fixture(t);
		f.file("agent/settings.json", JSON.stringify({ quiver: { slack: { enabled: false, userTokenEnv: "AGENT_TOKEN", uploadThresholdChars: 1 } } }));
		f.file(".pi/settings.json", JSON.stringify({ quiver: { slack: { enabled: false, userTokenEnv: "REPO_TOKEN", uploadThresholdChars: 20 } } }));
		f.env.AGENT_TOKEN = "synthetic-agent"; f.env.REPO_TOKEN = "synthetic-repo"; f.env.OVERLAY_TOKEN = "synthetic-overlay";
		if (overlay) { f.env.PI_QUIVER_SLACK_USER_TOKEN_ENV = "OVERLAY_TOKEN"; f.env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS = "30"; }
		const body = "a".repeat(overlay ? 25 : 15);
		const r = await f.run(["reply", "--channel", "C123456", "--thread-ts", "100.1", "--text", body], [{ ...sent }, { ...link }]);
		assert.equal(r.code, 0); assert.equal(r.calls[0].token, overlay ? "synthetic-overlay" : "synthetic-repo"); assert.equal(r.calls[0].params.text, body);
		const envOnly = await f.run([...post, "--token-from-env"], [{ ...sent }, { ...link }]);
		assert.equal(envOnly.code, 0); assert.equal(envOnly.calls[0].token, overlay ? "synthetic-overlay" : "synthetic-repo");
	}
});

test("oversize reply uploads unchanged body and prints thread ts, not intro ts", async (t) => {
	const f = fixture(t); f.env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS = "3";
	const uploads: { url: string; body: string }[] = [];
	const r = await f.run(["reply", "--channel", "C123456", "--thread-ts", "100.1", "--text", "long body"], [
		{ method: "chat.postMessage", result: { ts: "100.2" } },
		{ method: "files.getUploadURLExternal", result: { upload_url: "https://example.test/upload", file_id: "F123456" } },
		{ method: "files.completeUploadExternal", result: { files: [] } },
	], { uploadBytes: async (url, bytes) => { uploads.push({ url, body: new TextDecoder().decode(bytes) }); } });
	assert.equal(r.code, 0); assert.equal(r.stdout, "ts=100.1 detail_ts=100.2\n"); assert.equal(r.stderr, "");
	assert.deepEqual(uploads, [{ url: "https://example.test/upload", body: "long body" }]);
	assert.deepEqual(r.calls[0].params, { channel: "C123456", text: "Detail attached.", thread_ts: "100.1" });
	assert.equal(r.calls[2].params.thread_ts, "100.1"); assert.equal(r.calls[2].opts?.retry, false);
});

test("detail_failed preserves landed headline only, and reply failure keeps persisted-path stderr", async (t) => {
	for (const reply of [false, true]) {
		const f = fixture(t);
		if (reply) f.env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS = "1";
		const args = reply ? ["reply", "--channel", "C123456", "--thread-ts", "100.1", "--text", "body"] : [...post, "--detail", "body"];
		const script: ScriptEntry[] = reply ? [
			{ method: "chat.postMessage", result: { ts: "100.2" } }, { method: "files.getUploadURLExternal", error: new SlackError("transport", "upload failed") },
		] : [{ ...sent }, { ...link }, { method: "chat.postMessage", error: new SlackError("invalid_blocks", "bad blocks") }, { method: "chat.update" }];
		const r = await f.run(args, script);
		assert.equal(r.code, 4); assert.equal(r.stdout, reply ? "error=detail_failed\n" : "ts=100.1 error=detail_failed\n");
		assert.match(r.stderr, /detail_failed:/); assert.match(r.stderr, /saved to .*detail\.md/); assert.ok(!r.stderr.includes("Check the channel before retrying."));
	}
});


test("canvas JSON transport, ok:false errors and raw non-JSON mutation responses", async (t) => {
	const original = globalThis.fetch;
	try {
		for (const kind of ["canvas", "definitive", "non-json", "rate-limit"]) {
			const f = fixture(t); f.file("body", "# markdown\n");
			let requests = 0;
			globalThis.fetch = async (input, init) => {
				requests++;
				assert.match(String(input), kind === "canvas" ? /canvases.edit$/ : /chat.postMessage$/);
				assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
				if (kind === "canvas") assert.deepEqual(JSON.parse(String(init?.body)), { canvas_id: "F123456", changes: [{ operation: "replace", document_content: { type: "markdown", markdown: "# markdown\n" } }] });
				if (kind === "rate-limit") return new Response("", { status: 429, headers: { "retry-after": "0" } });
				return kind === "non-json" ? new Response("not JSON") : Response.json(kind === "definitive" ? { ok: false, error: "channel_not_found" } : { ok: true });
			};
			const r = await f.run(kind === "canvas" ? ["canvas", "--id", "F123456", "--markdown-file", "body"] : post, [], { apiCall: makeApiCall() });
			assert.equal(requests, kind === "rate-limit" ? 2 : 1); assert.equal(r.code, kind === "canvas" ? 0 : kind === "definitive" || kind === "rate-limit" ? 4 : 5);
			assert.equal(r.stdout, kind === "canvas" ? "canvas=F123456\n" : kind === "definitive" ? "error=channel_not_found\n" : kind === "rate-limit" ? "error=rate_limited\n" : "");
			if (kind === "definitive") assert.equal(r.stderr, "channel_not_found: check the name or run slack_cache_refresh\n");
			if (kind === "non-json") assert.match(r.stderr, /Check the channel before retrying\.\n$/);
		}
	} finally { globalThis.fetch = original; }
});

test("settings lint warnings remain nonfatal and are buffered for token redaction", async (t) => {
	const f = fixture(t);
	const token = f.env.SLACK_USER_TOKEN!;
	f.file("agent/settings.json", JSON.stringify({ fastMode: false, quiver: { slack: { [token]: true } } }));
	const r = await f.run(post, [{ ...sent }, { ...link }]);
	assert.equal(r.code, 0); assert.match(r.stderr, /<redacted>/); assert.match(r.stderr, /unknown/i); assert.match(r.stderr, /"fastMode" at top level - move under "quiver"/);
});

test("all result fields pass through literal token redaction", async (t) => {
	const f = fixture(t);
	f.env.SLACK_USER_TOKEN = "synthetic\nsecret";
	const r = await f.run(post, [
		{ method: "chat.postMessage", result: { ts: "synthetic\nsecret" } },
		{ method: "chat.getPermalink", result: { permalink: "https://example.test/synthetic\nsecret" } },
	]);
	assert.equal(r.code, 0);
	assert.equal(r.stdout, "ts=<redacted> permalink=https://example.test/<redacted>\n");
	assert.equal(r.stderr, "");
});
