/**
 * Name->ID cache for the slack extension: one JSON file per Slack workspace
 * (keyed by team ID), holding channel and user name->ID maps. Sits on top of
 * `lib/slack-core.ts`'s ApiCall/SlackError/SlackConfig - stays pi-free like
 * its sibling core modules.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ApiCall, SlackConfig } from "./slack-core.ts";
import { SlackError } from "./slack-core.ts";

export interface SlackCacheFile {
	team_id: string;
	channels: Record<string, string>;
	users: Record<string, { id: string; display_name: string; real_name: string }>;
	refreshed_at: string;
}

export interface CacheCtx {
	apiCall: ApiCall;
	token: string;
	filePath: string;
	signal?: AbortSignal;
}

const RAW_CHANNEL_ID = /^[CDG][A-Z0-9]{5,}$/;
const RAW_USER_ID = /^[UW][A-Z0-9]{5,}$/;

/** Hard cap on cursor-following pagination loops - a runaway/misbehaving API must fail loudly, never spin or write a partial cache. */
export const MAX_LIST_PAGES = 100;

/** Same per-OS convention as `lib/doc-to-md-core.ts`'s `cacheDir`, defined locally per spec. */
export function userCacheDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
	if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "pi-quiver");
	if (platform === "darwin") return join(home, "Library", "Caches", "pi-quiver");
	return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "pi-quiver");
}

export function cacheFilePath(
	cfg: SlackConfig,
	repoRoot: string,
	teamId: string,
	dirs?: { platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string },
): string {
	if (cfg.cachePath) {
		return isAbsolute(cfg.cachePath) ? cfg.cachePath : join(repoRoot, cfg.cachePath);
	}
	const dir = dirs
		? userCacheDir(dirs.platform, dirs.env, dirs.home)
		: userCacheDir(process.platform, process.env, process.env.HOME ?? "");
	return join(dir, `slack-${teamId}.json`);
}

const teamIdCache = new Map<string, string>();

export async function teamIdFor(token: string, apiCall: ApiCall, signal?: AbortSignal): Promise<string> {
	const cached = teamIdCache.get(token);
	if (cached !== undefined) return cached;
	const data = await apiCall("auth.test", token, {}, { retry: false, signal });
	const teamId = data.team_id as string;
	teamIdCache.set(token, teamId);
	return teamId;
}

export function assertSameTeam(a: string | undefined, b: string | undefined): void {
	if (a !== undefined && b !== undefined && a !== b) {
		throw new SlackError("team_mismatch", `User and bot tokens belong to different workspaces (${a} vs ${b}).`);
	}
}

function readCacheFile(filePath: string): SlackCacheFile | undefined {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as SlackCacheFile;
	} catch {
		return undefined;
	}
}

function emptyCache(teamId: string): SlackCacheFile {
	return { team_id: teamId, channels: {}, users: {}, refreshed_at: new Date().toISOString() };
}

