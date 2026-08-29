import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiCall } from "../lib/slack-core.ts";
import { SlackError, DEFAULT_SLACK_CONFIG } from "../lib/slack-core.ts";
import {
	userCacheDir,
	cacheFilePath,
	teamIdFor,
	resolveChannel,
	resolveUser,
	refreshCache,
	assertSameTeam,
	MAX_LIST_PAGES,
	type SlackCacheFile,
} from "../lib/slack-cache.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

interface ScriptEntry {
	method: string;
	result?: Record<string, unknown>;
	error?: Error;
	sideEffect?: () => void;
}

function scriptedApiCall(script: ScriptEntry[]): { apiCall: ApiCall; calls: { method: string; params: Record<string, unknown> }[] } {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	let i = 0;
	const apiCall: ApiCall = async (method, _token, params) => {
		calls.push({ method, params });
		const entry = script[i];
		if (!entry) throw new Error(`unexpected apiCall #${i}: ${method}`);
		assert.equal(entry.method, method, `apiCall #${i} expected ${entry.method}, got ${method}`);
		i++;
		if (entry.sideEffect) entry.sideEffect();
		if (entry.error) throw entry.error;
		return entry.result ?? {};
	};
	return { apiCall, calls };
}

function writeCacheFile(path: string, data: SlackCacheFile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2));
}

// --- 1: cacheFilePath ---

test("cacheFilePath: absolute cachePath used verbatim", () => {
	const cfg = { ...DEFAULT_SLACK_CONFIG, cachePath: "/abs/path/cache.json" };
	assert.equal(cacheFilePath(cfg, "/repo", "T1"), "/abs/path/cache.json");
});

test("cacheFilePath: relative cachePath joins repoRoot", () => {
	const cfg = { ...DEFAULT_SLACK_CONFIG, cachePath: "x/cache.json" };
	assert.equal(cacheFilePath(cfg, "/repo", "T1"), join("/repo", "x/cache.json"));
});

test("cacheFilePath: undefined cachePath resolves to userCacheDir/slack-<team>.json", () => {
	const cfg = { ...DEFAULT_SLACK_CONFIG, cachePath: undefined };
	const dir = userCacheDir(process.platform, process.env, process.env.HOME ?? "");
	assert.equal(cacheFilePath(cfg, "/repo", "T1"), join(dir, "slack-T1.json"));
});

// --- 2: single winning file (cachePath configured; user-dir file is never read) ---

