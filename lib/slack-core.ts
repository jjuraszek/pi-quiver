/**
 * Config + token resolution for the (future) slack extension. Stays
 * pi-free: `warn` is an injected callback, `cwd`/`env` are explicit
 * parameters, so callers (extensions/slack.ts, tests) control everything
 * this module reads.
 *
 * Config ladder: `resolveConfig` (shared, `lib/extension-config.ts`) for the
 * settings.json layers (pi-home, repo `.pi/settings.json`), then a
 * slack-local `PI_QUIVER_SLACK_*` env-var overlay applied on top.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "./extension-config.ts";

export interface SlackConfig {
	enabled: boolean;
	cachePath: string | undefined;
	userTokenEnv: string;
	botTokenEnv: string;
	uploadThresholdChars: number;
}

export const DEFAULT_SLACK_CONFIG: SlackConfig = {
	enabled: false,
	cachePath: undefined,
	userTokenEnv: "SLACK_USER_TOKEN",
	botTokenEnv: "SLACK_BOT_TOKEN",
	uploadThresholdChars: 4000,
};

export class SlackError extends Error {
	code: string;
	data?: Record<string, unknown>;
	constructor(code: string, message: string, data?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export function coerce(raw: unknown): Partial<SlackConfig> | undefined {
	if (typeof raw === "boolean") return { enabled: raw };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const o = raw as Record<string, unknown>;
	const patch: Partial<SlackConfig> = {};
	if (typeof o.enabled === "boolean") patch.enabled = o.enabled;
	if (typeof o.cachePath === "string") patch.cachePath = o.cachePath;
	if (typeof o.userTokenEnv === "string") patch.userTokenEnv = o.userTokenEnv;
	if (typeof o.botTokenEnv === "string") patch.botTokenEnv = o.botTokenEnv;
	if (typeof o.uploadThresholdChars === "number" && Number.isInteger(o.uploadThresholdChars) && o.uploadThresholdChars > 0) {
		patch.uploadThresholdChars = o.uploadThresholdChars;
	}
	return patch;
}

const emittedEnvWarnings = new Set<string>();

function emitEnvWarning(warn: ((message: string) => void) | undefined, key: string, message: string): void {
	if (!warn || emittedEnvWarnings.has(key)) return;
	emittedEnvWarnings.add(key);
	warn(message);
}

function parseBooleanEnv(value: string): boolean | undefined {
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	return undefined;
}

function parsePositiveIntEnv(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const n = Number.parseInt(value, 10);
	return n > 0 ? n : undefined;
}

export function applyEnvOverrides(
	cfg: SlackConfig,
	env: Record<string, string | undefined>,
	warn?: (message: string) => void,
): SlackConfig {
	const result = { ...cfg };

	const enabledRaw = env.PI_QUIVER_SLACK_ENABLED;
	if (enabledRaw !== undefined && enabledRaw !== "") {
		const parsed = parseBooleanEnv(enabledRaw);
		if (parsed !== undefined) result.enabled = parsed;
		else emitEnvWarning(warn, "PI_QUIVER_SLACK_ENABLED", `pi-quiver: env var PI_QUIVER_SLACK_ENABLED has an unrecognized value; ignored.`);
	}

	const cachePathRaw = env.PI_QUIVER_SLACK_CACHE_PATH;
	if (cachePathRaw !== undefined && cachePathRaw !== "") result.cachePath = cachePathRaw;

	const userTokenEnvRaw = env.PI_QUIVER_SLACK_USER_TOKEN_ENV;
	if (userTokenEnvRaw !== undefined && userTokenEnvRaw !== "") result.userTokenEnv = userTokenEnvRaw;

	const botTokenEnvRaw = env.PI_QUIVER_SLACK_BOT_TOKEN_ENV;
	if (botTokenEnvRaw !== undefined && botTokenEnvRaw !== "") result.botTokenEnv = botTokenEnvRaw;

	const uploadThresholdRaw = env.PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS;
	if (uploadThresholdRaw !== undefined && uploadThresholdRaw !== "") {
		const parsed = parsePositiveIntEnv(uploadThresholdRaw);
		if (parsed !== undefined) result.uploadThresholdChars = parsed;
		else
			emitEnvWarning(
				warn,
				"PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS",
				`pi-quiver: env var PI_QUIVER_SLACK_UPLOAD_THRESHOLD_CHARS has an unrecognized value; ignored.`,
			);
	}

	return result;
}

export function resolveSlackConfig(cwd: string, env: Record<string, string | undefined>, warn?: (message: string) => void): SlackConfig {
	return applyEnvOverrides(resolveConfig(cwd, "slack", DEFAULT_SLACK_CONFIG, coerce, warn), env, warn);
}

export function discoverRepoRoot(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return cwd;
	}
}

export function primaryCheckoutRoot(cwd: string): string | undefined {
	try {
		const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
		}).trim();
		return dirname(gitCommonDir);
	} catch {
		return undefined;
	}
}

export function parseEnvFile(content: string): Map<string, string> {
	// Deliberate: inline `#` comments after unquoted values are NOT stripped - a token may
	// legitimately contain `#`. Quote the value if you need a trailing comment.
	const result = new Map<string, string>();
	for (const line of content.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match) continue;
		const [, key, rawValue] = match;
		let value = rawValue;
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
				value = value.slice(1, -1);
			}
		}
		result.set(key, value);
	}
	return result;
}

function readEnvFile(dir: string): Map<string, string> | undefined {
	try {
		return parseEnvFile(readFileSync(join(dir, ".env"), "utf8"));
	} catch (err) {
		// Deliberate: a genuinely absent .env degrades to "token not found", not a thrown error.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		// Present but unreadable (e.g. permissions): re-thrown so callers treat it as present-but-empty,
		// not absent - this must NOT authorize the primary-checkout fallback.
		throw err;
	}
}

export function resolveToken(
	identity: "user" | "bot",
	cfg: SlackConfig,
	env: Record<string, string | undefined>,
	repoRoot: string,
): string {
	const envVar = identity === "user" ? cfg.userTokenEnv : cfg.botTokenEnv;

	const fromEnv = env[envVar];
	if (fromEnv) return fromEnv;

	let repoEnvFile: Map<string, string> | undefined;
	let repoEnvUnreadable = false;
	try {
		repoEnvFile = readEnvFile(repoRoot);
	} catch {
		repoEnvUnreadable = true;
	}

	if (repoEnvFile) {
		// An empty (after quote-strip) .env value is treated as missing, not a usable empty token.
		const value = repoEnvFile.get(envVar);
		if (value) return value;
	} else if (!repoEnvUnreadable) {
		// File-level fallback only, per spec: this only triggers when the worktree root has no .env at
		// all (ENOENT); an existing-but-unreadable local .env blocks the fallback just like an existing
		// one that lacks this key.
		const primaryRoot = primaryCheckoutRoot(repoRoot);
		if (primaryRoot && primaryRoot !== repoRoot) {
			// Best-effort: any error reading the primary .env (missing or otherwise) just means no fallback.
			let primaryEnvFile: Map<string, string> | undefined;
			try {
				primaryEnvFile = readEnvFile(primaryRoot);
			} catch {
				primaryEnvFile = undefined;
			}
			const value = primaryEnvFile?.get(envVar);
			if (value) return value;
		}
	}

	throw new SlackError(
		"missing_token",
		`No Slack ${identity} token: env var ${envVar} is empty and no .env entry was found.`,
	);
}

/**
 * Data-plane transport: every Slack API call and file upload funnels through
 * these two injectable functions so tests script responses without network.
 * Retry policy lives with the caller (`opts.retry`), not the transport.
 */

