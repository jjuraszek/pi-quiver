import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
	DEFAULT_SLACK_CONFIG,
	SlackError,
	coerce,
	applyEnvOverrides,
	resolveSlackConfig,
	discoverRepoRoot,
	primaryCheckoutRoot,
	parseEnvFile,
	resolveToken,
	type SlackConfig,
} from "../lib/slack-core.ts";

function withSettings(
	global: Record<string, unknown>,
	project: Record<string, unknown>,
	fn: (cwd: string, files: { globalFile: string; projectFile: string }) => void,
): void {
	const agentDir = mkdtempSync(join(tmpdir(), "quiver-slack-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "quiver-slack-project-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const globalFile = join(agentDir, "settings.json");
		writeFileSync(globalFile, JSON.stringify(global));
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		const projectFile = join(projectDir, ".pi", "settings.json");
		writeFileSync(projectFile, JSON.stringify(project));
		fn(projectDir, { globalFile, projectFile });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}

const NO_ENV: Record<string, string | undefined> = {};

// --- 1: no settings anywhere -> defaults ---

test("no settings anywhere resolves to DEFAULT_SLACK_CONFIG", () => {
	withSettings({}, {}, (cwd) => {
		assert.deepEqual(resolveSlackConfig(cwd, NO_ENV), DEFAULT_SLACK_CONFIG);
	});
});

// --- 2: per-field merge across layers ---

test("pi-home enabled + repo cachePath merge per field", () => {
	withSettings({ quiver: { slack: { enabled: true } } }, { quiver: { slack: { cachePath: "x.json" } } }, (cwd) => {
		const cfg = resolveSlackConfig(cwd, NO_ENV);
		assert.equal(cfg.enabled, true);
		assert.equal(cfg.cachePath, "x.json");
	});
});

// --- 3: repo wins over pi-home for same field ---

test("repo uploadThresholdChars beats pi-home", () => {
	withSettings(
		{ quiver: { slack: { uploadThresholdChars: 2000 } } },
		{ quiver: { slack: { uploadThresholdChars: 3000 } } },
		(cwd) => {
			assert.equal(resolveSlackConfig(cwd, NO_ENV).uploadThresholdChars, 3000);
		},
	);
});

// --- 4: boolean shorthand ---

test("boolean shorthand quiver.slack = true sets enabled, defaults elsewhere", () => {
	withSettings({}, { quiver: { slack: true } }, (cwd) => {
		const cfg = resolveSlackConfig(cwd, NO_ENV);
		assert.equal(cfg.enabled, true);
		assert.equal(cfg.userTokenEnv, DEFAULT_SLACK_CONFIG.userTokenEnv);
		assert.equal(cfg.botTokenEnv, DEFAULT_SLACK_CONFIG.botTokenEnv);
		assert.equal(cfg.uploadThresholdChars, DEFAULT_SLACK_CONFIG.uploadThresholdChars);
		assert.equal(cfg.cachePath, DEFAULT_SLACK_CONFIG.cachePath);
	});
});

// --- 5: flat top-level "slack" is ignored (nested-only) ---

test("flat top-level slack key is ignored", () => {
	withSettings({}, { slack: { enabled: true } }, (cwd) => {
		assert.equal(resolveSlackConfig(cwd, NO_ENV).enabled, false);
	});
});

// --- 6: env rung beats repo ---

test("PI_QUIVER_SLACK_ENABLED beats repo enabled:true", () => {
	withSettings({}, { quiver: { slack: { enabled: true } } }, (cwd) => {
		const cfg = resolveSlackConfig(cwd, { PI_QUIVER_SLACK_ENABLED: "false" });
		assert.equal(cfg.enabled, false);
	});
});

test("PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS overrides", () => {
	withSettings({}, {}, (cwd) => {
		const cfg = resolveSlackConfig(cwd, { PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS: "2500" });
		assert.equal(cfg.uploadThresholdChars, 2500);
	});
});

test("PI_QUIVER_SLACK_CACHE_PATH / USER_TOKEN_ENV / BOT_TOKEN_ENV override", () => {
	withSettings({}, {}, (cwd) => {
		const cfg = resolveSlackConfig(cwd, {
			PI_QUIVER_SLACK_CACHE_PATH: "/tmp/cache.json",
			PI_QUIVER_SLACK_USER_TOKEN_ENV: "MY_USER_TOKEN",
			PI_QUIVER_SLACK_BOT_TOKEN_ENV: "MY_BOT_TOKEN",
		});
		assert.equal(cfg.cachePath, "/tmp/cache.json");
		assert.equal(cfg.userTokenEnv, "MY_USER_TOKEN");
		assert.equal(cfg.botTokenEnv, "MY_BOT_TOKEN");
	});
});

// --- 7: boolean env parse ---

test("boolean env parse: true/1 -> true, false/0 -> false", () => {
	const base: SlackConfig = { ...DEFAULT_SLACK_CONFIG };
	assert.equal(applyEnvOverrides(base, { PI_QUIVER_SLACK_ENABLED: "true" }).enabled, true);
	assert.equal(applyEnvOverrides(base, { PI_QUIVER_SLACK_ENABLED: "1" }).enabled, true);
	assert.equal(applyEnvOverrides({ ...base, enabled: true }, { PI_QUIVER_SLACK_ENABLED: "false" }).enabled, false);
	assert.equal(applyEnvOverrides({ ...base, enabled: true }, { PI_QUIVER_SLACK_ENABLED: "0" }).enabled, false);
});

test("malformed boolean env warns once, rung skipped, deduped across calls", () => {
	const warnings: string[] = [];
	const warn = (m: string) => warnings.push(m);
	const cfgWithRepoTrue: SlackConfig = { ...DEFAULT_SLACK_CONFIG, enabled: true };
	const result1 = applyEnvOverrides(cfgWithRepoTrue, { PI_QUIVER_SLACK_ENABLED: "yes" }, warn);
	assert.equal(result1.enabled, true, "repo value wins when env is malformed");
	assert.equal(warnings.length, 1);
	const result2 = applyEnvOverrides(cfgWithRepoTrue, { PI_QUIVER_SLACK_ENABLED: "yes" }, warn);
	assert.equal(result2.enabled, true);
	assert.equal(warnings.length, 1, "no second warning");
});

// --- 8: malformed number env ---

test("malformed number env warns once, rung skipped", () => {
	const warnings: string[] = [];
	const warn = (m: string) => warnings.push(m);
	for (const bad of ["-5", "abc", "0"]) {
		const cfg: SlackConfig = { ...DEFAULT_SLACK_CONFIG, uploadThresholdChars: 4000 };
		const result = applyEnvOverrides(cfg, { PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS: bad }, warn);
		assert.equal(result.uploadThresholdChars, 4000, `bad value ${bad} should not apply`);
	}
	assert.equal(warnings.length, 1, "only one warning across all malformed attempts (deduped per env var)");
});

// --- 9: unknown subkey dropped silently ---

test("unknown subkey is dropped silently, no warning", () => {
	withSettings({}, { quiver: { slack: { enabled: true, bogus: 1 } } }, (cwd) => {
		const warnings: string[] = [];
		const cfg = resolveSlackConfig(cwd, NO_ENV, (m) => warnings.push(m));
		assert.equal(cfg.enabled, true);
		assert.equal(warnings.length, 0);
	});
});

test("coerce: unrecognized shape returns undefined", () => {
	assert.equal(coerce("bogus"), undefined);
	assert.equal(coerce(42), undefined);
	assert.equal(coerce([]), undefined);
	assert.equal(coerce(null), undefined);
});

// --- 10: user token from env ---

test("user token resolves from env without reading .env", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-token-"));
	try {
		const token = resolveToken("user", DEFAULT_SLACK_CONFIG, { SLACK_USER_TOKEN: "xoxp-fromenv" }, dir);
		assert.equal(token, "xoxp-fromenv");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 11: bot token absent everywhere -> SlackError ---

test("missing bot token throws SlackError naming the env var, never a value", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-token-"));
	try {
		assert.throws(
			() => resolveToken("bot", DEFAULT_SLACK_CONFIG, {}, dir),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				assert.match(err.message, /SLACK_BOT_TOKEN/);
				assert.doesNotMatch(err.message, /xox/);
				return true;
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 12: .env fallback ---

test(".env fallback provides the token", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-token-"));
	try {
		writeFileSync(join(dir, ".env"), "SLACK_USER_TOKEN=xoxp-abc\n");
		const token = resolveToken("user", DEFAULT_SLACK_CONFIG, {}, dir);
		assert.equal(token, "xoxp-abc");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 13: .env parse details ---

test("parseEnvFile: whitespace, export prefix, quotes, last-match-wins, comments/others ignored", () => {
	const content = [
		"  export SLACK_USER_TOKEN=\"xoxp-q\"",
		"# comment line",
		"OTHER=x",
		"SLACK_USER_TOKEN=xoxp-first",
		"SLACK_USER_TOKEN=xoxp-last",
	].join("\n");
	const parsed = parseEnvFile(content);
	assert.equal(parsed.get("SLACK_USER_TOKEN"), "xoxp-last");
	assert.equal(parsed.has("OTHER"), true);
	assert.equal(parsed.get("OTHER"), "x");
});

test("parseEnvFile: strips one surrounding quote pair", () => {
	const parsed = parseEnvFile('KEY="value"\nKEY2=\'value2\'\nKEY3=plain');
	assert.equal(parsed.get("KEY"), "value");
	assert.equal(parsed.get("KEY2"), "value2");
	assert.equal(parsed.get("KEY3"), "plain");
});

test("parseEnvFile: inline '#' in an unquoted value is not stripped as a comment", () => {
	const parsed = parseEnvFile("SLACK_USER_TOKEN=xoxp-a#b");
	assert.equal(parsed.get("SLACK_USER_TOKEN"), "xoxp-a#b");
});

test("empty .env value (after quote-strip) is treated as missing, not a usable empty token", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-token-"));
	try {
		writeFileSync(join(dir, ".env"), "SLACK_USER_TOKEN=\n");
		assert.throws(
			() => resolveToken("user", DEFAULT_SLACK_CONFIG, {}, dir),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				assert.match(err.message, /SLACK_USER_TOKEN/);
				return true;
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 14: no cross-identity fallback ---

test("no cross-identity fallback: user token present does not satisfy bot request", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-token-"));
	try {
		assert.throws(
			() => resolveToken("bot", DEFAULT_SLACK_CONFIG, { SLACK_USER_TOKEN: "xoxp-abc" }, dir),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				return true;
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 15/16/17: root discovery via real git fixtures ---

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

function initRepo(dir: string): void {
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	writeFileSync(join(dir, "README.md"), "hello\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "init"]);
}

test("discoverRepoRoot: nested subdir of a git repo returns toplevel", () => {
	const repo = mkdtempSync(join(tmpdir(), "quiver-slack-repo-"));
	try {
		initRepo(repo);
		const nested = join(repo, "a", "b", "c");
		mkdirSync(nested, { recursive: true });
		const root = discoverRepoRoot(nested);
		assert.equal(root, git(repo, ["rev-parse", "--show-toplevel"]));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("discoverRepoRoot: non-git dir returns cwd itself", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-nogit-"));
	try {
		assert.equal(discoverRepoRoot(dir), dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("worktree without its own .env: primary checkout .env is consulted", () => {
	const repo = mkdtempSync(join(tmpdir(), "quiver-slack-primary-"));
	const worktreeParent = mkdtempSync(join(tmpdir(), "quiver-slack-wt-"));
	const worktree = join(worktreeParent, "wt");
	try {
		initRepo(repo);
		writeFileSync(join(repo, ".env"), "SLACK_USER_TOKEN=xoxp-primary\n");
		git(repo, ["branch", "wt-branch"]);
		git(repo, ["worktree", "add", worktree, "wt-branch"]);

		const primaryRoot = primaryCheckoutRoot(worktree);
		assert.equal(primaryRoot, realpathSync(repo));

		const token = resolveToken("user", DEFAULT_SLACK_CONFIG, {}, worktree);
		assert.equal(token, "xoxp-primary");
	} finally {
		rmSync(worktreeParent, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("local .env exists but is unreadable: primary-checkout fallback is NOT consulted (missing_token)", (t) => {
	if (process.platform === "win32") {
		t.skip("chmod 000 is not enforced on win32");
		return;
	}
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("root bypasses file permission modes");
		return;
	}
	const repo = mkdtempSync(join(tmpdir(), "quiver-slack-primary-"));
	const worktreeParent = mkdtempSync(join(tmpdir(), "quiver-slack-wt-"));
	const worktree = join(worktreeParent, "wt");
	try {
		initRepo(repo);
		writeFileSync(join(repo, ".env"), "SLACK_USER_TOKEN=xoxp-primary\n");
		git(repo, ["branch", "wt-branch"]);
		git(repo, ["worktree", "add", worktree, "wt-branch"]);
		const localEnvPath = join(worktree, ".env");
		writeFileSync(localEnvPath, "OTHER=1\n");
		chmodSync(localEnvPath, 0o000);

		assert.throws(
			() => resolveToken("user", DEFAULT_SLACK_CONFIG, {}, worktree),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				return true;
			},
		);
	} finally {
		chmodSync(join(worktree, ".env"), 0o644);
		rmSync(worktreeParent, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("worktree without local .env, primary checkout .env unreadable: falls through to missing_token", (t) => {
	if (process.platform === "win32") {
		t.skip("chmod 000 is not enforced on win32");
		return;
	}
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("root bypasses file permission modes");
		return;
	}
	const repo = mkdtempSync(join(tmpdir(), "quiver-slack-primary-"));
	const worktreeParent = mkdtempSync(join(tmpdir(), "quiver-slack-wt-"));
	const worktree = join(worktreeParent, "wt");
	try {
		initRepo(repo);
		const primaryEnvPath = join(repo, ".env");
		writeFileSync(primaryEnvPath, "SLACK_USER_TOKEN=xoxp-primary\n");
		chmodSync(primaryEnvPath, 0o000);
		git(repo, ["branch", "wt-branch"]);
		git(repo, ["worktree", "add", worktree, "wt-branch"]);

		assert.throws(
			() => resolveToken("user", DEFAULT_SLACK_CONFIG, {}, worktree),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				return true;
			},
		);
	} finally {
		chmodSync(join(repo, ".env"), 0o644);
		rmSync(worktreeParent, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("worktree's own .env fully shadows the primary checkout's .env (file-level, not per-key, fallback)", () => {
	const repo = mkdtempSync(join(tmpdir(), "quiver-slack-primary-"));
	const worktreeParent = mkdtempSync(join(tmpdir(), "quiver-slack-wt-"));
	const worktree = join(worktreeParent, "wt");
	try {
		initRepo(repo);
		writeFileSync(join(repo, ".env"), "SLACK_USER_TOKEN=xoxp-primary\n");
		git(repo, ["branch", "wt-branch"]);
		git(repo, ["worktree", "add", worktree, "wt-branch"]);
		writeFileSync(join(worktree, ".env"), "OTHER=1\n");

		assert.throws(
			() => resolveToken("user", DEFAULT_SLACK_CONFIG, {}, worktree),
			(err: unknown) => {
				assert.ok(err instanceof SlackError);
				assert.equal(err.code, "missing_token");
				return true;
			},
		);
	} finally {
		rmSync(worktreeParent, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

// --- 18: registration gate (conditional tool registration from session_start) ---

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import slackExtension, {
	formatToolError,
	channelLine,
	renderToolResult,
	pickCacheRefreshIdentity,
	searchResultText,
	threadResultText,
} from "../extensions/slack.ts";

const EXPECTED_TOOL_NAMES = [
	"slack_search",
	"slack_thread",
	"slack_post",
	"slack_update",
	"slack_delete",
	"slack_pin",
	"slack_upload",
	"slack_cache_refresh",
];

function makeMockApi(): { api: ExtensionAPI; defs: ToolDefinition[]; handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> } {
	const defs: ToolDefinition[] = [];
	const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
	const api = {
		registerTool: (d: ToolDefinition) => defs.push(d),
		on: (ev: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers[ev] = fn;
		},
	} as unknown as ExtensionAPI;
	return { api, defs, handlers };
}

function makeFakeCtx(cwd: string, notify: (m: string, type?: string) => void = () => {}): ExtensionContext {
	return { cwd, hasUI: true, ui: { notify } } as unknown as ExtensionContext;
}

// Async sibling of withSettings: session_start handlers are declared async, so callers must
// await the fixture body before withSettings's own cleanup (env restore + temp-dir removal) runs.
async function withSettingsAsync(
	global: Record<string, unknown>,
	project: Record<string, unknown>,
	fn: (cwd: string) => Promise<void>,
	projectDir: string = mkdtempSync(join(tmpdir(), "quiver-slack-project-")),
): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "quiver-slack-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(project));
		await fn(projectDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}

test("registration gate: no settings anywhere -> zero registerTool calls", async () => {
	await withSettingsAsync({}, {}, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(defs.length, 0);
	});
});

test("registration gate: quiver.slack object without enabled -> zero registerTool calls", async () => {
	await withSettingsAsync({}, { quiver: { slack: { cachePath: "x" } } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(defs.length, 0);
	});
});

test("registration gate: quiver.slack.enabled = false -> zero registerTool calls", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: false } } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(defs.length, 0);
	});
});

test("registration gate: quiver.slack.enabled = true -> exactly 8 tools, self-sufficient", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: true } } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(defs.length, 8);
		assert.deepEqual(
			defs.map((d) => d.name),
			EXPECTED_TOOL_NAMES,
		);
		for (const d of defs) {
			assert.ok(d.promptSnippet && d.promptSnippet.length > 0, `${d.name} missing promptSnippet`);
			assert.ok(d.description && d.description.length > 0, `${d.name} missing description`);
		}
	});
});

test("registration gate: boolean shorthand quiver.slack = true -> 8 tools", async () => {
	await withSettingsAsync({}, { quiver: { slack: true } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(defs.length, 8);
	});
});

test("registration gate: disabled session performs no fs side effects", async () => {
	const canaryDir = mkdtempSync(join(tmpdir(), "quiver-slack-canary-"));
	rmSync(canaryDir, { recursive: true, force: true });
	try {
		await withSettingsAsync({}, { quiver: { slack: { enabled: false, cachePath: join(canaryDir, "cache.json") } } }, async (cwd) => {
			const { api, defs, handlers } = makeMockApi();
			slackExtension(api);
			await handlers.session_start({}, makeFakeCtx(cwd));
			assert.equal(defs.length, 0);
			assert.equal(existsSync(canaryDir), false, "disabled session must not touch the cache directory");
		});
	} finally {
		rmSync(canaryDir, { recursive: true, force: true });
	}
});

test("registration gate: second session_start with enabled config still yields exactly 8 registrations (guard)", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: true } } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(defs.length, 8);
	});
});

// --- 19: adapter helper units (formatToolError, channelLine, renderMutationResult) ---

test("formatToolError: SlackError with data renders 'code: message' plus JSON data", () => {
	const err = new SlackError("already_pinned", "message is already pinned", { channel: "C123" });
	const formatted = formatToolError(err);
	assert.ok(formatted instanceof Error);
	assert.equal(formatted.message, 'already_pinned: message is already pinned\n{"channel":"C123"}');
});

test("formatToolError: SlackError without data omits the JSON suffix", () => {
	const err = new SlackError("missing_token", "SLACK_BOT_TOKEN not found");
	const formatted = formatToolError(err);
	assert.equal(formatted.message, "missing_token: SLACK_BOT_TOKEN not found");
});

test("formatToolError: plain Error passes through unchanged", () => {
	const original = new Error("boom");
	assert.equal(formatToolError(original), original);
});

test("formatToolError: non-Error throwable falls back to String(err)", () => {
	const formatted = formatToolError("just a string");
	assert.ok(formatted instanceof Error);
	assert.equal(formatted.message, "just a string");
});

test("formatToolError: missing_scope names the acting identity when provided", () => {
	const err = new SlackError("missing_scope", 'the token passed to this call does not have the "chat:write" scope.');
	const formatted = formatToolError(err, "bot");
	assert.equal(
		formatted.message,
		'missing_scope: the token passed to this call does not have the "chat:write" scope. (identity: bot)',
	);
});

test("formatToolError: missing_scope without an identity omits the suffix", () => {
	const err = new SlackError("missing_scope", 'the token passed to this call does not have the "chat:write" scope.');
	const formatted = formatToolError(err);
	assert.equal(formatted.message, 'missing_scope: the token passed to this call does not have the "chat:write" scope.');
});

test("formatToolError: raw Slack API response data is whitelisted, not dumped wholesale", () => {
	const err = new SlackError("channel_not_found", "check the name or run slack_cache_refresh", {
		ok: false,
		error: "channel_not_found",
		channel: "C123",
		response_metadata: { warnings: ["internal_detail"] },
	});
	const formatted = formatToolError(err);
	assert.equal(formatted.message, 'channel_not_found: check the name or run slack_cache_refresh\n{"channel":"C123"}');
});

test("formatToolError: recovery fields (ts, channel, permalink, detailPath, thread_ts) all pass the whitelist", () => {
	const err = new SlackError("detail_failed", "boom", {
		ts: "1.1",
		channel: "C1",
		permalink: "https://x.slack.com/archives/C1/p1",
		detailPath: "/tmp/pi-slack/detail.md",
		thread_ts: "1.1",
	});
	const formatted = formatToolError(err);
	assert.equal(
		formatted.message,
		'detail_failed: boom\n{"ts":"1.1","channel":"C1","permalink":"https://x.slack.com/archives/C1/p1","detailPath":"/tmp/pi-slack/detail.md","thread_ts":"1.1"}',
	);
});

test("channelLine: renders channel/ts/permalink/warning/fileId when all present", () => {
	const line = channelLine({
		channel: "C123",
		ts: "1700000000.000100",
		permalink: "https://example.slack.com/archives/C123/p1700000000000100",
		warning: "rate limited",
		fileId: "F123",
	} as never);
	assert.match(line, /channel C123/);
	assert.match(line, /ts 1700000000\.000100/);
	assert.match(line, /https:\/\/example\.slack\.com\/archives\/C123\/p1700000000000100/);
	assert.match(line, /file F123/);
	assert.match(line, /warning: rate limited/);
});

test("channelLine: omits optional fields that are absent", () => {
	const line = channelLine({ channel: "C123" } as never);
	assert.equal(line, "channel C123");
});

function fakeTheme(): import("@earendil-works/pi-coding-agent").Theme {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as import("@earendil-works/pi-coding-agent").Theme;
}

// Text is constructed with paddingX=0, paddingY=0 by renderMutationResult; rendering at a wide
// width and trimming each wrapped line recovers the plain text content for assertions.
function renderedLines(text: import("@earendil-works/pi-tui").Text): string[] {
	return text.render(200).map((line) => line.trimEnd());
}

test("renderToolResult: partial call renders a working indicator", () => {
	const text = renderToolResult({ content: [{ type: "text", text: "channel C123" }] }, { expanded: false, isPartial: true }, fakeTheme(), { isError: false });
	assert.deepEqual(renderedLines(text), ["Working..."]);
});

test("renderToolResult: error result renders the first line of the error text", () => {
	const text = renderToolResult(
		{ content: [{ type: "text", text: "missing_token: SLACK_BOT_TOKEN not found\nmore detail" }] },
		{ expanded: false, isPartial: false },
		fakeTheme(),
		{ isError: true },
	);
	assert.deepEqual(renderedLines(text), ["missing_token: SLACK_BOT_TOKEN not found"]);
});

test("renderToolResult: collapsed success shows only the first line; expanded shows all lines", () => {
	const result = { content: [{ type: "text" as const, text: "channel C123 | ts 1.1\nfile F123" }] };
	const collapsed = renderToolResult(result, { expanded: false, isPartial: false }, fakeTheme(), { isError: false });
	assert.deepEqual(renderedLines(collapsed), ["channel C123 | ts 1.1"]);
	const expanded = renderToolResult(result, { expanded: true, isPartial: false }, fakeTheme(), { isError: false });
	assert.deepEqual(renderedLines(expanded), ["channel C123 | ts 1.1", "file F123"]);
});

// --- 20: pickCacheRefreshIdentity (slack_cache_refresh's user-else-bot pick) ---

test("pickCacheRefreshIdentity: user token present -> user", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-pick-"));
	try {
		const identity = pickCacheRefreshIdentity(DEFAULT_SLACK_CONFIG, { SLACK_USER_TOKEN: "xoxp-x" }, dir);
		assert.equal(identity, "user");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pickCacheRefreshIdentity: only bot token present -> falls back to bot", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-pick-"));
	try {
		const identity = pickCacheRefreshIdentity(DEFAULT_SLACK_CONFIG, { SLACK_BOT_TOKEN: "xoxb-x" }, dir);
		assert.equal(identity, "bot");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pickCacheRefreshIdentity: neither token present -> bot pick surfaces at resolveToken time (missing_token), not here", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-pick-"));
	try {
		const identity = pickCacheRefreshIdentity(DEFAULT_SLACK_CONFIG, {}, dir);
		assert.equal(identity, "bot");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- 21: searchResultText / threadResultText (G4: total/page + complete/next_cursor metadata) ---

test("searchResultText: appends total/page/pageCount metadata", () => {
	const text = searchResultText({ output: "line1", spilled: false, total: 42, page: 2, pageCount: 5 });
	assert.equal(text, "line1\n\ntotal: 42 | page: 2 of 5");
});

test("threadResultText: complete true omits next_cursor", () => {
	const text = threadResultText({ output: "line1", spilled: false, complete: true, messageCount: 1 });
	assert.equal(text, "line1\n\ncomplete: true");
});

test("threadResultText: incomplete appends next_cursor and caveat when present", () => {
	const text = threadResultText({
		output: "line1",
		spilled: false,
		complete: false,
		nextCursor: "CUR1",
		caveat: "rate limited caveat",
		messageCount: 1,
	});
	assert.equal(text, "line1\n\ncomplete: false\nnext_cursor: CUR1\nrate limited caveat");
});

// --- 22: G9 markdown_text rejection (registration-level, no tokens needed - guard fires first) ---

test("slack_post: markdown_text field is rejected before any token resolution", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: true } } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		const def = defs.find((d) => d.name === "slack_post")!;
		await assert.rejects(
			() =>
				def.execute(
					"tc1",
					{ as: "user", channel: "#general", markdown_text: "nope" } as never,
					new AbortController().signal,
					() => {},
					undefined as never,
				),
			(err: unknown) => err instanceof Error && /markdown_text is not supported/.test(err.message),
		);
	});
});

test("slack_update: markdown_text field is rejected before any token resolution", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: true } } }, async (cwd) => {
		const { api, defs, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		const def = defs.find((d) => d.name === "slack_update")!;
		await assert.rejects(
			() =>
				def.execute(
					"tc1",
					{ as: "user", channel: "#general", ts: "1.1", markdown_text: "nope" } as never,
					new AbortController().signal,
					() => {},
					undefined as never,
				),
			(err: unknown) => err instanceof Error && /markdown_text is not supported/.test(err.message),
		);
	});
});

// --- (c) end-to-end execute through the mock ExtensionAPI ---
// extensions/slack.ts calls defaultApiCall (a real network fetch) directly inside resolveCall,
// with no deps-injection seam threaded through registration - so the tests below stub the one
// thing defaultApiCall is built on: the global fetch. Each handler is keyed by Slack method name
// (the /api/<method> path segment); an unscripted method throws loudly instead of hitting the
// network.

type FetchHandlers = Record<string, (params: Record<string, unknown>) => Record<string, unknown>>;

async function withFakeFetch(handlers: FetchHandlers, fn: () => Promise<void>): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const method = new URL(String(url)).pathname.replace(/^\/api\//, "");
		const handler = handlers[method];
		if (!handler) throw new Error(`unscripted Slack API call in test: ${method}`);
		let params: Record<string, unknown> = {};
		const body = init?.body;
		if (typeof body === "string") {
			try {
				params = JSON.parse(body);
			} catch {
				params = Object.fromEntries(new URLSearchParams(body));
			}
		}
		return new Response(JSON.stringify(handler(params)), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = original;
	}
}

async function withEnvToken(envVar: string, value: string, fn: () => Promise<void>): Promise<void> {
	const previous = process.env[envVar];
	process.env[envVar] = value;
	try {
		await fn();
	} finally {
		if (previous === undefined) delete process.env[envVar];
		else process.env[envVar] = previous;
	}
}

function writeMentionCache(filePath: string): void {
	writeFileSync(
		filePath,
		JSON.stringify({
			team_id: "T1",
			channels: { general: "C123" },
			users: { alice: { id: "U01ALICE", display_name: "Alice", real_name: "Alice A" } },
			refreshed_at: new Date().toISOString(),
			snapshot_at: new Date().toISOString(),
		}),
	);
}

const MENTION_FETCH_HANDLERS: FetchHandlers = {
	"auth.test": () => ({ ok: true, team_id: "T1" }),
	"chat.postMessage": () => ({ ok: true, ts: "1111.1" }),
	"chat.getPermalink": () => ({ ok: true, permalink: "https://x.slack.com/archives/C123/p11111" }),
};

async function runSlackPost(
	dir: string,
	params: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }> {
	const cacheFile = join(dir, "cache.json");
	writeMentionCache(cacheFile);
	let result!: { content: { type: string; text: string }[]; details: Record<string, unknown> };
	await withEnvToken("SLACK_BOT_TOKEN", "xoxb-e2e-mentions", async () => {
		await withSettingsAsync({}, { quiver: { slack: { enabled: true, cachePath: cacheFile } } }, async (cwd) => {
			await withFakeFetch(MENTION_FETCH_HANDLERS, async () => {
				const { api, defs, handlers } = makeMockApi();
				slackExtension(api);
				await handlers.session_start({}, makeFakeCtx(cwd));
				const def = defs.find((d) => d.name === "slack_post")!;
				result = (await def.execute(
					"tc1",
					{ as: "bot", channel: "#general", ...params } as never,
					new AbortController().signal,
					() => {},
					undefined as never,
				)) as never;
			});
		});
	});
	return result;
}

test("slack_post execute: announce mode scans both text and thread_body for mentions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-announce-"));
	try {
		const result = await runSlackPost(dir, { text: "hi @alice", thread_body: "cc @bob for detail" });
		assert.match(result.content[0].text, /unresolved mentions: @bob/);
		assert.deepEqual(result.details.unresolvedMentions, [{ field: "thread_body", name: "@bob" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slack_post execute: threaded reply via thread_body scans only thread_body, never the bare text param", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-reply-body-"));
	try {
		const result = await runSlackPost(dir, { thread_ts: "1111.1", text: "@carol note", thread_body: "loop in @bob please" });
		assert.match(result.content[0].text, /unresolved mentions: @bob/);
		assert.ok(!/@carol/.test(result.content[0].text));
		assert.deepEqual(result.details.unresolvedMentions, [{ field: "thread_body", name: "@bob" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slack_post execute: threaded reply via bare text (no thread_body) scans text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-reply-text-"));
	try {
		const result = await runSlackPost(dir, { thread_ts: "1111.1", text: "loop in @bob please" });
		assert.match(result.content[0].text, /unresolved mentions: @bob/);
		assert.deepEqual(result.details.unresolvedMentions, [{ field: "text", name: "@bob" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slack_post execute: plain post scans text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-plain-"));
	try {
		const result = await runSlackPost(dir, { text: "hi @bob" });
		assert.match(result.content[0].text, /unresolved mentions: @bob/);
		assert.deepEqual(result.details.unresolvedMentions, [{ field: "text", name: "@bob" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slack_post execute: blocks-only plain post omits text from chat.postMessage params", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-blocks-plain-"));
	try {
		const cacheFile = join(dir, "cache.json");
		writeMentionCache(cacheFile);
		const captured: Record<string, unknown>[] = [];
		const handlers: FetchHandlers = {
			"auth.test": () => ({ ok: true, team_id: "T1" }),
			"chat.postMessage": (params) => {
				captured.push(params);
				return { ok: true, ts: "1111.1" };
			},
			"chat.getPermalink": () => ({ ok: true, permalink: "https://x.slack.com/archives/C123/p11111" }),
		};
		await withEnvToken("SLACK_BOT_TOKEN", "xoxb-e2e-blocks-plain", async () => {
			await withSettingsAsync({}, { quiver: { slack: { enabled: true, cachePath: cacheFile } } }, async (cwd) => {
				await withFakeFetch(handlers, async () => {
					const { api, defs, handlers: extHandlers } = makeMockApi();
					slackExtension(api);
					await extHandlers.session_start({}, makeFakeCtx(cwd));
					const def = defs.find((d) => d.name === "slack_post")!;
					await def.execute(
						"tc1",
						{ as: "bot", channel: "#general", blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] } as never,
						new AbortController().signal,
						() => {},
						undefined as never,
					);
				});
			});
		});
		assert.equal(captured.length, 1);
		assert.ok(!("text" in captured[0]), "chat.postMessage params should not include a text key");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slack_post execute: blocks-only threaded reply (no thread_body, no text) omits text from chat.postMessage params", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-blocks-reply-"));
	try {
		const cacheFile = join(dir, "cache.json");
		writeMentionCache(cacheFile);
		const captured: Record<string, unknown>[] = [];
		const handlers: FetchHandlers = {
			"auth.test": () => ({ ok: true, team_id: "T1" }),
			"chat.postMessage": (params) => {
				captured.push(params);
				return { ok: true, ts: "1111.1" };
			},
			"chat.getPermalink": () => ({ ok: true, permalink: "https://x.slack.com/archives/C123/p11111" }),
		};
		await withEnvToken("SLACK_BOT_TOKEN", "xoxb-e2e-blocks-reply", async () => {
			await withSettingsAsync({}, { quiver: { slack: { enabled: true, cachePath: cacheFile } } }, async (cwd) => {
				await withFakeFetch(handlers, async () => {
					const { api, defs, handlers: extHandlers } = makeMockApi();
					slackExtension(api);
					await extHandlers.session_start({}, makeFakeCtx(cwd));
					const def = defs.find((d) => d.name === "slack_post")!;
					await def.execute(
						"tc1",
						{
							as: "bot",
							channel: "#general",
							thread_ts: "1111.1",
							blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
						} as never,
						new AbortController().signal,
						() => {},
						undefined as never,
					);
				});
			});
		});
		assert.equal(captured.length, 1);
		assert.ok(!("text" in captured[0]), "chat.postMessage params should not include a text key");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slack_cache_refresh execute: zero emails out of N users names the missing scope in the content string", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-slack-e2e-cache-refresh-"));
	try {
		const cacheFile = join(dir, "cache.json");
		await withEnvToken("SLACK_BOT_TOKEN", "xoxb-e2e-refresh", async () => {
			await withSettingsAsync({}, { quiver: { slack: { enabled: true, cachePath: cacheFile } } }, async (cwd) => {
				await withFakeFetch(
					{
						"auth.test": () => ({ ok: true, team_id: "T1" }),
						"conversations.list": () => ({
							channels: [{ id: "C1", name: "general" }],
							response_metadata: { next_cursor: "" },
						}),
						"users.list": () => ({
							members: [{ id: "U1", name: "bob", profile: { display_name: "Bob", real_name: "Bob B" } }],
							response_metadata: { next_cursor: "" },
						}),
					},
					async () => {
						const { api, defs, handlers } = makeMockApi();
						slackExtension(api);
						await handlers.session_start({}, makeFakeCtx(cwd));
						const def = defs.find((d) => d.name === "slack_cache_refresh")!;
						const result = (await def.execute("tc1", {}, new AbortController().signal, () => {}, undefined as never)) as {
							content: { type: string; text: string }[];
						};
						assert.equal(result.content[0].text, "channels: 1, users: 1 | emails: 0/1 (users:read.email scope may be missing)");
					},
				);
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- gh-9: policyPath ---

test("coerce: policyPath string is accepted, non-string ignored", () => {
	assert.equal(coerce({ policyPath: "doc/SLACK.md" })?.policyPath, "doc/SLACK.md");
	assert.equal(coerce({ policyPath: 42 })?.policyPath, undefined);
});

test("DEFAULT_SLACK_CONFIG: policyPath is undefined by default", () => {
	assert.equal(DEFAULT_SLACK_CONFIG.policyPath, undefined);
});

test("applyEnvOverrides: no env var can set policyPath", () => {
	const out = applyEnvOverrides({ ...DEFAULT_SLACK_CONFIG }, {
		PI_QUIVER_SLACK_POLICY_PATH: "doc/OTHER.md",
	});
	assert.equal(out.policyPath, undefined);
});

// --- gh-9: policy injection ---

async function withPolicyRepo(
	policy: string | undefined,
	fn: (repoDir: string) => Promise<void>,
): Promise<void> {
	const repoDir = mkdtempSync(join(tmpdir(), "quiver-slack-policy-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		if (policy !== undefined) writeFileSync(join(repoDir, "SLACK.md"), policy);
		await fn(repoDir);
	} finally {
		rmSync(repoDir, { recursive: true, force: true });
	}
}

test("policy injection: no handler registered when policyPath is unset", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: true } } }, async (cwd) => {
		const { api, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(handlers.before_agent_start, undefined);
	});
});

test("policy injection: no handler registered when slack is disabled", async () => {
	await withSettingsAsync({}, { quiver: { slack: { enabled: false, policyPath: "SLACK.md" } } }, async (cwd) => {
		const { api, handlers } = makeMockApi();
		slackExtension(api);
		await handlers.session_start({}, makeFakeCtx(cwd));
		assert.equal(handlers.before_agent_start, undefined);
	});
});

test("policy injection: appends the policy block to the incoming systemPrompt", async () => {
	await withPolicyRepo("Confirm exact text before posting.", async (repoDir) => {
		await withSettingsAsync({}, { quiver: { slack: { enabled: true, policyPath: "SLACK.md" } } }, async () => {
			const { api, handlers } = makeMockApi();
			slackExtension(api);
			await handlers.session_start({}, makeFakeCtx(repoDir));
			const out = (await handlers.before_agent_start(
				{ systemPrompt: "BASE" },
				makeFakeCtx(repoDir),
			)) as { systemPrompt: string };
			assert.match(out.systemPrompt, /^BASE\n\n<slack-policy source="SLACK\.md">\n/);
			assert.match(out.systemPrompt, /Confirm exact text before posting\./);
		}, repoDir);
	});
});

test("policy injection: re-reads the file every turn", async () => {
	await withPolicyRepo("first", async (repoDir) => {
		await withSettingsAsync({}, { quiver: { slack: { enabled: true, policyPath: "SLACK.md" } } }, async () => {
			const { api, handlers } = makeMockApi();
			slackExtension(api);
			await handlers.session_start({}, makeFakeCtx(repoDir));
			const one = (await handlers.before_agent_start({ systemPrompt: "B" }, makeFakeCtx(repoDir))) as { systemPrompt: string };
			assert.match(one.systemPrompt, /first/);
			writeFileSync(join(repoDir, "SLACK.md"), "second");
			const two = (await handlers.before_agent_start({ systemPrompt: "B" }, makeFakeCtx(repoDir))) as { systemPrompt: string };
			assert.match(two.systemPrompt, /second/);
		}, repoDir);
	});
});

test("policy injection: missing file injects status=unreadable and warns exactly once", async () => {
	await withPolicyRepo(undefined, async (repoDir) => {
		await withSettingsAsync({}, { quiver: { slack: { enabled: true, policyPath: "SLACK.md" } } }, async () => {
			const warnings: string[] = [];
			const ctx = makeFakeCtx(repoDir, (m) => warnings.push(m));
			const { api, handlers } = makeMockApi();
			slackExtension(api);
			await handlers.session_start({}, ctx);
			for (let i = 0; i < 3; i++) {
				const out = (await handlers.before_agent_start({ systemPrompt: "B" }, ctx)) as { systemPrompt: string };
				assert.match(out.systemPrompt, /status="unreadable"/);
			}
			assert.equal(warnings.filter((w) => /policy/i.test(w)).length, 1);
		}, repoDir);
	});
});

test("policy injection: empty file injects status=empty", async () => {
	await withPolicyRepo("   \n", async (repoDir) => {
		await withSettingsAsync({}, { quiver: { slack: { enabled: true, policyPath: "SLACK.md" } } }, async () => {
			const { api, handlers } = makeMockApi();
			slackExtension(api);
			await handlers.session_start({}, makeFakeCtx(repoDir));
			const out = (await handlers.before_agent_start({ systemPrompt: "B" }, makeFakeCtx(repoDir))) as { systemPrompt: string };
			assert.match(out.systemPrompt, /status="empty"/);
		}, repoDir);
	});
});

test("policy injection: an absolute policyPath is used verbatim, not joined onto repoRoot", async () => {
	await withPolicyRepo("Confirm exact text before posting.", async (repoDir) => {
		const policyDir = mkdtempSync(join(tmpdir(), "quiver-slack-policy-abs-"));
		try {
			const absolutePolicyPath = join(policyDir, "OUTSIDE.md");
			writeFileSync(absolutePolicyPath, "Absolute policy body.");
			await withSettingsAsync({}, { quiver: { slack: { enabled: true, policyPath: absolutePolicyPath } } }, async () => {
				const { api, handlers } = makeMockApi();
				slackExtension(api);
				await handlers.session_start({}, makeFakeCtx(repoDir));
				const out = (await handlers.before_agent_start({ systemPrompt: "B" }, makeFakeCtx(repoDir))) as { systemPrompt: string };
				assert.match(out.systemPrompt, /Absolute policy body\./);
				assert.ok(
					out.systemPrompt.includes(`<slack-policy source="${absolutePolicyPath}">`),
					"source attribute should carry the absolute path verbatim",
				);
			}, repoDir);
		} finally {
			rmSync(policyDir, { recursive: true, force: true });
		}
	});
});

test("policy injection: a relative policyPath resolves against repoRoot even when cwd is a subdirectory", async () => {
	await withPolicyRepo("Confirm exact text before posting.", async (repoDir) => {
		const subDir = join(repoDir, "a", "b");
		mkdirSync(subDir, { recursive: true });
		await withSettingsAsync({}, { quiver: { slack: { enabled: true, policyPath: "SLACK.md" } } }, async () => {
			const { api, handlers } = makeMockApi();
			slackExtension(api);
			await handlers.session_start({}, makeFakeCtx(subDir));
			const out = (await handlers.before_agent_start({ systemPrompt: "B" }, makeFakeCtx(subDir))) as { systemPrompt: string };
			assert.match(out.systemPrompt, /Confirm exact text before posting\./);
			assert.ok(
				out.systemPrompt.includes('<slack-policy source="SLACK.md">'),
				"source attribute should carry the configured relative path as written",
			);
		}, subDir);
	});
});
