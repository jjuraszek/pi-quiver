import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCliArgs, runSlack } from "../bin/pi-quiver.ts";
import { SlackError, makeApiCall, userConfigEnvPath, type ApiCall, type ApiOpts, type UploadBytes } from "../lib/slack-core.ts";

const harnessPath = fileURLToPath(new URL("./fixtures/slack-cli-harness.mjs", import.meta.url));
const post = ["post", "--channel", "C1", "--text", "hello"];
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "quiver-slack-safety-"));
	execFileSync("git", ["init", "--quiet", cwd]);
	const env: NodeJS.ProcessEnv = { HOME: join(cwd, "home"), USERPROFILE: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "xdg"), APPDATA: join(cwd, "appdata"), PI_CODING_AGENT_DIR: join(cwd, "agent"), SLACK_USER_TOKEN: "synthetic\nsecret" };
	function file(path: string, content: string) { const full = join(cwd, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, content); return full; }
	return { cwd, env, file };
}
interface ScriptEntry { method: string; result?: Record<string, unknown>; error?: Error }
function scriptedApiCall(script: ScriptEntry[]) {
	const calls: { method: string; params: Record<string, unknown>; opts?: ApiOpts }[] = [];
	let i = 0;
	const apiCall: ApiCall = async (method, _token, params, opts) => {
		calls.push({ method, params, opts });
		const entry = script[i++];
		assert.ok(entry, `unexpected apiCall: ${method}`);
		assert.equal(entry.method, method);
		if (entry.error) throw entry.error;
		return entry.result ?? {};
	};
	return { apiCall, calls, exhausted: () => assert.equal(i, script.length) };
}
async function run(f: ReturnType<typeof fixture>, args: string[], script: ScriptEntry[], apiCall?: ApiCall, uploadBytes: UploadBytes = async (_url: string, _bytes: Uint8Array) => { throw new Error("unexpected upload"); }) {
	const parsed = parseCliArgs(["slack", ...args]);
	assert.ok(parsed.ok && parsed.cmd === "slack");
	const transport = scriptedApiCall(script);
	let stdout = "", stderr = "";
	const code = await runSlack(parsed, { ...f, apiCall: apiCall ?? transport.apiCall, uploadBytes, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
	transport.exhausted();
	assert.ok(!(stdout + stderr).includes("synthetic\nsecret"));
	return { code, stdout, stderr, calls: transport.calls };
}

for (const text of [undefined, "flag-value"]) test(`piped stdin is ignored with text=${text}`, () => {
	const f = fixture();
	const argv = ["slack", "post", "--channel", "C1", ...(text ? ["--text", text] : [])];
	const result = spawnSync(process.execPath, [harnessPath, ...argv], { cwd: f.cwd, input: "piped text that must not send", encoding: "utf8", timeout: 10000, env: f.env });
	assert.equal(result.error, undefined);
	assert.equal(result.status, text ? 0 : 2, result.stderr);
	assert.equal(result.stderr, "");
	const captured = JSON.parse(result.stdout);
	assert.equal(captured.code, result.status);
	if (text) {
		assert.deepEqual(captured.calls, [{ method: "chat.postMessage", params: { channel: "C1", text } }, { method: "chat.getPermalink", params: { channel: "C1", message_ts: "100.1" } }]);
		assert.equal(captured.stdout, "ts=100.1 permalink=https://example.test/message\n");
		assert.equal(captured.stderr, "");
	} else { assert.deepEqual(captured.calls, []); assert.equal(captured.stdout, ""); assert.match(captured.stderr, /^usage: /); }
});

test("env-only dry-run ignores piped stdin without producing a result or calls", () => {
	const f = fixture();
	const result = spawnSync(process.execPath, [harnessPath, "slack", ...post, "--token-from-env", "--dry-run"], { cwd: f.cwd, env: f.env, input: "never send this", encoding: "utf8", timeout: 10000 });
	assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), { code: 0, stdout: "", stderr: "", calls: [] });
});

test("CLI source never touches process.stdin", () => {
	assert.doesNotMatch(readFileSync(new URL("../bin/pi-quiver.ts", import.meta.url), "utf8"), /process\.stdin/);
});