export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RETRY_AFTER_MS = 30_000;
const RETRY_AFTER_DEFAULT_S = 2;

export interface ApiOpts {
	retry?: boolean;
	signal?: AbortSignal;
}

export type ApiCall = (
	method: string,
	token: string,
	params: Record<string, unknown>,
	opts?: ApiOpts,
) => Promise<Record<string, unknown>>;

export type UploadBytes = (url: string, bytes: Uint8Array, opts?: { signal?: AbortSignal }) => Promise<void>;

const JSON_METHODS = new Set(["chat.postMessage", "chat.update"]);

export const ERROR_HINTS: Record<string, string> = {
	channel_not_found: "check the name or run slack_cache_refresh",
	not_in_channel: "invite the bot to the channel",
	msg_too_long: "message exceeds Slack's length ceiling",
	is_archived: "the channel is archived",
	edit_window_closed: "Slack's edit window for this message has closed",
	already_pinned: "the message is already pinned",
	not_pinnable: "this message type cannot be pinned",
	too_many_pins: "the channel has reached Slack's pin limit",
};

function mapSlackApiError(data: Record<string, unknown>): SlackError {
	const code = typeof data.error === "string" ? data.error : "unknown_error";
	if (code === "missing_scope") {
		const needed = typeof data.needed === "string" ? data.needed : "unknown";
		return new SlackError(
			code,
			`missing_scope: the token passed to this call does not have the "${needed}" scope.`,
			data,
		);
	}
	const hint = ERROR_HINTS[code];
	const message = hint ? `${code}: ${hint}` : code;
	return new SlackError(code, message, data);
}

