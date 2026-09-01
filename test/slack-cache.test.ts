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
	resolveMentions,
	refreshCache,
	assertSameTeam,
	MAX_LIST_PAGES,
	type SlackCacheFile,
	type UserEntry,
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
	assert.deepEqual(counts, { channels: 2, users: 1, emails: 0 });
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

// --- gh-9: email + snapshot_at ---

test("resolveUser: username match writes email when users.list returned one", async () => {
	const dir = tmpDir("quiver-slack-email-username-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U1", name: "alice", profile: { display_name: "Alice", real_name: "Alice A", email: "alice@corp.com" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const id = await resolveUser("@alice", { apiCall, token: "tok-email-1", filePath });
	assert.equal(id, "U1");
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.users.alice.email, "alice@corp.com");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: display-name match also writes email (the easily-missed branch)", async () => {
	const dir = tmpDir("quiver-slack-email-display-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U2", name: "bob.smith", profile: { display_name: "Bobby", real_name: "Bob Smith", email: "bob@corp.com" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const id = await resolveUser("@Bobby", { apiCall, token: "tok-email-2", filePath });
	assert.equal(id, "U2");
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.users["bob.smith"].email, "bob@corp.com");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: real-name match also writes email (the easily-missed branch)", async () => {
	const dir = tmpDir("quiver-slack-email-realname-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U4", name: "eve.jones", profile: { display_name: "", real_name: "Eve Jones", email: "eve@corp.com" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const id = await resolveUser("@Eve Jones", { apiCall, token: "tok-email-4", filePath });
	assert.equal(id, "U4");
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.users["eve.jones"].email, "eve@corp.com");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveUser: email key is omitted, never empty string, when Slack returns none", async () => {
	const dir = tmpDir("quiver-slack-email-absent-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, { team_id: "T1", channels: {}, users: {}, refreshed_at: "x" });
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U3", name: "carol", profile: { display_name: "Carol", real_name: "Carol C" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	await resolveUser("@carol", { apiCall, token: "tok-email-3", filePath });
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal("email" in written.users.carol, false);
	rmSync(dir, { recursive: true, force: true });
});

test("refreshCache: writes snapshot_at, returns an email count, backfills an email-less file", async () => {
	const dir = tmpDir("quiver-slack-snapshot-");
	const filePath = join(dir, "cache.json");
	writeCacheFile(filePath, {
		team_id: "T1",
		channels: {},
		users: { alice: { id: "U1", display_name: "Alice", real_name: "Alice A" } },
		refreshed_at: "x",
	});
	const { apiCall } = scriptedApiCall([
		{ method: "auth.test", result: { team_id: "T1" } },
		{ method: "conversations.list", result: { channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "" } } },
		{
			method: "users.list",
			result: {
				members: [
					{ id: "U1", name: "alice", profile: { display_name: "Alice", real_name: "Alice A", email: "alice@corp.com" } },
					{ id: "U2", name: "dave", profile: { display_name: "Dave", real_name: "Dave D" } },
				],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const counts = await refreshCache({ apiCall, token: "tok-snapshot-1", filePath });
	assert.deepEqual(counts, { channels: 1, users: 2, emails: 1 });
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.users.alice.email, "alice@corp.com");
	assert.equal("email" in written.users.dave, false);
	assert.ok(typeof written.snapshot_at === "string" && written.snapshot_at.length > 0);
	rmSync(dir, { recursive: true, force: true });
});

test("mergeAndWrite path: a lazy user write preserves an existing snapshot_at", async () => {
	const dir = tmpDir("quiver-slack-snapshot-keep-");
	const filePath = join(dir, "cache.json");
	const before = new Date("2020-01-01T00:00:00.000Z").toISOString();
	writeFileSync(
		filePath,
		JSON.stringify({ team_id: "T1", channels: {}, users: {}, refreshed_at: "x", snapshot_at: before }, null, 2),
	);
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U9", name: "erin", profile: { display_name: "Erin", real_name: "Erin E" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	await resolveUser("@erin", { apiCall, token: "tok-snapshot-keep", filePath });
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.snapshot_at, before);
	rmSync(dir, { recursive: true, force: true });
});

// --- gh-9: resolveMentions grammar ---

function cacheWithAlice(filePath: string, extra: Partial<SlackCacheFile> = {}): void {
	writeFileSync(
		filePath,
		JSON.stringify(
			{
				team_id: "T1",
				channels: {},
				users: { alice: { id: "U01ALICE", display_name: "Alice", real_name: "Alice A" } },
				refreshed_at: "x",
				...extra,
			},
			null,
			2,
		),
	);
}

test("resolveMentions: cache hit substitutes, zero apiCall", async () => {
	const dir = tmpDir("quiver-slack-mention-hit-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([]);
	const out = await resolveMentions([{ field: "text", value: "ping @alice now" }], { apiCall, token: "tok-m1", filePath });
	assert.deepEqual(out.values, ["ping <@U01ALICE> now"]);
	assert.deepEqual(out.unresolved, []);
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: deny list, email-like text, and formatted mentions are never candidates", async () => {
	const dir = tmpDir("quiver-slack-mention-deny-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([]);
	const input = "@here @channel @everyone user@host.com <@U01ALICE>";
	const out = await resolveMentions([{ field: "text", value: input }], { apiCall, token: "tok-m2", filePath });
	assert.deepEqual(out.values, [input]);
	assert.deepEqual(out.unresolved, []);
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: boundary characters (, [, *, _, quotes resolve; backtick does not", async () => {
	const dir = tmpDir("quiver-slack-mention-boundary-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall } = scriptedApiCall([]);
	const out = await resolveMentions(
		[{ field: "text", value: "(@alice) [@alice] *@alice* _@alice_ \"@alice\" '@alice' `@alice`" }],
		{ apiCall, token: "tok-m3", filePath },
	);
	const substitutions = out.values[0].split("<@U01ALICE>").length - 1;
	assert.equal(substitutions, 6);
	assert.match(out.values[0], /`@alice`/);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: escaped \\@alice stays literal, loses the backslash, is not reported", async () => {
	const dir = tmpDir("quiver-slack-mention-escape-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([]);
	const out = await resolveMentions([{ field: "text", value: "hi \\@alice and x\\@alice" }], {
		apiCall,
		token: "tok-m4",
		filePath,
	});
	assert.equal(out.values[0], "hi @alice and x\\@alice");
	assert.deepEqual(out.unresolved, []);
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: trailing punctuation is trimmed, dotted username retried untrimmed", async () => {
	const dir = tmpDir("quiver-slack-mention-punct-");
	const filePath = join(dir, "cache.json");
	writeFileSync(
		filePath,
		JSON.stringify(
			{
				team_id: "T1",
				channels: {},
				users: {
					alice: { id: "U01ALICE", display_name: "Alice", real_name: "Alice A" },
					"bob.s": { id: "U01BOB", display_name: "Bob", real_name: "Bob S" },
				},
				refreshed_at: "x",
			},
			null,
			2,
		),
	);
	const { apiCall } = scriptedApiCall([]);
	const out = await resolveMentions([{ field: "text", value: "ask @alice, or @bob.s." }], {
		apiCall,
		token: "tok-m5",
		filePath,
	});
	assert.equal(out.values[0], "ask <@U01ALICE>, or <@U01BOB>.");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: deny list still catches boundary-wrapped and punctuated pseudo-mentions", async () => {
	const dir = tmpDir("quiver-slack-mention-deny-trim-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([]);
	const input = "_@channel_ update, @here. now";
	const out = await resolveMentions([{ field: "text", value: input }], { apiCall, token: "tok-m5b", filePath });
	assert.deepEqual(out.values, [input]);
	assert.deepEqual(out.unresolved, []);
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: a name that is entirely trailing punctuation is not a candidate", async () => {
	const dir = tmpDir("quiver-slack-mention-empty-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([]);
	const input = "see @... over there";
	const out = await resolveMentions([{ field: "text", value: input }], { apiCall, token: "tok-m5c", filePath });
	assert.deepEqual(out.values, [input]);
	assert.ok(!out.unresolved.some((u) => u.name === "@"));
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: a snapshot-proven ambiguous alias skips the live lookup entirely", async () => {
	const dir = tmpDir("quiver-slack-mention-ambig-snapshot-");
	const filePath = join(dir, "cache.json");
	writeFileSync(
		filePath,
		JSON.stringify(
			{
				team_id: "T1",
				channels: {},
				users: {
					a1: { id: "U1", display_name: "Twin", real_name: "One" },
					a2: { id: "U2", display_name: "Twin", real_name: "Two" },
				},
				refreshed_at: "x",
				snapshot_at: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	const { apiCall, calls } = scriptedApiCall([]);
	const out = await resolveMentions([{ field: "text", value: "hey @Twin" }], { apiCall, token: "tok-m5d", filePath });
	assert.equal(out.values[0], "hey @Twin");
	assert.deepEqual(out.unresolved, [{ field: "text", name: "@Twin" }]);
	assert.equal(calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

// --- gh-9: resolveMentions resolution and degradation ---

test("resolveMentions: misses across both fields cost exactly one users.list pagination", async () => {
	const dir = tmpDir("quiver-slack-mention-batch-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [
					{ id: "U01BOB", name: "bob", profile: { display_name: "Bob", real_name: "Bob B" } },
					{ id: "U01CAR", name: "carol", profile: { display_name: "Carol", real_name: "Carol C" } },
				],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const out = await resolveMentions(
		[
			{ field: "text", value: "@bob and @dave" },
			{ field: "thread_body", value: "@carol and @erin" },
		],
		{ apiCall, token: "tok-m6", filePath },
	);
	assert.equal(calls.filter((c) => c.method === "users.list").length, 1);
	assert.equal(out.values[0], "<@U01BOB> and @dave");
	assert.equal(out.values[1], "<@U01CAR> and @erin");
	assert.deepEqual(out.unresolved, [
		{ field: "text", name: "@dave" },
		{ field: "thread_body", name: "@erin" },
	]);
	const written = JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	assert.equal(written.users.bob.id, "U01BOB");
	assert.equal(written.users.carol.id, "U01CAR");
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: ambiguous alias stays literal and is reported, never throws", async () => {
	const dir = tmpDir("quiver-slack-mention-ambig-");
	const filePath = join(dir, "cache.json");
	const { apiCall } = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [
					{ id: "U1", name: "a1", profile: { display_name: "Twin", real_name: "One" } },
					{ id: "U2", name: "a2", profile: { display_name: "Twin", real_name: "Two" } },
				],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const out = await resolveMentions([{ field: "text", value: "hey @Twin" }], { apiCall, token: "tok-m7", filePath });
	assert.equal(out.values[0], "hey @Twin");
	assert.deepEqual(out.unresolved, [{ field: "text", name: "@Twin" }]);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: alias hit is trusted from cache only when snapshot_at is present", async () => {
	const dir = tmpDir("quiver-slack-mention-alias-");
	const withoutPath = join(dir, "without.json");
	const withPath = join(dir, "with.json");
	cacheWithAlice(withoutPath);
	cacheWithAlice(withPath, { snapshot_at: new Date().toISOString() });

	const live = scriptedApiCall([
		{
			method: "users.list",
			result: {
				members: [{ id: "U01ALICE", name: "alice", profile: { display_name: "Alice", real_name: "Alice A" } }],
				response_metadata: { next_cursor: "" },
			},
		},
	]);
	const noSnapshot = await resolveMentions([{ field: "text", value: "@Alice" }], {
		apiCall: live.apiCall,
		token: "tok-m8a",
		filePath: withoutPath,
	});
	assert.equal(noSnapshot.values[0], "<@U01ALICE>");
	assert.equal(live.calls.filter((c) => c.method === "users.list").length, 1);

	const cached = scriptedApiCall([]);
	const withSnapshot = await resolveMentions([{ field: "text", value: "@Alice" }], {
		apiCall: cached.apiCall,
		token: "tok-m8b",
		filePath: withPath,
	});
	assert.equal(withSnapshot.values[0], "<@U01ALICE>");
	assert.equal(cached.calls.length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: users.list transport failure degrades to all-literal with lookupError", async () => {
	const dir = tmpDir("quiver-slack-mention-transport-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall } = scriptedApiCall([
		{ method: "users.list", error: new SlackError("ratelimited", "Slack rate-limited the request.") },
	]);
	const out = await resolveMentions([{ field: "text", value: "@alice and @dave" }], {
		apiCall,
		token: "tok-m9",
		filePath,
	});
	assert.equal(out.values[0], "<@U01ALICE> and @dave");
	assert.deepEqual(out.unresolved, [{ field: "text", name: "@dave" }]);
	assert.match(out.lookupError ?? "", /rate-limited/);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: users.list exceeding MAX_LIST_PAGES degrades to all-literal with pagination_overflow lookupError", async () => {
	const dir = tmpDir("quiver-slack-mention-overflow-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);

	let calls = 0;
	const apiCall: ApiCall = async () => {
		calls += 1;
		return { members: [], response_metadata: { next_cursor: `cur${calls}` } };
	};

	const out = await resolveMentions([{ field: "text", value: "@dave" }], { apiCall, token: "tok-m11", filePath });
	assert.equal(calls, MAX_LIST_PAGES);
	assert.equal(out.values[0], "@dave");
	assert.deepEqual(out.unresolved, [{ field: "text", name: "@dave" }]);
	assert.match(out.lookupError ?? "", /did not terminate within/);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: a repeated non-empty cursor terminates the scan", async () => {
	const dir = tmpDir("quiver-slack-mention-cursor-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall, calls } = scriptedApiCall([
		{ method: "users.list", result: { members: [], response_metadata: { next_cursor: "same" } } },
		{ method: "users.list", result: { members: [], response_metadata: { next_cursor: "same" } } },
	]);
	const out = await resolveMentions([{ field: "text", value: "@dave" }], { apiCall, token: "tok-m10", filePath });
	assert.deepEqual(out.unresolved, [{ field: "text", name: "@dave" }]);
	assert.equal(calls.length, 2);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: a repeated unknown mention within one field yields exactly one unresolved entry", async () => {
	const dir = tmpDir("quiver-slack-mention-dedup-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall } = scriptedApiCall([
		{ method: "users.list", result: { members: [], response_metadata: { next_cursor: "" } } },
	]);
	const out = await resolveMentions([{ field: "text", value: "cc @bob @bob" }], { apiCall, token: "tok-m12", filePath });
	assert.deepEqual(out.unresolved, [{ field: "text", name: "@bob" }]);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveMentions: a same-name miss in two different fields still yields two entries", async () => {
	const dir = tmpDir("quiver-slack-mention-dedup-field-");
	const filePath = join(dir, "cache.json");
	cacheWithAlice(filePath);
	const { apiCall } = scriptedApiCall([
		{ method: "users.list", result: { members: [], response_metadata: { next_cursor: "" } } },
	]);
	const out = await resolveMentions(
		[
			{ field: "text", value: "@bob" },
			{ field: "thread_body", value: "@bob" },
		],
		{ apiCall, token: "tok-m13", filePath },
	);
	assert.deepEqual(out.unresolved, [
		{ field: "text", name: "@bob" },
		{ field: "thread_body", name: "@bob" },
	]);
	rmSync(dir, { recursive: true, force: true });
});