for (const flag of ["--detail-file", "--text-file", "--markdown-file", "--blocks-file"]) {
	for (const shape of ["missing", "directory"]) test(`${flag} ${shape} fails before credentials`, async () => {
		const f = fixture(); delete f.env.SLACK_USER_TOKEN;
		const path = join(f.cwd, shape);
		if (shape === "directory") mkdirSync(path);
		const args = flag === "--text-file" ? ["reply", "--channel", "C1", "--thread-ts", "100.1"] : flag === "--markdown-file" ? ["canvas", "--id", "F1"] : post;
		const r = await run(f, [...args, flag, path], []);
		assert.equal(r.code, 2); assert.equal(r.stdout, ""); assert.equal(r.calls.length, 0);
		assert.ok(r.stderr.includes(path)); assert.match(r.stderr, /^usage: /);
	});
}
for (const content of ["{bad", "{}", "1", "null"]) test(`blocks rejects ${content} before credentials`, async () => {
	const f = fixture(); delete f.env.SLACK_USER_TOKEN;
	const path = f.file("blocks", content);
	const r = await run(f, [...post, "--blocks-file", path], []);
	assert.equal(r.code, 2); assert.equal(r.stdout, ""); assert.equal(r.calls.length, 0); assert.ok(r.stderr.includes(path));
});