function buildRequest(
	baseUrl: string,
	method: string,
	token: string,
	params: Record<string, unknown>,
): { url: string; init: RequestInit } {
	const url = `${baseUrl}/api/${method}`;
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (JSON_METHODS.has(method)) {
		headers["content-type"] = "application/json";
		return { url, init: { method: "POST", headers, body: JSON.stringify(params) } };
	}
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) body.set(key, String(value));
	}
	headers["content-type"] = "application/x-www-form-urlencoded";
	return { url, init: { method: "POST", headers, body: body.toString() } };
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Shared fetch wrapper for apiCall and uploadBytes: builds the caller-signal + timeout-signal
 * combo, runs the fetch, and maps any failure to a SlackError. Caller-initiated cancellation
 * (opts.signal aborted) gets its own "aborted" code. A timeout is deliberately NOT a distinct
 * code - it stays "transport", because a later wave treats "transport" as "outcome unknown, the
 * request may have reached Slack", which is true for timeouts too - only the message changes.
 */
async function fetchOrTransportError(
	url: string,
	init: RequestInit,
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
	describe: (detail: string) => string,
): Promise<Response> {
	if (callerSignal?.aborted) throw new SlackError("aborted", "Request was cancelled.");
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
	try {
		return await fetch(url, { ...init, signal });
	} catch (err) {
		if (callerSignal?.aborted) throw new SlackError("aborted", "Request was cancelled.");
		const detail = timeoutSignal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message;
		throw new SlackError("transport", describe(detail));
	}
}

export function makeApiCall(
	baseUrl: string = "https://slack.com",
	sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
	timeoutMs: number = REQUEST_TIMEOUT_MS,
): ApiCall {
	async function performCall(
		method: string,
		token: string,
		params: Record<string, unknown>,
		opts: ApiOpts,
		isRetry: boolean,
	): Promise<Record<string, unknown>> {
		const { url, init } = buildRequest(baseUrl, method, token, params);
		const res = await fetchOrTransportError(
			url,
			init,
			opts.signal,
			timeoutMs,
			(detail) => `Slack API request to ${method} failed: ${detail}`,
		);
		if (res.status === 429) {
			const rawRetryAfter = Number(res.headers.get("retry-after") ?? String(RETRY_AFTER_DEFAULT_S));
			const retryAfterSec = Number.isFinite(rawRetryAfter) && rawRetryAfter > 0 ? rawRetryAfter : RETRY_AFTER_DEFAULT_S;
			if (opts.retry && !isRetry) {
				const waitMs = Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
				await sleep(waitMs, opts.signal);
				return performCall(method, token, params, opts, true);
			}
			throw new SlackError("rate_limited", `Slack rate-limited ${method}; retry after ${retryAfterSec}s.`);
		}
		if (!res.ok) {
			throw new SlackError(`http_${res.status}`, `Slack API ${method} returned HTTP ${res.status}.`);
		}
		const data = (await res.json()) as Record<string, unknown>;
		if (data.ok === false) throw mapSlackApiError(data);
		return data;
	}

	return (method, token, params, opts = {}) => performCall(method, token, params, opts, false);
}

export const defaultApiCall: ApiCall = makeApiCall();

export const defaultUploadBytes: UploadBytes = async (url, bytes, opts) => {
	const res = await fetchOrTransportError(
		url,
		{ method: "POST", body: bytes as BodyInit },
		opts?.signal,
		REQUEST_TIMEOUT_MS,
		(detail) => `Upload request failed: ${detail}`,
	);
	if (!res.ok) {
		throw new SlackError(`http_${res.status}`, `Upload returned HTTP ${res.status}.`);
	}
};

/**
 * Size gating for slack_search / slack_thread output: same thresholds as
 * fetch-core, defined locally to avoid a cross-module dependency. Output
 * under both caps is returned inline; over either cap, the full text is
 * written once to a timestamped+hashed file under tmpdir()/pi-slack (never
 * deleted by the tool) and a bounded preview + the file path is returned.
 */

export const INLINE_MAX_BYTES = 32_000;
export const INLINE_MAX_LINES = 1_000;
export const PREVIEW_MAX_LINES = 60;
export const PREVIEW_MAX_BYTES = 4_000;

