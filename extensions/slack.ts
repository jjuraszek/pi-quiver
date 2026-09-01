/**
 * Slack extension: opt-in, default-off. On `session_start` resolves
 * `quiver.slack`; if not enabled, registers zero tools (no `.env` read, no
 * network, no cache I/O). If enabled, registers the eight `slack_*` tools as
 * thin wrappers over lib/slack-core.ts and lib/slack-cache.ts.
 *
 * Toggling takes effect at the next session (registration-time gate, same
 * convention as the other opt-in extensions).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
	defaultApiCall,
	defaultUploadBytes,
	buildPolicyBlock,
	discoverRepoRoot,
	resolveSlackConfig,
	resolveToken,
	searchMessages,
	readThread,
	postMessage,
	updateMessage,
	deleteMessage,
	pinMessage,
	uploadFile,
	formatUnresolvedSuffix,
	SlackError,
	type SlackConfig,
	type CoreDeps,
	type MutationResult,
	type AnnounceResult,
	type SearchResult,
	type ThreadResult,
	type UnresolvedMention,
} from "../lib/slack-core.ts";
import { cacheFilePath, teamIdFor, resolveChannel, refreshCache, resolveMentions, assertSameTeam, type CacheCtx } from "../lib/slack-cache.ts";

const IDENTITY = Type.Union([Type.Literal("user"), Type.Literal("bot")], {
	description: 'Which token to act as: "user" (a real person, needed for slack_search/slack_thread) or "bot" (an app identity). Determines which token env var is used and whose name shows as the author.',
});

// Approved recovery fields only - never dump the raw Slack API response (err.data can carry it
// verbatim for ok:false mappings). Everything a caller needs to recover a mutation lives in this
// small whitelist.
const ALLOWED_ERROR_DATA_KEYS = new Set(["ts", "channel", "permalink", "detailPath", "thread_ts"]);

export function formatToolError(err: unknown, identity?: "user" | "bot"): Error {
	if (err instanceof SlackError) {
		const identitySuffix = err.code === "missing_scope" && identity ? ` (identity: ${identity})` : "";
		const filtered = err.data
			? Object.fromEntries(Object.entries(err.data).filter(([key]) => ALLOWED_ERROR_DATA_KEYS.has(key)))
			: undefined;
		const data = filtered && Object.keys(filtered).length > 0 ? `\n${JSON.stringify(filtered)}` : "";
		return new Error(`${err.code}: ${err.message}${identitySuffix}${data}`);
	}
	if (err instanceof Error) return err;
	return new Error(String(err));
}

interface ResolvedCall {
	token: string;
	filePath: string;
	cacheCtx: CacheCtx;
	deps: CoreDeps;
}

async function resolveCall(
	identity: "user" | "bot",
	cfg: SlackConfig,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	repoRoot: string,
): Promise<ResolvedCall> {
	const token = resolveToken(identity, cfg, process.env, repoRoot);
	const teamId = await teamIdFor(token, defaultApiCall, signal);
	const otherIdentity = identity === "user" ? "bot" : "user";
	const otherTeamId = await (async () => {
		try {
			const otherToken = resolveToken(otherIdentity, cfg, process.env, repoRoot);
			return await teamIdFor(otherToken, defaultApiCall, signal);
		} catch {
			// Other identity's token can't be resolved/authenticated - best-effort
			// cross-check only, never fail the acting identity's call for this.
			return undefined;
		}
	})();
	if (otherTeamId !== undefined) {
		assertSameTeam(teamId, otherTeamId);
	}
	const filePath = cacheFilePath(cfg, repoRoot, teamId);
	const cacheCtx: CacheCtx = { apiCall: defaultApiCall, token, filePath, signal };
	const deps: CoreDeps = { apiCall: defaultApiCall, token, signal };
	return { token, filePath, cacheCtx, deps };
}

/**
 * slack_cache_refresh's identity pick: user token when present, else bot (spec "Cache" section).
 * Pure and network-free - resolveToken only reads env/.env - so it's unit-testable without a
 * transport seam.
 */