function atomicWrite(filePath: string, data: SlackCacheFile): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp.${process.pid}`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2));
	renameSync(tmpPath, filePath);
}

function mergeAndWrite(filePath: string, teamId: string, patch: (base: SlackCacheFile) => void): void {
	const base = existsSync(filePath) ? (readCacheFile(filePath) ?? emptyCache(teamId)) : emptyCache(teamId);
	patch(base);
	base.refreshed_at = new Date().toISOString();
	atomicWrite(filePath, base);
}

function stripPrefix(input: string): string {
	return input.startsWith("#") || input.startsWith("@") ? input.slice(1) : input;
}

export async function resolveChannel(input: string, ctx: CacheCtx): Promise<string> {
	if (RAW_CHANNEL_ID.test(input)) return input;
	if (input.startsWith("@")) {
		throw new SlackError(
			"invalid_channel",
			`"${input}" looks like a user name, which is not accepted in a channel position (opening a DM is out of scope).`,
		);
	}
	const name = stripPrefix(input);

	const cached = readCacheFile(ctx.filePath);
	const hit = cached?.channels[name];
	if (hit !== undefined) return hit;

	let cursor = "";
	for (let page = 1; ; page++) {
		if (page > MAX_LIST_PAGES) {
			throw new SlackError(
				"pagination_overflow",
				`resolveChannel: conversations.list did not terminate within ${MAX_LIST_PAGES} pages.`,
			);
		}
		const data = await ctx.apiCall(
			"conversations.list",
			ctx.token,
			{ limit: 1000, types: "public_channel,private_channel", ...(cursor ? { cursor } : {}) },
			{ retry: false, signal: ctx.signal },
		);
		const channels = (data.channels as { id: string; name: string }[]) ?? [];
		const match = channels.find((c) => c.name === name);
		if (match) {
			mergeAndWrite(ctx.filePath, cached?.team_id ?? (await teamIdFor(ctx.token, ctx.apiCall, ctx.signal)), (base) => {
				base.channels[name] = match.id;
			});
			return match.id;
		}
		const meta = data.response_metadata as { next_cursor?: string } | undefined;
		const nextCursor = meta?.next_cursor ?? "";
		// Slack can echo the same cursor repeatedly under throttling - treat a repeated non-empty
		// cursor as exhaustion rather than spinning until MAX_LIST_PAGES.
		if (nextCursor !== "" && nextCursor === cursor) break;
		cursor = nextCursor;
		if (!cursor) break;
	}

	throw new SlackError("name_not_found", `No channel named "${name}" was found in the workspace.`);
}

interface SlackUser {
	id: string;
	name: string;
	profile?: { display_name?: string; real_name?: string };
	real_name?: string;
}

export async function resolveUser(input: string, ctx: CacheCtx): Promise<string> {
	if (RAW_USER_ID.test(input)) return input;
	if (input.startsWith("#")) {
		throw new SlackError(
			"invalid_user",
			`"${input}" looks like a channel name, which is not accepted in a user position.`,
		);
	}
	const name = stripPrefix(input);

	const cached = readCacheFile(ctx.filePath);
	if (cached) {
		const byUsername = cached.users[name];
		if (byUsername) return byUsername.id;

		const displayMatches = Object.values(cached.users).filter((u) => u.display_name === name);
		if (displayMatches.length === 1) return displayMatches[0].id;
		if (displayMatches.length > 1) {
			throw new SlackError(
				"ambiguous_user",
				`Multiple users have display name "${name}": ${displayMatches.map((u) => u.id).join(", ")}.`,
			);
		}

		const realMatches = Object.values(cached.users).filter((u) => u.real_name === name);
		if (realMatches.length === 1) return realMatches[0].id;
		if (realMatches.length > 1) {
			throw new SlackError(
				"ambiguous_user",
				`Multiple users have real name "${name}": ${realMatches.map((u) => u.id).join(", ")}.`,
			);
		}
	}

	let cursor = "";
	const displayCandidates: SlackUser[] = [];
	const realCandidates: SlackUser[] = [];
	for (let page = 1; ; page++) {
		if (page > MAX_LIST_PAGES) {
			throw new SlackError(
				"pagination_overflow",
				`resolveUser: users.list did not terminate within ${MAX_LIST_PAGES} pages.`,
			);
		}
		const data = await ctx.apiCall(
			"users.list",
			ctx.token,
			{ limit: 1000, ...(cursor ? { cursor } : {}) },
			{ retry: false, signal: ctx.signal },
		);
		const members = (data.members as SlackUser[]) ?? [];
		for (const u of members) {
			if (u.name === name) {
				mergeAndWrite(ctx.filePath, cached?.team_id ?? (await teamIdFor(ctx.token, ctx.apiCall, ctx.signal)), (base) => {
					base.users[name] = {
						id: u.id,
						display_name: u.profile?.display_name ?? "",
						real_name: u.profile?.real_name ?? u.real_name ?? "",
					};
				});
				return u.id;
			}
			if (u.profile?.display_name === name) displayCandidates.push(u);
			if ((u.profile?.real_name ?? u.real_name) === name) realCandidates.push(u);
		}
		const meta = data.response_metadata as { next_cursor?: string } | undefined;
		const nextCursor = meta?.next_cursor ?? "";
		// Slack can echo the same cursor repeatedly under throttling - treat a repeated non-empty
		// cursor as exhaustion rather than spinning until MAX_LIST_PAGES.
		if (nextCursor !== "" && nextCursor === cursor) break;
		cursor = nextCursor;
		if (!cursor) break;
	}

	if (displayCandidates.length === 1) {
		const u = displayCandidates[0];
		mergeAndWrite(ctx.filePath, cached?.team_id ?? (await teamIdFor(ctx.token, ctx.apiCall, ctx.signal)), (base) => {
			base.users[u.name] = {
				id: u.id,
				display_name: u.profile?.display_name ?? "",
				real_name: u.profile?.real_name ?? u.real_name ?? "",
			};
		});
		return u.id;
	}
	if (displayCandidates.length > 1) {
		throw new SlackError(
			"ambiguous_user",
			`Multiple users have display name "${name}": ${displayCandidates.map((u) => u.id).join(", ")}.`,
		);
	}

	if (realCandidates.length === 1) {
		const u = realCandidates[0];
		mergeAndWrite(ctx.filePath, cached?.team_id ?? (await teamIdFor(ctx.token, ctx.apiCall, ctx.signal)), (base) => {
			base.users[u.name] = {
				id: u.id,
				display_name: u.profile?.display_name ?? "",
				real_name: u.profile?.real_name ?? u.real_name ?? "",
			};
		});
		return u.id;
	}
	if (realCandidates.length > 1) {
		throw new SlackError(
			"ambiguous_user",
			`Multiple users have real name "${name}": ${realCandidates.map((u) => u.id).join(", ")}.`,
		);
	}

	throw new SlackError("name_not_found", `No user named "${name}" was found in the workspace.`);
}

/**
 * Full snapshot replace, deliberately asymmetric with mergeAndWrite: refresh's job is to
 * atomically overwrite the whole file, so a concurrent mergeAndWrite write racing this one may
 * be clobbered (last-writer-wins). Accepted per spec (doc/specs/2026-08-29-gh-7-slack-extension.md
 * Cache section) - a clobbered merge self-heals on the next cache miss.
 */
export async function refreshCache(ctx: CacheCtx): Promise<{ channels: number; users: number }> {
	const teamId = await teamIdFor(ctx.token, ctx.apiCall, ctx.signal);
	const channels: Record<string, string> = {};
	const users: Record<string, { id: string; display_name: string; real_name: string }> = {};

	let cursor = "";
	for (let page = 1; ; page++) {
		if (page > MAX_LIST_PAGES) {
			throw new SlackError(
				"pagination_overflow",
				`refreshCache: conversations.list did not terminate within ${MAX_LIST_PAGES} pages.`,
			);
		}
		const data = await ctx.apiCall(
			"conversations.list",
			ctx.token,
			{ limit: 1000, types: "public_channel,private_channel", ...(cursor ? { cursor } : {}) },
			{ retry: false, signal: ctx.signal },
		);
		const list = (data.channels as { id: string; name: string }[]) ?? [];
		for (const c of list) channels[c.name] = c.id;
		const meta = data.response_metadata as { next_cursor?: string } | undefined;
		const nextCursor = meta?.next_cursor ?? "";
		// A repeated non-empty cursor never terminates via has_more logic - refresh must not write a
		// partial cache, so this is a hard overflow, not silent exhaustion (unlike the scan loops).
		if (nextCursor !== "" && nextCursor === cursor) {
			throw new SlackError(
				"pagination_overflow",
				`refreshCache: conversations.list returned the same cursor twice (${nextCursor}); aborting without writing a partial cache.`,
			);
		}
		cursor = nextCursor;
		if (!cursor) break;
	}

	cursor = "";
	for (let page = 1; ; page++) {
		if (page > MAX_LIST_PAGES) {
			throw new SlackError(
				"pagination_overflow",
				`refreshCache: users.list did not terminate within ${MAX_LIST_PAGES} pages.`,
			);
		}
		const data = await ctx.apiCall("users.list", ctx.token, { limit: 1000, ...(cursor ? { cursor } : {}) }, { retry: false, signal: ctx.signal });
		const members = (data.members as SlackUser[]) ?? [];
		for (const u of members) {
			users[u.name] = { id: u.id, display_name: u.profile?.display_name ?? "", real_name: u.profile?.real_name ?? u.real_name ?? "" };
		}
		const meta = data.response_metadata as { next_cursor?: string } | undefined;
		const nextCursor = meta?.next_cursor ?? "";
		if (nextCursor !== "" && nextCursor === cursor) {
			throw new SlackError(
				"pagination_overflow",
				`refreshCache: users.list returned the same cursor twice (${nextCursor}); aborting without writing a partial cache.`,
			);
		}
		cursor = nextCursor;
		if (!cursor) break;
	}

	atomicWrite(ctx.filePath, { team_id: teamId, channels, users, refreshed_at: new Date().toISOString() });
	return { channels: Object.keys(channels).length, users: Object.keys(users).length };
}