export function gateOutput(text: string, slug: string): { output: string; spilled: boolean; path?: string } {
	const byteLength = Buffer.byteLength(text, "utf8");
	const lineCount = text === "" ? 1 : text.split("\n").length;
	if (byteLength <= INLINE_MAX_BYTES && lineCount <= INLINE_MAX_LINES) {
		return { output: text, spilled: false };
	}

	const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
	const dir = join(tmpdir(), "pi-slack");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${Date.now()}-${hash}-${slug}.md`);
	writeFileSync(path, text, "utf8");

	let preview = text.split("\n").slice(0, PREVIEW_MAX_LINES).join("\n");
	if (Buffer.byteLength(preview, "utf8") > PREVIEW_MAX_BYTES) {
		const truncated = Buffer.from(preview, "utf8").subarray(0, PREVIEW_MAX_BYTES).toString("utf8");
		// A byte-boundary cut can land mid multi-byte char, which toString("utf8") replaces with
		// U+FFFD - strip a trailing one so the preview never ends on a mangled character.
		preview = truncated.endsWith("\uFFFD") ? truncated.slice(0, -1) : truncated;
	}
	const output = `${preview}\n\n[truncated - full output written to ${path}]`;
	return { output, spilled: true, path };
}

/**
 * slack_search / slack_thread data plane. Both tools accept only a user
 * token (search.messages is a user-token-only method; thread reads follow
 * the same identity for consistency) and always pass {retry: false} - the
 * generic 429-retry-once policy (lib-level, opts.retry) is for mutations;
 * search/thread reads surface the throttle instead of spinning.
 */

export interface CoreDeps {
	apiCall: ApiCall;
	token: string;
	signal?: AbortSignal;
}

export const THREAD_PAGE_CAP = 50;
export const THREAD_MESSAGE_CAP = 5_000;

export interface SearchResult {
	output: string;
	spilled: boolean;
	path?: string;
	total: number;
	page: number;
	pageCount: number;
}

export interface ThreadResult {
	output: string;
	spilled: boolean;
	path?: string;
	complete: boolean;
	nextCursor?: string;
	caveat?: string;
	messageCount: number;
}

const THREAD_THROTTLE_CAVEAT =
	"Since 2025-05-29, conversations.replies is rate limited to ~1 request/minute with limit capped at 15 for apps that are neither Marketplace-listed nor classified internal.";

export function parsePermalink(url: string): { channel: string; ts: string } | undefined {
	const match = /\/archives\/([A-Za-z0-9]+)\/p(\d+)/.exec(url);
	if (!match) return undefined;
	const [, channel, digits] = match;
	if (digits.length <= 6) return undefined;
	return { channel, ts: `${digits.slice(0, -6)}.${digits.slice(-6)}` };
}

function renderSearchLine(match: Record<string, unknown>): string {
	const author = typeof match.username === "string" ? match.username : String(match.user ?? "unknown");
	const channelObj = match.channel as Record<string, unknown> | undefined;
	const channelName = typeof channelObj?.name === "string" ? channelObj.name : String(channelObj?.id ?? "unknown");
	const ts = String(match.ts ?? "");
	const permalink = String(match.permalink ?? "");
	const text = typeof match.text === "string" ? match.text.replace(/\r?\n/g, " ") : "";
	return `${author} | #${channelName} | ${ts} | ${permalink} | ${text}`;
}

export async function searchMessages(
	args: { query: string; count?: number; page?: number },
	deps: CoreDeps,
): Promise<SearchResult> {
	const count = Math.min(Math.max(Math.trunc(args.count ?? 20), 1), 100);
	const params: Record<string, unknown> = { query: args.query, count };
	if (args.page !== undefined) params.page = args.page;

	const data = await deps.apiCall("search.messages", deps.token, params, { retry: false, signal: deps.signal });
	const messagesBlock = (data.messages as Record<string, unknown> | undefined) ?? {};
	const matches = (messagesBlock.matches as Record<string, unknown>[] | undefined) ?? [];
	const paging = (messagesBlock.paging as Record<string, unknown> | undefined) ?? {};
	const total = typeof paging.total === "number" ? paging.total : matches.length;
	const page = typeof paging.page === "number" ? paging.page : (args.page ?? 1);
	const pageCount = typeof paging.pages === "number" ? paging.pages : 1;

	const rendered = matches.map(renderSearchLine).join("\n");
	const gated = gateOutput(rendered, "search");
	return { ...gated, total, page, pageCount };
}

function renderThreadLine(message: Record<string, unknown>): string {
	const author = typeof message.user === "string" ? message.user : String(message.username ?? "unknown");
	const ts = String(message.ts ?? "");
	const text = typeof message.text === "string" ? message.text.replace(/\r?\n/g, " ") : "";
	return `${author} | ${ts} | ${text}`;
}