export function pickCacheRefreshIdentity(
	cfg: SlackConfig,
	env: Record<string, string | undefined>,
	repoRoot: string,
): "user" | "bot" {
	try {
		resolveToken("user", cfg, env, repoRoot);
		return "user";
	} catch (err) {
		if (err instanceof SlackError && err.code === "missing_token") return "bot";
		throw err;
	}
}

/** G9: markdown_text is rejected as a posting field (spec "Tool surface") - schemas don't define
 * it, so TypeBox's non-strict Type.Object would otherwise pass it through silently. */
function assertNoMarkdownText(params: object): void {
	if ("markdown_text" in params) {
		throw new SlackError("invalid_argument", "markdown_text is not supported; use text and/or blocks");
	}
}

async function guarded<T>(fn: () => Promise<T>, identity?: "user" | "bot"): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw formatToolError(err, identity);
	}
}

export function channelLine(result: MutationResult | (MutationResult & { fileId: string })): string {
	const parts = [`channel ${result.channel}`];
	if (result.ts) parts.push(`ts ${result.ts}`);
	if (result.permalink) parts.push(result.permalink);
	if ("fileId" in result) parts.push(`file ${result.fileId}`);
	if (result.warning) parts.push(`warning: ${result.warning}`);
	if ((result as AnnounceResult).detailTs) parts.push(`detail ts ${(result as AnnounceResult).detailTs}`);
	return parts.join(" | ");
}

/** Shared by slack_post/slack_update: the channelLine + unresolved-mentions suffix result shape. */
function mentionAwareResult(
	result: MutationResult | AnnounceResult,
	mentions: { unresolved: UnresolvedMention[]; lookupError?: string },
	opts: { detailUploaded?: boolean } = {},
) {
	const suffix = formatUnresolvedSuffix(mentions.unresolved, { lookupError: mentions.lookupError, ...opts });
	return {
		content: [{ type: "text" as const, text: suffix ? `${channelLine(result)} | ${suffix}` : channelLine(result) }],
		details: { ...result, ...(mentions.unresolved.length > 0 ? { unresolvedMentions: mentions.unresolved } : {}) },
	};
}

export function searchResultText(result: SearchResult): string {
	return `${result.output}\n\ntotal: ${result.total} | page: ${result.page} of ${result.pageCount}`;
}

export function threadResultText(result: ThreadResult): string {
	const lines = [result.output, "", `complete: ${result.complete}`];
	if (!result.complete && result.nextCursor) lines.push(`next_cursor: ${result.nextCursor}`);
	if (result.caveat) lines.push(result.caveat);
	return lines.join("\n");
}

function oneLine(theme: Theme, name: string, arg: string): Text {
	return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", arg)}`, 0, 0);
}