function commandSentinel(f: ReturnType<typeof fixture>) {
	const marker = join(f.cwd, "command-ran");
	f.file("agent/settings.json", JSON.stringify({ quiver: { slack: { userTokenCommand: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('command-token')`] } } }));
	return marker;
}

test("local file and content failures precede credential commands in both safety modes", async () => {
	for (const flags of [[], ["--dry-run"], ["--token-from-env"], ["--dry-run", "--token-from-env"]]) {
		const f = fixture(); const marker = commandSentinel(f);
		f.file("bad", "{}"); f.file("empty", ""); mkdirSync(join(f.cwd, "directory"));
		const cases = [
			[...post, "--detail-file", "missing"], [...post, "--detail-file", "directory"],
			["reply", "--channel", "C1", "--thread-ts", "100.1", "--text-file", "missing"],
			["canvas", "--id", "F1", "--markdown-file", "directory"],
			["dm", "--user", "U1", "--text", "hello", "--blocks-file", "missing"],
			["dm", "--user", "U1", "--text", "hello", "--blocks-file", "bad"],
			["dm", "--user", "U1", "--text-file", "empty"],
			["post", "--channel", "C1", "--text", "two\nlines"],
			["post", "--channel", "C1", "--text", "x".repeat(4001)],
			["post", "--channel", "C1", "--text", "", "--as", "bot"],
		];
		for (const args of cases) {
			const r = await run(f, [...args, ...flags], []);
			assert.equal(r.code, 2, JSON.stringify(args)); assert.equal(r.stdout, ""); assert.match(r.stderr, /^usage: /);
			assert.equal(existsSync(marker), false);
		}
	}
});

test("env-only bypasses command and every file source for default, user and bot", async () => {
	for (const identity of ["default", "user", "bot"]) for (const shape of ["tokens", "directories"]) {
		const f = fixture(); const marker = commandSentinel(f);
		// A linked worktree gives repo and primary checkout distinct credential files.
		execFileSync("git", ["-C", f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
		const worktree = join(f.cwd, "linked");
		execFileSync("git", ["-C", f.cwd, "worktree", "add", "--quiet", "--detach", worktree]);
		const paths = [join(worktree, ".env"), join(f.cwd, ".env"), userConfigEnvPath(f.env)!];
		for (const [index, path] of paths.entries()) {
			mkdirSync(join(path, ".."), { recursive: true });
			if (shape === "directories") mkdirSync(path);
			else writeFileSync(path, `CUSTOM_USER=file-user-${index}\nCUSTOM_BOT=file-bot-${index}\n`);
		}
		f.file("linked/.pi/settings.json", JSON.stringify({ quiver: { slack: { userTokenEnv: "CUSTOM_USER", botTokenEnv: "CUSTOM_BOT" } } }));
		f.env.CUSTOM_USER = "selected-user\nsecret"; f.env.CUSTOM_BOT = "selected-bot\nsecret";
		const key = identity === "bot" ? "CUSTOM_BOT" : "CUSTOM_USER";
		for (const dry of [false, true]) for (const state of ["present", "empty", "missing"]) {
			const token = identity === "bot" ? "selected-bot\nsecret" : "selected-user\nsecret";
			if (state === "missing") delete f.env[key]; else f.env[key] = state === "empty" ? "" : token;
			const args = [...post, ...(identity === "default" ? [] : ["--as", identity]), "--token-from-env", ...(dry ? ["--dry-run"] : [])];
			const seen: string[] = [];
			const api: ApiCall = async (method, credential) => {
				seen.push(credential);
				if (method === "chat.postMessage") throw new SlackError("invalid_auth", `misleading missing_scope ${credential}`);
				assert.fail(`unexpected ${method}`);
			};
			const r = await run({ ...f, cwd: worktree }, args, [], api);
			assert.equal(r.code, state !== "present" ? 3 : dry ? 0 : 4, r.stderr);
			assert.equal(r.stdout, state === "present" && !dry ? "error=invalid_auth\n" : "");
			assert.deepEqual(seen, state === "present" && !dry ? [token] : []);
			assert.ok(!(r.stdout + r.stderr).includes(token)); assert.equal(existsSync(marker), false);
		}
	}
});

// Global fetch is replaced only within this serial test and restored even on assertion failure.
test("real API mapping, exhausted retry and raw JSON failures stay offline", async () => {
	const original = globalThis.fetch;
	try {
		for (const kind of ["channel_not_found", "not_in_channel", "msg_too_long", "invalid_auth", "missing_scope", "rate_limited", "http_503", "non-json"]) {
			const f = fixture(); f.env.SLACK_USER_TOKEN = "synthetic-valid-header";
			let requests = 0;
			const sleeps: number[] = [];
			globalThis.fetch = async (input) => {
				requests++; assert.match(String(input), /\/api\/chat.postMessage$/);
				if (kind === "rate_limited") return new Response("", { status: 429, headers: { "retry-after": "1" } });
				if (kind === "http_503") return new Response("", { status: 503 });
				if (kind === "non-json") return new Response("not JSON");
				return Response.json({ ok: false, error: kind, needed: "chat:write", extra: "sentinel-private-data" });
			};
			const r = await run(f, post, [], makeApiCall("https://example.test", async (ms) => { sleeps.push(ms); }));
			assert.equal(r.code, kind === "non-json" ? 5 : 4); assert.equal(r.stdout, kind === "non-json" ? "" : `error=${kind}\n`);
			assert.equal(requests, kind === "rate_limited" ? 2 : 1);
			assert.deepEqual(sleeps, kind === "rate_limited" ? [1000] : []);
			assert.ok(!r.stderr.includes("sentinel-private-data"));
			if (kind === "non-json") assert.match(r.stderr, /Check the channel before retrying\.\n$/);
			else assert.ok(r.stderr.includes(kind));
			if (kind === "missing_scope") assert.match(r.stderr, /"chat:write" scope/);
		}
	} finally { globalThis.fetch = original; }
});

test("dry-run exercises normal credential sources without network or persisted detail", async () => {
	for (const identity of ["default", "user", "bot"]) for (const source of ["command", "env", "repo", "primary", "user"]) {
		if (identity === "bot" && source === "command") continue;
		const f = fixture(); delete f.env.SLACK_USER_TOKEN;
		const key = identity === "bot" ? "SLACK_BOT_TOKEN" : "SLACK_USER_TOKEN";
		let cwd = f.cwd; let marker: string | undefined;
		if (source === "command") marker = commandSentinel(f);
		else if (source === "env") f.env[key] = "normal-env-token";
		else if (source === "user") {
			const path = userConfigEnvPath(f.env)!; mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, `${key}=normal-user-token\n`);
		} else {
			f.file(".env", `${key}=normal-file-token\n`);
			if (source === "primary") {
				execFileSync("git", ["-C", f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
				cwd = join(f.cwd, "linked"); execFileSync("git", ["-C", f.cwd, "worktree", "add", "--quiet", "--detach", cwd]);
			}
		}
		const body = `unique dry-run detail ${f.cwd}\n${"x".repeat(5000)}`;
		const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
		const artifacts = () => existsSync(join(tmpdir(), "pi-slack")) ? readdirSync(join(tmpdir(), "pi-slack")).filter((name) => name.endsWith(`-${hash}-detail.md`)) : [];
		const before = artifacts();
		f.file("body", body);
		for (const args of [
			[...post, "--detail", body],
			["reply", "--channel", "C1", "--thread-ts", "100.1", "--text", body],
			["dm", "--user", "U1", "--text", "hello"],
			["canvas", "--id", "F1", "--markdown-file", join(f.cwd, "body")],
		]) {
			let calls = 0;
			const r = await run({ ...f, cwd }, [...args, ...(identity === "default" ? [] : ["--as", identity]), "--dry-run"], [], async () => { calls++; throw new Error("dry-run API sentinel"); }, async () => { calls++; throw new Error("dry-run upload sentinel"); });
			assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, ""); assert.equal(r.stderr, ""); assert.equal(calls, 0);
		}
		assert.deepEqual(artifacts(), before);
		if (marker) assert.equal(readFileSync(marker, "utf8"), "ran");
	}
});

for (const kind of ["short", "oversize", "reply", "headline-unknown"]) test(`${kind} failure persists the exact detail and only reports landed coordinates`, async () => {
	const f = fixture();
	const body = `detail from ${f.cwd}\nunchanged\n`;
	const oversize = kind === "oversize" || kind === "reply";
	if (oversize) f.env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS = "1";
	const sent = { method: "chat.postMessage", result: { ts: "100.1" } };
	const link = { method: "chat.getPermalink", result: { permalink: "https://example.test/message" } };
	const failure = new SlackError("transport", "synthetic\nsecret");
	let script: ScriptEntry[];
	if (kind === "headline-unknown") script = [{ method: "chat.postMessage", error: failure }];
	else if (kind === "reply") script = [sent, { method: "files.getUploadURLExternal", error: failure }];
	else script = [sent, link, ...(oversize ? [{ method: "chat.postMessage", result: { ts: "100.2" } }, { method: "files.getUploadURLExternal", result: { upload_url: "https://example.test/upload", file_id: "F1" } }, { method: "files.completeUploadExternal", error: failure }] : [{ method: "chat.postMessage", error: failure }]), { method: "chat.update" }];
	const args = kind === "reply" ? ["reply", "--channel", "C1", "--thread-ts", "99.1", "--text", body] : [...post, "--detail", body];
	const r = await run(f, args, script, undefined, async (_url, bytes) => { assert.equal(new TextDecoder().decode(bytes), body); });
	assert.equal(r.code, kind === "headline-unknown" ? 5 : 4);
	assert.equal(r.stdout, kind === "headline-unknown" ? "" : `${kind === "reply" ? "" : "ts=100.1 "}error=detail_failed\n`);
	if (kind === "reply") assert.equal(r.calls[0].params.thread_ts, "99.1");
	const path = r.stderr.match(/saved to (.+?-detail\.md)/)?.[1];
	assert.ok(path, r.stderr); assert.equal(readFileSync(path, "utf8"), body);
	assert.match(r.stderr, kind === "headline-unknown" ? /outcome_unknown:.*re-invoking slack_post/ : /detail_failed:/);
	if (kind === "short" || kind === "oversize") {
		const marker = r.calls.at(-1)!;
		assert.equal(marker.method, "chat.update"); assert.equal(marker.params.ts, "100.1");
		assert.match(String(marker.params.text), /detail pending/); assert.equal(marker.opts?.retry, true);
		assert.equal(r.calls[0].opts?.retry, false);
	}
});

for (const method of ["chat.postMessage", "canvases.edit"]) test(`${method} unknown response redacts message and allowlisted channel without leaking data`, async () => {
	const f = fixture(); f.file("body", "# markdown");
	const args = method === "canvases.edit" ? ["canvas", "--id", "F1", "--markdown-file", "body"] : post;
	const r = await run(f, args, [{ method, error: new SlackError("unexpected_response", "bad synthetic\nsecret", { channel: "synthetic\nsecret", ts: "synthetic\nsecret", extra: "sentinel-private-data" }) }]);
	assert.equal(r.code, 5); assert.equal(r.stdout, "");
	assert.equal(r.stderr, "unexpected_response: bad <redacted> channel=<redacted>\nCheck the channel before retrying.\n");
});

test("structured definitive codes, not misleading messages, determine redacted stdout", async () => {
	for (const method of ["chat.postMessage", "canvases.edit", "conversations.open"]) for (const code of ["invalid_auth", "missing_scope", "channel_not_found", "synthetic\nsecret"]) {
		const f = fixture(); f.file("body", "# document");
		const args = method === "canvases.edit" ? ["canvas", "--id", "F1", "--markdown-file", "body"] : method === "conversations.open" ? ["dm", "--user", "U1", "--text", "hello"] : post;
		const r = await run(f, args, [{ method, error: new SlackError(code, "misleading detail_failed synthetic\nsecret", { extra: "sentinel-private-data" }) }]);
		assert.equal(r.code, 4); assert.equal(r.stdout, `error=${code === "synthetic\nsecret" ? "<redacted>" : code}\n`);
		assert.ok(!r.stderr.includes("sentinel-private-data")); assert.match(r.stderr, /misleading detail_failed <redacted>/);
	}
});

test("dry-run keeps missing credentials and unreadable normal dotenv classifications", async () => {
	for (const kind of ["missing", "empty-env-only", "unreadable-dotenv", "command-failed"]) {
		const f = fixture(); delete f.env.SLACK_USER_TOKEN;
		if (kind === "empty-env-only") { f.env.SLACK_USER_TOKEN = ""; commandSentinel(f); f.file(".env", "SLACK_USER_TOKEN=alternate\n"); }
		if (kind === "unreadable-dotenv") mkdirSync(join(f.cwd, ".env"));
		if (kind === "command-failed") f.file("agent/settings.json", JSON.stringify({ quiver: { slack: { userTokenCommand: [process.execPath, "-e", "process.exit(1)"] } } }));
		const r = await run(f, [...post, "--dry-run", ...(kind === "empty-env-only" ? ["--token-from-env"] : [])], []);
		assert.equal(r.code, kind === "unreadable-dotenv" ? 1 : 3, r.stderr); assert.equal(r.stdout, "");
		if (kind !== "unreadable-dotenv") assert.match(r.stderr, kind === "command-failed" ? /credential_command_failed/ : /missing_token/);
	}
});

test("partial delivery redacts allowlisted ts and channel and omits all other data", async () => {
	const f = fixture();
	const r = await run(f, post, [{ method: "chat.postMessage", error: new SlackError("detail_failed", "saved detail", { ts: "synthetic\nsecret", channel: "synthetic\nsecret", permalink: "sentinel-private-data", detailPath: "sentinel-private-data" }) }]);
	assert.equal(r.code, 4); assert.equal(r.stdout, "ts=<redacted> error=detail_failed\n");
	assert.equal(r.stderr, "detail_failed: saved detail channel=<redacted>\n");
});

for (const kind of ["invalid_auth", "transport", "unexpected_response", "missing-channel", "utf16-limit"]) test(`DM ${kind} never posts`, async () => {
	const f = fixture();
	const result = kind === "utf16-limit" ? { channel: { id: "D1" } } : {};
	const error = ["missing-channel", "utf16-limit"].includes(kind) ? undefined : new SlackError(kind, kind);
	const r = await run(f, ["dm", "--user", "U1", "--text", kind === "utf16-limit" ? "\uD83D\uDE00".repeat(2001) : "hello"], [{ method: "conversations.open", result, error }]);
	assert.equal(r.code, 4); assert.equal(r.stdout, `error=${kind === "missing-channel" ? "unexpected_response" : kind === "utf16-limit" ? "text_too_long" : kind}\n`);
	assert.deepEqual(r.calls.map((c) => c.method), ["conversations.open"]);
	assert.deepEqual(r.calls[0].params, { users: "U1" }); assert.equal(r.calls[0].opts?.retry, true);
	if (kind === "utf16-limit") assert.match(r.stderr, /text_too_long: text is 4002 UTF-16 code units/);
});