export async function readThread(
	args: { channel?: string; ts?: string; permalink?: string; cursor?: string },
	deps: CoreDeps,
): Promise<ThreadResult> {
	let channel = args.channel;
	let ts = args.ts;
	if (args.permalink !== undefined) {
		const parsed = parsePermalink(args.permalink);
		if (!parsed) throw new SlackError("invalid_permalink", "Could not parse a channel/ts pair out of that Slack permalink.");
		channel = parsed.channel;
		ts = parsed.ts;
	}
	if (!channel || !ts) {
		throw new SlackError("invalid_args", "slack_thread requires either channel+ts or a permalink.");
	}

	const messages: Record<string, unknown>[] = [];
	let cursor: string | undefined = args.cursor;
	let complete = false;
	let nextCursor: string | undefined;
	let caveat: string | undefined;

	for (let page = 1; page <= THREAD_PAGE_CAP; page++) {
		let data: Record<string, unknown>;
		try {
			data = await deps.apiCall(
				"conversations.replies",
				deps.token,
				{ channel, ts, cursor },
				{ retry: false, signal: deps.signal },
			);
		} catch (err) {
			if (err instanceof SlackError && err.code === "rate_limited") {
				nextCursor = cursor;
				caveat = THREAD_THROTTLE_CAVEAT;
				break;
			}
			throw err;
		}

		const batch = (data.messages as Record<string, unknown>[] | undefined) ?? [];
		messages.push(...batch);
		const hasMore = data.has_more === true;
		const meta = data.response_metadata as Record<string, unknown> | undefined;
		const fetchedCursor = typeof meta?.next_cursor === "string" && meta.next_cursor !== "" ? meta.next_cursor : undefined;

		if (messages.length > THREAD_MESSAGE_CAP) {
			// Hard 5,000-message bound: slice off this page's overshoot so messages.length never
			// exceeds THREAD_MESSAGE_CAP. Resuming means refetching this same page from `cursor`
			// (its start) - the sliced-off remainder came from this page, so a resume re-fetch will
			// duplicate the already-emitted messages, which is acceptable per the cap contract.
			messages.length = THREAD_MESSAGE_CAP;
			nextCursor = cursor;
			break;
		}

		if (!hasMore) {
			complete = true;
			break;
		}
		if (messages.length >= THREAD_MESSAGE_CAP || page === THREAD_PAGE_CAP) {
			nextCursor = fetchedCursor;
			break;
		}
		cursor = fetchedCursor;
	}

	const rendered = messages.map(renderThreadLine).join("\n");
	const gated = gateOutput(rendered, "thread");
	return { ...gated, complete, nextCursor, caveat, messageCount: messages.length };
}

/**
 * slack_post_plain / slack_update / slack_delete / slack_pin / slack_upload
 * data plane. Mutation success is authoritative: a chat.getPermalink
 * failure never fails the call, it degrades to `warning` on the result.
 * All mutating calls pass {retry: true} (429 gets one retry); the
 * decorative getPermalink lookup passes {retry: false} - it is never worth
 * a sleep.
 */

export interface MutationResult {
	channel: string;
	ts?: string;
	permalink?: string;
	warning?: string;
	// Set only when an upload-fallback path posted a threaded intro reply (deliverDetailUpload) -
	// its own message coordinate, distinct from the headline/reply `ts` above.
	detailTs?: string;
}

// Deliberately separate from SlackConfig.uploadThresholdChars (doc/specs/2026-08-29-gh-7-slack-extension.md
// Announce protocol): this is a fixed hard error for plain text/headline; uploadThresholdChars is a
// configurable cutoff that only gates thread_body -> upload in the announce protocol.
export const MAX_TEXT_LENGTH = 4_000;

function assertTextWithinLimit(text: string | undefined): void {
	if (text !== undefined && text.length > MAX_TEXT_LENGTH) {
		throw new SlackError(
			"text_too_long",
			`text is ${text.length} UTF-16 code units, over the ${MAX_TEXT_LENGTH} limit; use thread_body for announcements or slack_upload for documents.`,
		);
	}
}

function requireResponseString(data: Record<string, unknown>, method: string, field: string): string {
	const value = data[field];
	if (typeof value !== "string" || value === "") {
		throw new SlackError("unexpected_response", `${method} returned an unexpected response: missing "${field}".`);
	}
	return value;
}

async function withPermalink(deps: CoreDeps, channel: string, ts: string): Promise<{ permalink?: string; warning?: string }> {
	try {
		const data = await deps.apiCall("chat.getPermalink", deps.token, { channel, message_ts: ts }, { retry: false, signal: deps.signal });
		return { permalink: typeof data.permalink === "string" ? data.permalink : undefined };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { warning: `Could not fetch a permalink for this message: ${detail}` };
	}
}

export async function postPlain(
	args: { channel: string; text?: string; blocks?: unknown[]; thread_ts?: string },
	deps: CoreDeps,
): Promise<MutationResult> {
	assertTextWithinLimit(args.text);

	const params: Record<string, unknown> = { channel: args.channel };
	if (args.text !== undefined) params.text = args.text;
	if (args.blocks !== undefined) params.blocks = args.blocks;
	if (args.thread_ts !== undefined) params.thread_ts = args.thread_ts;

	const data = await deps.apiCall("chat.postMessage", deps.token, params, { retry: true, signal: deps.signal });
	const channel = typeof data.channel === "string" ? data.channel : args.channel;
	const ts = requireResponseString(data, "chat.postMessage", "ts");
	const { permalink, warning } = await withPermalink(deps, channel, ts);
	return { channel, ts, permalink, warning };
}

export async function updateMessage(
	args: { channel: string; ts: string; text?: string; blocks?: unknown[] },
	deps: CoreDeps,
): Promise<MutationResult> {
	assertTextWithinLimit(args.text);

	const params: Record<string, unknown> = { channel: args.channel, ts: args.ts };
	if (args.text !== undefined) params.text = args.text;
	if (args.blocks !== undefined) params.blocks = args.blocks;

	const data = await deps.apiCall("chat.update", deps.token, params, { retry: true, signal: deps.signal });
	const channel = typeof data.channel === "string" ? data.channel : args.channel;
	const ts = requireResponseString(data, "chat.update", "ts");
	const { permalink, warning } = await withPermalink(deps, channel, ts);
	return { channel, ts, permalink, warning };
}

