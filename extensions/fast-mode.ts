/**
 * Fast mode for Claude Opus 4.8 / Opus 5.
 *
 * When enabled, injects Anthropic's fast-mode signals into every qualifying
 * Opus 4.8 / Opus 5 request on the anthropic-messages API, regardless of thinking level:
 *   - payload: { ...payload, speed: "fast" }        (before_provider_request)
 *   - header:  anthropic-beta: ...,fast-mode-2026-02-01  (before_provider_headers)
 *
 * OFF BY DEFAULT. Three control surfaces, lowest precedence first:
 *   1. settings.json  "fastMode": true | { "enabled": true }  (default false)
 *   2. --fast launch flag                                      (force-on only)
 *   3. /fast [on|off|status] live toggle                       (wins for session)
 *
 * Header coupling to pi-ai internals: pi assembles `anthropic-beta` AFTER this
 * hook and merges the hook's headers LAST, so setting the header here REPLACES
 * pi's list. Instead of guessing that list, the hook discovers it: it probes
 * pi-ai's own request assembly (dynamic import of `@earendil-works/pi-ai/compat`,
 * one of the four specifiers pi's extension loader aliases for installed
 * packages - deeper subpaths like `/api/*.lazy` do NOT resolve there) with a
 * capturing fetch - zero network, zero tokens - and unions
 * the captured betas with the fast-mode beta. Probe failure falls back to the
 * static reconstruction (OAUTH_IDENTITY_BETAS stays, demoted to fallback-only
 * seeding). Known limit: the probe context is tool-less, so tool/thinking-
 * conditional betas are captured under fixed defaults - fine while allowlisted
 * models keep forceAdaptiveThinking: true in the catalog. Probe cost: one
 * extra in-process request-assembly pass per qualifying call, no network -
 * per-request by design, no cache.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context, Model, StreamOptions, Usage } from "@earendil-works/pi-ai";
import { resolveConfig } from "../lib/extension-config.ts";

export const FAST_MODE_BETA = "fast-mode-2026-02-01";
export const FAST_SPEED = "fast";
// Loose prefixes: match dated snapshots (claude-opus-4-8-*, claude-opus-5-*).
// Opus 4.7 is out of scope (D1); a future model needs a one-line addition here.
export const FAST_MODE_MODEL_PREFIXES = ["claude-opus-4-8", "claude-opus-5"];

// Anthropic bills Opus 4.8/5 fast mode at exactly 2x standard rates; input,
// output, and cache read/write all scale by the same factor because caching
// multipliers "apply on top of fast mode pricing". Rate card:
// https://docs.claude.com/en/docs/build-with-claude/fast-mode (retrieved 2026-08-04).
export const FAST_MODE_COST_MULTIPLIER = 2;

export function scaleCost(cost: Usage["cost"], multiplier: number): Usage["cost"] {
	const input = cost.input * multiplier;
	const output = cost.output * multiplier;
	const cacheRead = cost.cacheRead * multiplier;
	const cacheWrite = cost.cacheWrite * multiplier;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export const OAUTH_IDENTITY_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
// Mirrors pi-ai's SERVER_SIDE_FALLBACK_BETA: pi puts `fallbacks` in the body
// whenever model.compat.allowedFallbackModels is non-empty, and OAuth rejects
// that body without the beta (400 "fallbacks: Extra inputs are not permitted").
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function needsFallbackBeta(model: Model<any> | undefined): boolean {
	const compat = model?.compat as { allowedFallbackModels?: unknown[] } | undefined;
	return (compat?.allowedFallbackModels?.length ?? 0) > 0;
}
const STATUS_KEY = "fast-mode";
const BETA_HEADER = "anthropic-beta";

type Config = { enabled: boolean };
const DEFAULT_CONFIG: Config = { enabled: false };

export function coerce(raw: unknown): Partial<Config> | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return { enabled: raw };
	if (raw && typeof raw === "object") {
		const o = raw as Record<string, unknown>;
		const out: Partial<Config> = {};
		if (typeof o.enabled === "boolean") out.enabled = o.enabled;
		return out;
	}
	return undefined;
}

type ModelLike = { id?: string; api?: string; provider?: string } | undefined;

export function shouldInject(enabled: boolean, model: ModelLike): boolean {
	if (!enabled || !model) return false;
	if (model.provider !== "anthropic") return false;
	if (model.api !== "anthropic-messages") return false;
	const id = model.id;
	if (typeof id !== "string") return false;
	return FAST_MODE_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

export function injectSpeed(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return payload;
	}
	return { ...(payload as Record<string, unknown>), speed: FAST_SPEED };
}

export function buildBetaHeader(
	existing: string | null | undefined,
	isOAuth: boolean,
	probedBetas: string | null = null,
	fallbackBeta = false,
): string {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (b: string): void => {
		const t = b.trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	};
	if (probedBetas !== null) probedBetas.split(",").forEach(add);
	else {
		if (isOAuth) OAUTH_IDENTITY_BETAS.forEach(add);
		if (fallbackBeta) add(SERVER_SIDE_FALLBACK_BETA);
	}
	if (typeof existing === "string") existing.split(",").forEach(add);
	add(FAST_MODE_BETA);
	return out.join(",");
}

export type ProbeAuth = { apiKey?: string; headers?: Record<string, string | null> };

// Minimal context for the beta probe: one user message, no tools, no system
// prompt. Option-dependent betas (fine-grained tool streaming) are therefore
// probed under fixed defaults - sufficient while the allowlisted models keep
// forceAdaptiveThinking: true in the catalog; a future allowlisted model with
// tool- or thinking-conditional betas would have those dropped, same as today.
const PROBE_CONTEXT: Context = { messages: [{ role: "user", content: "probe", timestamp: 0 }] };

/**
 * Discover the anthropic-beta list pi-ai would send for this model + auth by
 * driving pi-ai's own request assembly against a capturing fetch. Zero
 * network, zero tokens: the fetch records the request headers, then throws.
 * Returns the captured header value, or null on any failure - missing
 * optional peer (the guarded dynamic import() below), probe throw before
 * capture, or no header present - and the caller falls back to the static
 * reconstruction. maxRetries: 0 stops pi-ai's retry wrapper from re-driving
 * the intentionally failing probe fetch.
 */