export function renderToolResult(
	result: { content: { type: string; text?: string }[] },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { isError: boolean },
): Text {
	const content = result.content[0];
	const fullText = content?.type === "text" ? (content.text ?? "") : "";
	if (options.isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
	if (context.isError) {
		const firstLine = fullText.split("\n")[0] || "slack call failed";
		return new Text(theme.fg("error", firstLine), 0, 0);
	}
	if (!options.expanded) {
		return new Text(theme.fg("toolOutput", fullText.split("\n")[0] || ""), 0, 0);
	}
	return new Text(
		fullText
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n"),
		0,
		0,
	);
}

export default function slackExtension(pi: ExtensionAPI) {
	let registered = false;

	pi.on("session_start", async (_event, ctx) => {
		const cfg = resolveSlackConfig(ctx.cwd, process.env, (m) => ctx.ui.notify(m, "warning"));
		if (cfg.enabled !== true) return;
		if (registered) return;
		registered = true;

		const repoRoot = discoverRepoRoot(ctx.cwd);

		const policyPath = cfg.policyPath;
		if (policyPath !== undefined) {
			const resolvedPolicyPath = isAbsolute(policyPath) ? policyPath : join(repoRoot, policyPath);
			let policyWarned = false;
			const warnOnce = (eventCtx: typeof ctx, message: string): void => {
				if (policyWarned) return;
				policyWarned = true;
				if (eventCtx.hasUI) eventCtx.ui.notify(message, "warning");
				else console.warn(message);
			};

			pi.on("before_agent_start", async (event, eventCtx) => {
				let block: string;
				try {
					const body = readFileSync(resolvedPolicyPath, "utf8");
					if (body.trim() === "") {
						warnOnce(eventCtx, `pi-quiver: Slack policy file ${policyPath} is empty; posting policy is unknown this session.`);
						block = buildPolicyBlock({ source: policyPath, status: "empty" });
					} else {
						block = buildPolicyBlock({ source: policyPath, status: "ok", body });
					}
				} catch (err) {
					const code = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));
					warnOnce(eventCtx, `pi-quiver: Slack policy file ${policyPath} could not be read (${code}); posting policy is unknown this session.`);
					block = buildPolicyBlock({ source: policyPath, status: "unreadable", code });
				}
				return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
			});
		}

		pi.registerTool({
			name: "slack_search",
			label: "Slack Search",
			promptSnippet: "Search Slack messages with Slack's search operator grammar",
			description:
				'Search Slack messages via search.messages. Always uses the "user" identity (search.messages accepts only user tokens - no `as` param). `query` uses Slack\'s documented operator grammar (e.g. `in:#channel-name`, `from:@display-name`); channel/user names in the query are passed through as-is, never rewritten to IDs. `count` (default 20, max 100) and optional `page` control a single page of Slack\'s offset-paginated results. Output is compact (author, channel, ts, permalink, text) and size-gated: over 32KB/1000 lines it is written to a temp file with a 60-line preview.',
			parameters: Type.Object({
				query: Type.String({ description: "Slack search query, e.g. 'deploy in:#eng from:@alice'" }),
				count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
				page: Type.Optional(Type.Integer({ minimum: 1 })),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					const { deps } = await resolveCall("user", cfg, ctx, signal, repoRoot);
					const result = await searchMessages(params, deps);
					return {
						content: [{ type: "text" as const, text: searchResultText(result) }],
						details: result,
					};
				}, "user");
			},
			renderCall: (args, theme) => oneLine(theme, "slack_search", args.query ?? ""),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_thread",
			label: "Slack Thread",
			promptSnippet: "Read all replies in a Slack thread",
			description:
				'Read a Slack thread via conversations.replies. Always uses the "user" identity (no `as` param). Provide either `channel` (#name or channel ID; user @names not accepted) plus `ts`, or a `permalink` (parsed for channel+ts). Paginates by cursor until Slack reports no more replies or a cap of 50 pages / 5,000 messages is hit; the result carries a `complete` flag and a resumable `next_cursor` when capped. Caveat: since 2025-05-29, conversations.replies is rate-limited to ~1 request/minute (limit capped at 15) for apps that are neither Marketplace-listed nor classified internal - hitting that throttle mid-pagination returns the messages collected so far plus a caveat and a resumable cursor instead of spinning. Output is size-gated like slack_search.',
			parameters: Type.Object({
				channel: Type.Optional(Type.String({ description: "#name or channel ID (user @names not accepted)" })),
				ts: Type.Optional(Type.String({ description: "Thread parent timestamp" })),
				permalink: Type.Optional(Type.String({ description: "A Slack message permalink URL to parse channel+ts from" })),
				cursor: Type.Optional(Type.String({ description: "Resume pagination from a next_cursor returned by a prior capped call" })),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					const { deps, cacheCtx } = await resolveCall("user", cfg, ctx, signal, repoRoot);
					const channel = params.channel !== undefined ? await resolveChannel(params.channel, cacheCtx) : undefined;
					const result = await readThread({ channel, ts: params.ts, permalink: params.permalink, cursor: params.cursor }, deps);
					return {
						content: [{ type: "text" as const, text: threadResultText(result) }],
						details: result,
					};
				}, "user");
			},
			renderCall: (args, theme) => oneLine(theme, "slack_thread", args.permalink ?? args.channel ?? ""),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_post",
			label: "Slack Post",
			promptSnippet: "Post a Slack message, reply, or headline+detail announcement",
			description:
				"Post a Slack message via chat.postMessage, as `as: \"user\"` or `as: \"bot\"`. `channel` accepts #name or a channel ID (user @names not accepted). Plain post: `text` and/or `blocks` (Block Kit JSON, passed through unvalidated). Threaded reply: also set `thread_ts` - no headline is ever emitted, `thread_body` (or `text`) becomes the reply body. Announce mode: set `thread_body` WITHOUT `thread_ts` - posts a short single-line `text` headline, then posts `thread_body` as the first threaded reply in the same call; if `thread_body`'s rendered length exceeds the configured uploadThresholdChars (default 4000), it is delivered as a threaded file upload instead. Recovery: re-invoke with `thread_ts` set (never re-omit it) to post only into the existing thread - a second headline is never sent. On detail-delivery failure the headline is marked \"detail pending\" and the detail is saved to a temp file; the error names the path. `unfurl_links`/`unfurl_media` apply to this post only, are omitted when unset (Slack's default stands), and slack_update cannot change unfurling after the fact.",
			parameters: Type.Object({
				as: IDENTITY,
				channel: Type.String({ description: "#name or channel ID (user @names not accepted)" }),
				text: Type.Optional(Type.String({ description: "Message text, or the announce headline when thread_body is set" })),
				blocks: Type.Optional(Type.Array(Type.Unknown(), { description: "Block Kit JSON array, passed through unvalidated" })),
				thread_ts: Type.Optional(Type.String({ description: "Reply into this existing thread instead of posting a new headline" })),
				thread_body: Type.Optional(Type.String({ description: "Detail body for an announce headline, or the reply body when thread_ts is set" })),
				unfurl_links: Type.Optional(
					Type.Boolean({ description: "Slack unfurls link previews by default; pass false to suppress text-link previews for this message." }),
				),
				unfurl_media: Type.Optional(
					Type.Boolean({ description: "Pass false to suppress image/video previews for this message." }),
				),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					assertNoMarkdownText(params);
					const { deps, cacheCtx } = await resolveCall(params.as, cfg, ctx, signal, repoRoot);
					const channel = await resolveChannel(params.channel, cacheCtx);

					// Only the fields core will actually send: announce uses text + thread_body (both
					// scanned), a threaded reply collapses to thread_body ?? text (whichever param carried
					// the body is the one core reads, so substitute into that same field - never the
					// other), a plain post is text alone.
					const isAnnounce = params.thread_body !== undefined && params.thread_ts === undefined;
					const isReply = params.thread_ts !== undefined;
					let text: string | undefined;
					let threadBody: string | undefined;
					let mentions: { unresolved: UnresolvedMention[]; lookupError?: string };
					if (isAnnounce) {
						const resolved = await resolveMentions(
							[
								{ field: "text", value: params.text ?? "" },
								{ field: "thread_body", value: params.thread_body ?? "" },
							],
							cacheCtx,
						);
						mentions = resolved;
						text = resolved.values[0];
						threadBody = resolved.values[1];
					} else if (isReply) {
						const replyField: "text" | "thread_body" = params.thread_body !== undefined ? "thread_body" : "text";
						const resolved = await resolveMentions([{ field: replyField, value: params.thread_body ?? params.text ?? "" }], cacheCtx);
						mentions = resolved;
						if (replyField === "thread_body") {
							text = params.text;
							threadBody = resolved.values[0];
						} else {
							text = params.text === undefined ? undefined : resolved.values[0];
							threadBody = undefined;
						}
					} else {
						const resolved = await resolveMentions([{ field: "text", value: params.text ?? "" }], cacheCtx);
						mentions = resolved;
						text = params.text === undefined ? undefined : resolved.values[0];
					}

					const result = await postMessage(
						{
							channel,
							text,
							blocks: params.blocks,
							thread_ts: params.thread_ts,
							thread_body: threadBody,
							unfurl_links: params.unfurl_links,
							unfurl_media: params.unfurl_media,
						},
						{ ...deps, thresholdChars: cfg.uploadThresholdChars, uploadBytes: defaultUploadBytes },
					);
					return mentionAwareResult(result, mentions, { detailUploaded: "detailUploaded" in result && result.detailUploaded === true });
				}, params.as);
			},
			renderCall: (args, theme) => oneLine(theme, "slack_post", `as:${args.as} ${args.channel}`),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_update",
			label: "Slack Update",
			promptSnippet: "Edit an existing Slack message",
			description:
				'Edit a message via chat.update, as `as: "user"` or `as: "bot"`. `channel` accepts #name or a channel ID (user @names not accepted). Only the identity that originally posted the message can edit it (Slack constraint; surfaced as an error otherwise). Accepts `text` and/or `blocks` (Block Kit JSON, unvalidated).',
			parameters: Type.Object({
				as: IDENTITY,
				channel: Type.String({ description: "#name or channel ID (user @names not accepted)" }),
				ts: Type.String({ description: "Timestamp of the message to edit" }),
				text: Type.Optional(Type.String()),
				blocks: Type.Optional(Type.Array(Type.Unknown(), { description: "Block Kit JSON array, passed through unvalidated" })),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					assertNoMarkdownText(params);
					const { deps, cacheCtx } = await resolveCall(params.as, cfg, ctx, signal, repoRoot);
					const channel = await resolveChannel(params.channel, cacheCtx);
					const mentions = await resolveMentions([{ field: "text", value: params.text ?? "" }], cacheCtx);
					const result = await updateMessage(
						{ channel, ts: params.ts, text: params.text === undefined ? undefined : mentions.values[0], blocks: params.blocks },
						deps,
					);
					return mentionAwareResult(result, mentions);
				}, params.as);
			},
			renderCall: (args, theme) => oneLine(theme, "slack_update", `as:${args.as} ${args.channel} ts:${args.ts}`),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_delete",
			label: "Slack Delete",
			promptSnippet: "Delete a Slack message",
			description:
				'Delete a message via chat.delete, as `as: "user"` or `as: "bot"`. `channel` accepts #name or a channel ID (user @names not accepted). Only the identity that originally posted the message can delete it (Slack constraint; surfaced as an error otherwise).',
			parameters: Type.Object({
				as: IDENTITY,
				channel: Type.String({ description: "#name or channel ID (user @names not accepted)" }),
				ts: Type.String({ description: "Timestamp of the message to delete" }),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					const { deps, cacheCtx } = await resolveCall(params.as, cfg, ctx, signal, repoRoot);
					const channel = await resolveChannel(params.channel, cacheCtx);
					const result = await deleteMessage({ channel, ts: params.ts }, deps);
					return {
						content: [{ type: "text" as const, text: channelLine(result) }],
						details: result,
					};
				}, params.as);
			},
			renderCall: (args, theme) => oneLine(theme, "slack_delete", `as:${args.as} ${args.channel} ts:${args.ts}`),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_pin",
			label: "Slack Pin",
			promptSnippet: "Pin a Slack message to its channel",
			description:
				'Pin a message via pins.add, as `as: "user"` or `as: "bot"`. `channel` accepts #name or a channel ID (user @names not accepted). Slack errors are mapped: already_pinned, not_pinnable (this message type cannot be pinned), too_many_pins (the channel hit Slack\'s pin limit).',
			parameters: Type.Object({
				as: IDENTITY,
				channel: Type.String({ description: "#name or channel ID (user @names not accepted)" }),
				ts: Type.String({ description: "Timestamp of the message to pin" }),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					const { deps, cacheCtx } = await resolveCall(params.as, cfg, ctx, signal, repoRoot);
					const channel = await resolveChannel(params.channel, cacheCtx);
					const result = await pinMessage({ channel, ts: params.ts }, deps);
					return {
						content: [{ type: "text" as const, text: channelLine(result) }],
						details: result,
					};
				}, params.as);
			},
			renderCall: (args, theme) => oneLine(theme, "slack_pin", `as:${args.as} ${args.channel} ts:${args.ts}`),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_upload",
			label: "Slack Upload",
			promptSnippet: "Upload a file to a Slack channel or thread",
			description:
				'Upload a file to Slack (getUploadURLExternal -> upload -> completeUploadExternal), as `as: "user"` or `as: "bot"`. `channel` accepts #name or a channel ID (user @names not accepted). `path` is an absolute path or resolved relative to the current working directory; a missing file errors before any network call. `filename` defaults to the path\'s basename. Optional `title`, `thread_ts` (attach to an existing thread), and `initial_comment`.',
			parameters: Type.Object({
				as: IDENTITY,
				channel: Type.String({ description: "#name or channel ID (user @names not accepted)" }),
				path: Type.String({ description: "Absolute path, or a path relative to the current working directory" }),
				filename: Type.Optional(Type.String({ description: "Defaults to the basename of path" })),
				title: Type.Optional(Type.String()),
				thread_ts: Type.Optional(Type.String({ description: "Attach the upload to this existing thread" })),
				initial_comment: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, signal) {
				return guarded(async () => {
					const resolvedPath = isAbsolute(params.path) ? params.path : join(ctx.cwd, params.path);
					let bytes: Uint8Array;
					try {
						bytes = readFileSync(resolvedPath);
					} catch (err) {
						const detail = err instanceof Error ? err.message : String(err);
						throw new SlackError("file_not_found", `Cannot read file at ${resolvedPath}: ${detail}`);
					}
					const { deps, cacheCtx } = await resolveCall(params.as, cfg, ctx, signal, repoRoot);
					const channel = await resolveChannel(params.channel, cacheCtx);
					const result = await uploadFile(
						{
							channel,
							bytes,
							filename: params.filename ?? basename(resolvedPath),
							title: params.title,
							thread_ts: params.thread_ts,
							initial_comment: params.initial_comment,
						},
						{ ...deps, uploadBytes: defaultUploadBytes },
					);
					return {
						content: [{ type: "text" as const, text: channelLine(result) }],
						details: result,
					};
				}, params.as);
			},
			renderCall: (args, theme) => oneLine(theme, "slack_upload", `as:${args.as} ${args.channel} ${args.path}`),
			renderResult: renderToolResult,
		});

		pi.registerTool({
			name: "slack_cache_refresh",
			label: "Slack Cache Refresh",
			promptSnippet: "Rebuild the Slack channel/user name->ID cache",
			description:
				'Rebuild the Slack channel and user name->ID cache from scratch (full conversations.list + users.list scan, atomic replace). Uses the "user" identity when a user token is configured, else falls back to "bot" (no `as` param). Run this after channels/users change or when a #name/@name lookup unexpectedly fails with name_not_found. Reports the resulting channel, user, and email counts - a low email/user ratio hints the users:read.email scope may be missing.',
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, signal) {
				const identity = pickCacheRefreshIdentity(cfg, process.env, repoRoot);
				return guarded(async () => {
					const { cacheCtx } = await resolveCall(identity, cfg, ctx, signal, repoRoot);
					const result = await refreshCache(cacheCtx);
					const ratio =
						result.users === 0
							? ""
							: result.emails === 0
								? ` | emails: 0/${result.users} (users:read.email scope may be missing)`
								: ` | emails: ${result.emails}/${result.users}`;
					return {
						content: [{ type: "text" as const, text: `channels: ${result.channels}, users: ${result.users}${ratio}` }],
						details: result,
					};
				}, identity);
			},
			renderCall: (_args, theme) => oneLine(theme, "slack_cache_refresh", ""),
			renderResult: renderToolResult,
		});
	});
}