export async function deleteMessage(args: { channel: string; ts: string }, deps: CoreDeps): Promise<MutationResult> {
	await deps.apiCall("chat.delete", deps.token, { channel: args.channel, ts: args.ts }, { retry: true, signal: deps.signal });
	return { channel: args.channel, ts: args.ts };
}

export async function pinMessage(args: { channel: string; ts: string }, deps: CoreDeps): Promise<MutationResult> {
	await deps.apiCall("pins.add", deps.token, { channel: args.channel, timestamp: args.ts }, { retry: true, signal: deps.signal });
	const { permalink, warning } = await withPermalink(deps, args.channel, args.ts);
	return { channel: args.channel, ts: args.ts, permalink, warning };
}

export async function uploadFile(
	args: { channel: string; bytes: Uint8Array; filename: string; title?: string; thread_ts?: string; initial_comment?: string },
	deps: CoreDeps & { uploadBytes: UploadBytes },
): Promise<MutationResult & { fileId: string }> {
	const urlData = await deps.apiCall(
		"files.getUploadURLExternal",
		deps.token,
		{ filename: args.filename, length: args.bytes.length },
		{ retry: true, signal: deps.signal },
	);
	const uploadUrl = requireResponseString(urlData, "files.getUploadURLExternal", "upload_url");
	const fileId = requireResponseString(urlData, "files.getUploadURLExternal", "file_id");

	await deps.uploadBytes(uploadUrl, args.bytes, { signal: deps.signal });

	const fileEntry: Record<string, unknown> = { id: fileId };
	if (args.title !== undefined) fileEntry.title = args.title;

	const completeParams: Record<string, unknown> = {
		files: JSON.stringify([fileEntry]),
		channel_id: args.channel,
	};
	if (args.thread_ts !== undefined) completeParams.thread_ts = args.thread_ts;
	if (args.initial_comment !== undefined) completeParams.initial_comment = args.initial_comment;

	// One-shot per spec ("the complete call is one-shot"): retry:false, unlike getUploadURLExternal
	// above, which is idempotent and safe to retry.
	const completeData = await deps.apiCall("files.completeUploadExternal", deps.token, completeParams, {
		retry: false,
		signal: deps.signal,
	});

	// permalink is not reliably present on completeUploadExternal's response - degrade to a warning
	// like withPermalink does, rather than requireResponseString (which would hard-fail the call).
	const completedFiles = completeData.files as Record<string, unknown>[] | undefined;
	const permalink = typeof completedFiles?.[0]?.permalink === "string" ? (completedFiles[0].permalink as string) : undefined;
	const warning = permalink === undefined ? "Could not find a permalink on the completed upload response." : undefined;

	return { channel: args.channel, fileId, permalink, warning };
}

/**
 * Announce protocol (doc/specs/2026-08-29-gh-7-slack-extension.md § Announce protocol):
 * `slack_post` with `thread_body` and no `thread_ts` posts a headline plus its detail as a
 * threaded reply in one call. The headline posts exactly once - `retry: false`, because a
 * transport failure after send leaves the outcome genuinely unknown and a retry could double-post
 * a notification. The detail leg gets the transport's own single Retry-After retry (`retry:
 * true`); if it still fails, the headline is edited with a frozen "pending" marker and the detail
 * is persisted to disk so nothing is lost. Recovery (`thread_ts` supplied) never re-enters this
 * function - it is a plain threaded reply, so a second headline can never reach the transport.
 */

export const DETAIL_PENDING_MARKER = " _(detail pending)_";
export const DETAIL_INTRO = "Detail attached.";
export const DETAIL_FILENAME = "slack-detail.md";

export function linkCollapsedLength(text: string): number {
	return text.replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<[^>]+>/g, "x").length;
}

export function persistDetail(body: string): string {
	const dir = join(tmpdir(), "pi-slack");
	mkdirSync(dir, { recursive: true });
	const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
	// Same-millisecond re-invocation with identical content hashes to the same filename and
	// overwrites with byte-identical bytes - harmless, so no collision handling is needed here.
	const path = join(dir, `${Date.now()}-${hash}-detail.md`);
	writeFileSync(path, body, "utf8");
	return path;
}

function assertHeadline(text: string): void {
	if (text.length === 0) {
		throw new SlackError("invalid_headline", "text is empty; announce requires a non-empty single-line headline.");
	}
	if (/\r?\n/.test(text)) {
		throw new SlackError("invalid_headline", "text must be a single line for an announce headline; use thread_body for the detail.");
	}
	assertTextWithinLimit(text);
}