export async function probePiBetaHeader(
	model: Model<any>,
	auth: ProbeAuth,
	fetchImpl?: (input: any, init?: any) => Promise<any>,
): Promise<string | null> {
	let captured: string | null = null;
	const capturingFetch = async (input: any, init?: any): Promise<any> => {
		const headers = init?.headers ?? input?.headers;
		let value: unknown;
		if (headers && typeof headers.get === "function") value = headers.get(BETA_HEADER);
		else if (headers && typeof headers === "object") value = (headers as Record<string, unknown>)[BETA_HEADER];
		if (typeof value === "string") captured = value;
		throw new Error("fast-mode beta probe abort");
	};
	const options: StreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		fetch: (fetchImpl ?? capturingFetch) as unknown as StreamOptions["fetch"],
		maxRetries: 0,
	};
	try {
		const { anthropicMessagesApi } = await import("@earendil-works/pi-ai/compat");
		const stream = anthropicMessagesApi().stream(model, PROBE_CONTEXT, options);
		await stream.result().catch(() => {});
	} catch {
		return captured;
	}
	return captured;
}

type State = { config: boolean; flag: boolean; live: boolean | null };

export function resolveEnabled(s: State): boolean {
	if (s.live !== null) return s.live;
	return s.flag || s.config;
}

export default function (pi: ExtensionAPI) {
	let liveOverride: boolean | null = null;
	let enabled = false;
	// Per-request snapshot. Safe as plain booleans because pi serializes provider
	// requests per session (headers -> request -> message_end, awaited in order).
	let pendingFastSpeed = false;
	let pendingFastHeader = false;

	const readFlag = (): boolean => pi.getFlag("fast") === true;

	const resolveState = (ctx: ExtensionContext): boolean => {
		const config = resolveConfig(ctx.cwd, "fastMode", DEFAULT_CONFIG, coerce, (m) => ctx.ui.notify(m, "warning")).enabled;
		enabled = resolveEnabled({ config, flag: readFlag(), live: liveOverride });
		return enabled;
	};

	const refreshStatus = (ctx: ExtensionContext): void => {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, shouldInject(enabled, ctx.model) ? "\u26a1 fast" : "\u26a1 n/a");
	};

	type ResolvedAuth = ProbeAuth & { isOAuth: boolean };

	const resolveAuth = async (ctx: ExtensionContext): Promise<ResolvedAuth | null> => {
		if (!ctx.model) return null;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) return null;
			return {
				isOAuth: typeof auth.apiKey === "string" && auth.apiKey.includes("sk-ant-oat"),
				apiKey: auth.apiKey,
				headers: auth.headers,
			};
		} catch {
			return null;
		}
	};

	pi.registerFlag("fast", {
		type: "boolean",
		description: "Enable Anthropic fast mode for Opus 4.8/5 requests this launch",
	});

	pi.on("session_start", async (_event, ctx) => {
		resolveState(ctx);
		refreshStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!shouldInject(enabled, ctx.model)) {
			pendingFastSpeed = false;
			return;
		}
		const next = injectSpeed(event.payload);
		pendingFastSpeed =
			typeof next === "object" && next !== null && (next as Record<string, unknown>).speed === FAST_SPEED;
		return next;
	});

	pi.on("before_provider_headers", async (event, ctx) => {
		if (!shouldInject(enabled, ctx.model) || !event.headers) {
			pendingFastHeader = false;
			return;
		}
		const auth = await resolveAuth(ctx);
		if (auth === null) {
			pendingFastHeader = false;
			return;
		}
		const probed = await probePiBetaHeader(ctx.model!, auth);
		event.headers[BETA_HEADER] = buildBetaHeader(
			event.headers[BETA_HEADER],
			auth.isOAuth,
			probed,
			needsFallbackBeta(ctx.model),
		);
		pendingFastHeader = true;
	});

	pi.on("message_end", (event) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const corrected = pendingFastSpeed && pendingFastHeader && !!msg.usage?.cost;
		pendingFastSpeed = false;
		pendingFastHeader = false;
		if (!corrected) return;
		return {
			message: {
				...msg,
				usage: { ...msg.usage, cost: scaleCost(msg.usage.cost, FAST_MODE_COST_MULTIPLIER) },
			},
		};
	});

	pi.registerCommand("fast", {
		description: "Manage Opus 4.8/5 fast mode: /fast [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			if (p.includes(" ")) return null;
			const matches = ["on", "off", "status"].filter((v) => v.startsWith(p));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "status") {
				const eff = liveOverride !== null ? "live toggle" : readFlag() ? "--fast flag" : "settings.json";
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model selected)";
				const applies = shouldInject(enabled, ctx.model) ? "applies to current model" : "does not apply to current model";
				ctx.ui.notify(
					`Fast mode is ${enabled ? "on" : "off"} (source: ${eff}). Model: ${model} - ${applies}.`,
					"info",
				);
				return;
			}
			if (arg === "on" || arg === "off") {
				liveOverride = arg === "on";
			} else if (arg === "") {
				liveOverride = !enabled;
			} else {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			resolveState(ctx);
			refreshStatus(ctx);
			ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