test("single winning file: cachePath wins over a populated user-dir file with a wrong id", async () => {
	const dir = tmpDir("quiver-slack-win-");
	const winningPath = join(dir, "cache.json");
	writeCacheFile(winningPath, { team_id: "T1", channels: { general: "CGOOD" }, users: {}, refreshed_at: "x" });

	// A same-named user-dir file with a WRONG id must never be consulted. Uses a fake home under
	// the temp dir (via cacheFilePath's injectable dirs) - never touches the real per-OS cache dir.
	const fakeHome = join(dir, "home");
	const userDir = userCacheDir("linux", {}, fakeHome);
	const loserPath = join(userDir, "slack-T1.json");
	writeCacheFile(loserPath, { team_id: "T1", channels: { general: "CWRONG" }, users: {}, refreshed_at: "x" });

	const { apiCall, calls } = scriptedApiCall([]);
	const id = await resolveChannel("#general", { apiCall, token: "tok", filePath: winningPath });
	assert.equal(id, "CGOOD");
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

// --- 3: two workspaces -> distinct files, no cross-team read/write ---

test("cacheFilePath: distinct filenames per team when using userCacheDir default", () => {
	const dirs = { platform: "linux" as NodeJS.Platform, env: {}, home: "/fake-home" };
	const cfg = { ...DEFAULT_SLACK_CONFIG, cachePath: undefined };
	const p1 = cacheFilePath(cfg, "/repo", "T1", dirs);
	const p2 = cacheFilePath(cfg, "/repo", "T2", dirs);
	assert.notEqual(p1, p2);
	assert.match(p1, /slack-T1\.json$/);
	assert.match(p2, /slack-T2\.json$/);
});

test("two workspaces don't collide: resolving against T1 never reads or writes T2's cache file", async () => {
	const dir = tmpDir("quiver-slack-multiteam-");
	const dirs = { platform: "linux" as NodeJS.Platform, env: {}, home: join(dir, "home") };
	const cfg = { ...DEFAULT_SLACK_CONFIG, cachePath: undefined };

	const pathT1 = cacheFilePath(cfg, "/repo", "T1", dirs);
	const pathT2 = cacheFilePath(cfg, "/repo", "T2", dirs);
	assert.notEqual(pathT1, pathT2);

	// Populate T2's cache via a full refresh.
	const { apiCall: apiCallT2 } = scriptedApiCall([
		{ method: "auth.test", result: { team_id: "T2" } },
		{
			method: "conversations.list",
			result: { channels: [{ id: "C2", name: "t2-channel" }], response_metadata: { next_cursor: "" } },
		},
		{ method: "users.list", result: { members: [], response_metadata: { next_cursor: "" } } },
	]);
	await refreshCache({ apiCall: apiCallT2, token: "tok-multiteam-t2", filePath: pathT2 });
	assert.ok(existsSync(pathT2));
	const t2Before = readFileSync(pathT2, "utf8");

	// Resolve a channel against T1's ctx (team_id pre-seeded so no auth.test call is needed).
	writeCacheFile(pathT1, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall: apiCallT1 } = scriptedApiCall([
		{
			method: "conversations.list",
			result: { channels: [{ id: "C1", name: "t1-channel" }], response_metadata: { next_cursor: "" } },
		},
	]);
	const id = await resolveChannel("#t1-channel", { apiCall: apiCallT1, token: "tok-multiteam-t1", filePath: pathT1 });
	assert.equal(id, "C1");

	assert.ok(existsSync(pathT1));
	assert.ok(existsSync(pathT2));
	const t1 = JSON.parse(readFileSync(pathT1, "utf8")) as SlackCacheFile;
	assert.equal(t1.channels["t1-channel"], "C1");
	assert.equal(t1.channels["t2-channel"], undefined);

	const t2After = readFileSync(pathT2, "utf8");
	assert.equal(t2After, t2Before, "T2's cache file must be byte-identical - resolving against T1 never touched it");

	rmSync(dir, { recursive: true, force: true });
});

// --- 4: cache hit, zero apiCall ---

test("resolveChannel: cache hit returns id with zero apiCall invocations", async () => {
	const dir = tmpDir("quiver-slack-hit-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: { general: "C111111" }, users: {}, refreshed_at: "x" });
	const { apiCall, calls } = scriptedApiCall([]);
	const id = await resolveChannel("#general", { apiCall, token: "tok", filePath });
	assert.equal(id, "C111111");
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

// --- 5: raw channel ID passthrough ---

test("resolveChannel: raw channel ID passes through without cache read or apiCall", async () => {
	const dir = tmpDir("quiver-slack-raw-");
	const filePath = join(dir, "does-not-exist.json");
	const { apiCall, calls } = scriptedApiCall([]);
	const id = await resolveChannel("C0123ABCDEF", { apiCall, token: "tok", filePath });
	assert.equal(id, "C0123ABCDEF");
	assert.equal(calls.length, 0);
	assert.equal(existsSync(filePath), false);
	rmSync(dir, { recursive: true, force: true });
});

// --- 6: miss -> paginated scan -> atomic write-back preserving concurrent key ---

test("resolveChannel: miss scans pages, writes back atomically, preserves concurrent key", async () => {
	const dir = tmpDir("quiver-slack-miss-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });

	const { apiCall, calls } = scriptedApiCall([
		{
			method: "conversations.list",
			result: {
				channels: [{ id: "C000001", name: "random" }],
				response_metadata: { next_cursor: "cur1" },
			},
		},
		{
			method: "conversations.list",
			result: { channels: [{ id: "C000002", name: "target" }], response_metadata: { next_cursor: "" } },
			sideEffect: () => {
				// Simulate a concurrent writer inserting an unrelated key between our read and write.
				const current = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
				current.channels.concurrent = "CCONCURRENT";
				writeFileSync(filePath, JSON.stringify(current, null, 2));
			},
		},
	]);

	const id = await resolveChannel("#target", { apiCall, token: "tok", filePath });
	assert.equal(id, "C000002");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].params.cursor, undefined);
	assert.equal(calls[1].params.cursor, "cur1");

	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.channels.target, "C000002");
	assert.equal(written.channels.concurrent, "CCONCURRENT");
	rmSync(dir, { recursive: true, force: true });
});

// --- 7: exhaustion -> name_not_found ---

test("resolveChannel: exhaustion throws SlackError name_not_found", async () => {
	const dir = tmpDir("quiver-slack-exh-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });

	const { apiCall } = scriptedApiCall([
		{ method: "conversations.list", result: { channels: [], response_metadata: { next_cursor: "" } } },
	]);

	await assert.rejects(
		() => resolveChannel("#nope", { apiCall, token: "tok", filePath }),
		(err: unknown) => err instanceof SlackError && err.code === "name_not_found",
	);
	rmSync(dir, { recursive: true, force: true });
});

// --- 7b: name/type-position rejections ---

test("resolveChannel: rejects @name - user names are not accepted in a channel position", async () => {
	const dir = tmpDir("quiver-slack-badchan-");
	const filePath = join(dir, "does-not-exist.json");
	const { apiCall, calls } = scriptedApiCall([]);
	await assert.rejects(
		() => resolveChannel("@bob", { apiCall, token: "tok", filePath }),
		(err: unknown) => err instanceof SlackError && err.code === "invalid_channel",
	);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(filePath), false);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: rejects #name - channel names are not accepted in a user position", async () => {
	const dir = tmpDir("quiver-slack-baduser-");
	const filePath = join(dir, "does-not-exist.json");
	const { apiCall, calls } = scriptedApiCall([]);
	await assert.rejects(
		() => resolveUser("#general", { apiCall, token: "tok", filePath }),
		(err: unknown) => err instanceof SlackError && err.code === "invalid_user",
	);
	assert.equal(calls.length, 0);
	assert.equal(existsSync(filePath), false);
	rmSync(dir, { recursive: true, force: true });
});

// --- 7c: unbounded pagination is capped ---

test("resolveChannel: conversations.list returning next_cursor forever throws pagination_overflow and writes no cache file", async () => {
	const dir = tmpDir("quiver-slack-overflow-");
	const filePath = join(dir, "cache.json");

	let calls = 0;
	const apiCall: ApiCall = async () => {
		calls += 1;
		return { channels: [], response_metadata: { next_cursor: `cur${calls}` } };
	};

	await assert.rejects(
		() => resolveChannel("#never-found", { apiCall, token: "tok", filePath }),
		(err: unknown) => err instanceof SlackError && err.code === "pagination_overflow",
	);
	assert.equal(calls, MAX_LIST_PAGES);
	assert.equal(existsSync(filePath), false);
	rmSync(dir, { recursive: true, force: true });
});

// --- 7d: repeated-cursor guard (G10) ---

test("resolveChannel: a repeated non-empty next_cursor is treated as exhaustion, not spun to MAX_LIST_PAGES", async () => {
	const dir = tmpDir("quiver-slack-repeat-chan-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });

	let calls = 0;
	const apiCall: ApiCall = async () => {
		calls += 1;
		return { channels: [], response_metadata: { next_cursor: "STUCK" } };
	};

	await assert.rejects(
		() => resolveChannel("#never-found", { apiCall, token: "tok", filePath }),
		(err: unknown) => err instanceof SlackError && err.code === "name_not_found",
	);
	assert.equal(calls, 2, "first call establishes the cursor, second call sees it repeated and exhausts");
	rmSync(dir, { recursive: true, force: true });
});

test("refreshCache: a repeated non-empty next_cursor from conversations.list throws pagination_overflow and writes no cache file", async () => {
	const dir = tmpDir("quiver-slack-repeat-refresh-");
	const filePath = join(dir, "cache.json");

	let calls = 0;
	const apiCall: ApiCall = async (method) => {
		if (method === "auth.test") return { team_id: "T-REPEAT" };
		calls += 1;
		return { channels: [], response_metadata: { next_cursor: "STUCK" } };
	};

	await assert.rejects(
		() => refreshCache({ apiCall, token: "tok-repeat-refresh", filePath }),
		(err: unknown) => err instanceof SlackError && err.code === "pagination_overflow",
	);
	assert.equal(calls, 2);
	assert.equal(existsSync(filePath), false);
	rmSync(dir, { recursive: true, force: true });
});

// --- 8: resolveUser precedence + ambiguity ---

test("resolveUser: username beats display_name", async () => {
	const dir = tmpDir("quiver-slack-user1-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [
					{ id: "U000001", name: "other", profile: { display_name: "bob" } },
					{ id: "U000002", name: "bob", profile: { display_name: "x" } },
				],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const id = await resolveUser("@bob", { apiCall, token: "tok", filePath });
	assert.equal(id, "U000002");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: display_name used when no username match", async () => {
	const dir = tmpDir("quiver-slack-user2-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U000003", name: "c1", profile: { display_name: "carol" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const id = await resolveUser("carol", { apiCall, token: "tok", filePath });
	assert.equal(id, "U000003");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: real_name used as last resort", async () => {
	const dir = tmpDir("quiver-slack-user3-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U000004", name: "d1", profile: { display_name: "nope", real_name: "dave" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const id = await resolveUser("dave", { apiCall, token: "tok", filePath });
	assert.equal(id, "U000004");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: ambiguous display-name match throws listing both candidates", async () => {
	const dir = tmpDir("quiver-slack-user4-");
	const filePath = join(dir, "cache.json");
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [
					{ id: "U000005", name: "e1", profile: { display_name: "erin" } },
					{ id: "U000006", name: "e2", profile: { display_name: "erin" } },
				],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	await assert.rejects(
		() => resolveUser("erin", { apiCall, token: "tok", filePath }),
		(err: unknown) =>
			err instanceof SlackError &&
			err.code === "ambiguous_user" &&
			err.message.includes("U000005") &&
			err.message.includes("U000006"),
	);
	rmSync(dir, { recursive: true, force: true });
});

// --- 9: raw user ID passthrough ---

test("resolveUser: raw user IDs pass through without cache read or apiCall", async () => {
	const dir = tmpDir("quiver-slack-user-raw-");
	const filePath = join(dir, "does-not-exist.json");
	const { apiCall, calls } = scriptedApiCall([]);
	assert.equal(await resolveUser("U0123ABCDEF", { apiCall, token: "tok", filePath }), "U0123ABCDEF");
	assert.equal(await resolveUser("W0123ABCDEF", { apiCall, token: "tok", filePath }), "W0123ABCDEF");
	assert.equal(calls.length, 0);
	assert.equal(existsSync(filePath), false);
	rmSync(dir, { recursive: true, force: true });
});

// --- 10: refreshCache ---

test("refreshCache: full paginated replace, returns counts, drops stale keys", async () => {
	const dir = tmpDir("quiver-slack-refresh-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: { stale: "CSTALE" }, users: { stale: { id: "USTALE", display_name: "", real_name: "" } }, refreshed_at: "x" });

	const { apiCall, calls } = scriptedApiCall([
		{ method: "auth.test", result: { team_id: "T1" } },
		{
			method: "conversations.list",
			result: { channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "cur1" } },
		},
		{
			method: "conversations.list",
			result: { channels: [{ id: "C2", name: "random" }], response_metadata: { next_cursor: "" } },
		},
		{
			method: "users.list",
			result: {
				members: [{ id: "U1", name: "alice", profile: { display_name: "Alice", real_name: "Alice A" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);

	const counts = await refreshCache({ apiCall, token: "tok-refresh-unique", filePath });
	assert.deepEqual(counts, { channels: 2, users: 1 });
	assert.equal(calls.length, 4);

	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.deepEqual(written.channels, { general: "C1", random: "C2" });
	assert.equal((written.channels as Record<string, string>)["stale"], undefined);
	assert.equal((written.users as Record<string, unknown>)["stale"], undefined);
	assert.deepEqual(written.users.alice, { id: "U1", display_name: "Alice", real_name: "Alice A" });
	assert.equal(written.team_id, "T1");
	rmSync(dir, { recursive: true, force: true });
});

// --- 11: teamIdFor memoization ---

test("teamIdFor: memoizes per token, only one auth.test request", async () => {
	const token = "memo-token-unique-1";
	const { apiCall, calls } = scriptedApiCall([{ method: "auth.test", result: { team_id: "T-MEMO" } }]);
	const first = await teamIdFor(token, apiCall);
	const second = await teamIdFor(token, apiCall);
	assert.equal(first, "T-MEMO");
	assert.equal(second, "T-MEMO");
	assert.equal(calls.length, 1);
});

// --- 12: team mismatch ---

test("assertSameTeam: throws team_mismatch when both present and differ", () => {
	assert.throws(
		() => assertSameTeam("T1", "T2"),
		(err: unknown) => err instanceof SlackError && err.code === "team_mismatch",
	);
});

test("assertSameTeam: does not throw when equal or either is undefined", () => {
	assert.doesNotThrow(() => assertSameTeam("T1", "T1"));
	assert.doesNotThrow(() => assertSameTeam(undefined, "T1"));
	assert.doesNotThrow(() => assertSameTeam("T1", undefined));
});

// --- 13: teamIdFor forwards an abort signal into auth.test ---

test("teamIdFor: forwards a provided signal into the auth.test apiCall opts", async () => {
	const controller = new AbortController();
	const seenOpts: { retry?: boolean; signal?: AbortSignal }[] = [];
	const apiCall: ApiCall = async (_method, _token, _params, opts) => {
		seenOpts.push(opts ?? {});
		return { team_id: "T-SIGNAL" };
	};
	const teamId = await teamIdFor("signal-token-unique", apiCall, controller.signal);
	assert.equal(teamId, "T-SIGNAL");
	assert.equal(seenOpts.length, 1);
	assert.equal(seenOpts[0].signal, controller.signal);
});