export interface AnnounceResult extends MutationResult {
	detailTs?: string;
}

async function deliverDetailUpload(
	channel: string,
	threadTs: string,
	body: string,
	deps: CoreDeps & { uploadBytes: UploadBytes },
): Promise<{ detailTs?: string }> {
	const introData = await deps.apiCall(
		"chat.postMessage",
		deps.token,
		{ channel, text: DETAIL_INTRO, thread_ts: threadTs },
		{ retry: true, signal: deps.signal },
	);
	const detailTs = typeof introData.ts === "string" ? introData.ts : undefined;
	const bytes = new TextEncoder().encode(body);
	await uploadFile({ channel, bytes, filename: DETAIL_FILENAME, thread_ts: threadTs }, deps);
	return { detailTs };
}

function capitalize(s: string): string {
	return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * postMessage's plain threaded-reply leg has no headline to mark pending, so on upload failure it
 * just persists the reply body (F2-guarded) and rethrows a structured detail_failed SlackError.
 */
async function deliverDetailUploadOrPersist(
	channel: string,
	threadTs: string,
	body: string,
	deps: CoreDeps & { uploadBytes: UploadBytes; persist?: (body: string) => string },
): Promise<{ detailTs?: string }> {
	try {
		return await deliverDetailUpload(channel, threadTs, body, deps);
	} catch (err) {
		const causeMessage = err instanceof Error ? err.message : String(err);
		const { detailPath, note } = persistOrDescribe(body, deps.persist ?? persistDetail);
		throw new SlackError(
			"detail_failed",
			`Threaded reply upload to ${channel} (thread_ts ${threadTs}) failed (${causeMessage}). ${capitalize(note)}.`,
			{ channel, thread_ts: threadTs, ...(detailPath ? { detailPath } : {}) },
		);
	}
}

/**
 * F2 guard: persistDetail (or an injected replacement) can itself throw (disk full, permissions,
 * ...). Never let that mask the primary failure - degrade to a message that states persistence
 * also failed and the (now unrecoverable) detail body's length, and omit detailPath from the
 * caller's structured error data.
 */
function persistOrDescribe(body: string, persist: (body: string) => string): { detailPath?: string; note: string } {
	try {
		const detailPath = persist(body);
		return { detailPath, note: `the full detail was saved to ${detailPath}` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			note: `persisting the ${body.length}-char detail body ALSO failed (${msg}) - the detail is unrecoverable`,
		};
	}
}

/**
 * F1: single recovery path for every detail-delivery failure (direct threaded post, oversized
 * upload, msg_too_long fallback upload) - persists the detail (F2-guarded), best-effort edits the
 * headline with the "detail pending" marker, and throws a structured detail_failed SlackError.
 * Always throws; declared Promise<never> so callers can `return recoverFromDetailFailure(...)`
 * and keep TS's definite-assignment analysis happy across the try/catch that precedes it.
 */
async function recoverFromDetailFailure(
	causeMessage: string,
	headlineText: string,
	detailBody: string,
	channel: string,
	ts: string,
	permalink: string | undefined,
	deps: CoreDeps,
	persist: (body: string) => string,
): Promise<never> {
	const { detailPath, note } = persistOrDescribe(detailBody, persist);

	let markerFailureMessage: string | undefined;
	try {
		await deps.apiCall(
			"chat.update",
			deps.token,
			{ channel, ts, text: `${headlineText}${DETAIL_PENDING_MARKER}` },
			{ retry: true, signal: deps.signal },
		);
	} catch (markerErr) {
		markerFailureMessage = markerErr instanceof Error ? markerErr.message : String(markerErr);
	}
	const markerSuffix = markerFailureMessage
		? ` The headline marker edit also failed: ${markerFailureMessage}.`
		: "";

	const data: Record<string, unknown> = { ts, channel, permalink };
	if (detailPath) data.detailPath = detailPath;

	throw new SlackError(
		"detail_failed",
		`Detail post to the thread failed (${causeMessage}); the headline was marked "detail pending" and ${note}.${markerSuffix}`,
		data,
	);
}

export async function announce(
	args: { channel: string; text: string; thread_body: string },
	deps: CoreDeps & { uploadBytes: UploadBytes; thresholdChars: number; persist?: (body: string) => string },
): Promise<AnnounceResult> {
	assertHeadline(args.text);
	const persist = deps.persist ?? persistDetail;

	let headlineData: Record<string, unknown>;
	try {
		headlineData = await deps.apiCall("chat.postMessage", deps.token, { channel: args.channel, text: args.text }, { retry: false, signal: deps.signal });
	} catch (err) {
		if (err instanceof SlackError && err.code === "transport") {
			const { detailPath, note } = persistOrDescribe(args.thread_body, persist);
			throw new SlackError(
				"outcome_unknown",
				`Headline post to ${args.channel} may or may not have reached Slack (${err.message}); check the channel before re-invoking slack_post. ${capitalize(note)}.`,
				{ channel: args.channel, ...(detailPath ? { detailPath } : {}) },
			);
		}
		throw err;
	}

	const channel = typeof headlineData.channel === "string" ? headlineData.channel : args.channel;

	// F3: chat.postMessage can return ok:true with a malformed/missing ts. That is indistinguishable
	// from "never posted" to a naive caller, inviting a duplicate re-invoke of a real channel post.
	// Treat it as "accepted, response unparseable" instead: never re-invoke, persist the detail, and
	// tell the operator to thread it manually.
	let ts: string;
	try {
		ts = requireResponseString(headlineData, "chat.postMessage", "ts");
	} catch (err) {
		const { detailPath, note } = persistOrDescribe(args.thread_body, persist);
		const detail = err instanceof Error ? err.message : String(err);
		throw new SlackError(
			"outcome_unknown",
			`Headline post to ${channel} WAS accepted by Slack (ok:true) but the response was unparseable (${detail}); do NOT re-invoke slack_post - thread the detail manually. ${capitalize(note)}.`,
			{ channel, ...(detailPath ? { detailPath } : {}) },
		);
	}

	const { permalink, warning } = await withPermalink(deps, channel, ts);

	if (linkCollapsedLength(args.thread_body) > deps.thresholdChars) {
		let detailTs: string | undefined;
		try {
			({ detailTs } = await deliverDetailUpload(channel, ts, args.thread_body, deps));
		} catch (err) {
			const causeMessage = err instanceof Error ? err.message : String(err);
			return recoverFromDetailFailure(causeMessage, args.text, args.thread_body, channel, ts, permalink, deps, persist);
		}
		return { channel, ts, permalink, warning, detailTs };
	}

	let detailData: Record<string, unknown>;
	try {
		detailData = await deps.apiCall(
			"chat.postMessage",
			deps.token,
			{ channel, text: args.thread_body, thread_ts: ts },
			{ retry: true, signal: deps.signal },
		);
	} catch (err) {
		if (err instanceof SlackError && err.code === "msg_too_long") {
			try {
				const { detailTs } = await deliverDetailUpload(channel, ts, args.thread_body, deps);
				return { channel, ts, permalink, warning, detailTs };
			} catch (uploadErr) {
				const causeMessage = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
				return recoverFromDetailFailure(causeMessage, args.text, args.thread_body, channel, ts, permalink, deps, persist);
			}
		}
		const causeMessage = err instanceof Error ? err.message : String(err);
		return recoverFromDetailFailure(causeMessage, args.text, args.thread_body, channel, ts, permalink, deps, persist);
	}

	const detailTs = requireResponseString(detailData, "chat.postMessage", "ts");
	return { channel, ts, permalink, warning, detailTs };
}

export async function postMessage(
	args: { channel: string; text?: string; blocks?: unknown[]; thread_ts?: string; thread_body?: string },
	deps: CoreDeps & { uploadBytes: UploadBytes; thresholdChars: number; persist?: (body: string) => string },
): Promise<MutationResult | AnnounceResult> {
	if (args.thread_body !== undefined && args.thread_ts === undefined) {
		return announce({ channel: args.channel, text: args.text ?? "", thread_body: args.thread_body }, deps);
	}

	if (args.thread_ts !== undefined) {
		// Caller-supplied blocks bypass upload-fallback logic entirely (spec: Announce protocol) -
		// the threshold/upload path only applies when composing plain mrkdwn from thread_body/text.
		if (args.blocks !== undefined) {
			return postPlain(
				{ channel: args.channel, text: args.thread_body ?? args.text, blocks: args.blocks, thread_ts: args.thread_ts },
				deps,
			);
		}

		const body = args.thread_body ?? args.text ?? "";
		if (linkCollapsedLength(body) > deps.thresholdChars) {
			const { detailTs } = await deliverDetailUploadOrPersist(args.channel, args.thread_ts, body, deps);
			return { channel: args.channel, ts: args.thread_ts, detailTs };
		}
		// F4: the collapsed-length gate above can still admit a link-heavy body whose raw length
		// trips postPlain's hard MAX_TEXT_LENGTH assert (client-side) or Slack's own msg_too_long
		// (server-side). This body is extension-composed detail, same as announce's detail leg, so
		// it gets the same upload fallback instead of a bare throw.
		try {
			return await postPlain({ channel: args.channel, text: body, thread_ts: args.thread_ts }, deps);
		} catch (err) {
			if (err instanceof SlackError && (err.code === "text_too_long" || err.code === "msg_too_long")) {
				const { detailTs } = await deliverDetailUploadOrPersist(args.channel, args.thread_ts, body, deps);
				return { channel: args.channel, ts: args.thread_ts, detailTs };
			}
			throw err;
		}
	}

	return postPlain({ channel: args.channel, text: args.text, blocks: args.blocks }, deps);
}
