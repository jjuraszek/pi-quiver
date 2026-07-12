/**
 * Fast mode for Claude Opus 4.8.
 *
 * When enabled, injects Anthropic's fast-mode signals into every qualifying
 * Opus 4.8 request on the anthropic-messages API, regardless of thinking level:
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
 * pi's list. For opus-4-8 pi's conditional betas (fine-grained tool streaming,
 * interleaved thinking) are never applied (eager tool streaming defaults on +
 * forceAdaptiveThinking), so the only betas to preserve are the OAuth identity
 * betas. We detect OAuth via the same token marker pi uses and rebuild the
 * exact list. If pi later adds betas for opus-4-8, revisit buildBetaHeader.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./extension-config.ts";

export const FAST_MODE_BETA = "fast-mode-2026-02-01";
export const FAST_SPEED = "fast";
// Loose prefix: matches dated snapshots (claude-opus-4-8-*). Opus 4.7 is out of
// scope (D1); a future 4.9 needs a one-line addition here.
export const FAST_MODE_MODEL_PREFIXES = ["claude-opus-4-8"];
export const OAUTH_IDENTITY_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
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

export function buildBetaHeader(existing: string | null | undefined, isOAuth: boolean): string {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (b: string): void => {
		const t = b.trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	};
	if (isOAuth) OAUTH_IDENTITY_BETAS.forEach(add);
	if (typeof existing === "string") existing.split(",").forEach(add);
	add(FAST_MODE_BETA);
	return out.join(",");
}

type State = { config: boolean; flag: boolean; live: boolean | null };

export function resolveEnabled(s: State): boolean {
	if (s.live !== null) return s.live;
	return s.flag || s.config;
}

export default function (pi: ExtensionAPI) {
	let liveOverride: boolean | null = null;
	let enabled = false;

	const readFlag = (): boolean => pi.getFlag("fast") === true;

	const resolveState = (ctx: ExtensionContext): boolean => {
		const config = resolveConfig(ctx.cwd, "fastMode", DEFAULT_CONFIG, coerce).enabled;
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

	const detectOAuth = async (ctx: ExtensionContext): Promise<boolean | null> => {
		if (!ctx.model) return null;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) return null;
			return typeof auth.apiKey === "string" && auth.apiKey.includes("sk-ant-oat");
		} catch {
			return null;
		}
	};

	pi.registerFlag("fast", {
		type: "boolean",
		description: "Enable Anthropic fast mode for Opus 4.8 requests this launch",
	});

	pi.on("session_start", async (_event, ctx) => {
		resolveState(ctx);
		refreshStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!shouldInject(enabled, ctx.model)) return;
		return injectSpeed(event.payload);
	});

	pi.on("before_provider_headers", async (event, ctx) => {
		if (!shouldInject(enabled, ctx.model)) return;
		if (!event.headers) return;
		const isOAuth = await detectOAuth(ctx);
		if (isOAuth === null) return;
		event.headers[BETA_HEADER] = buildBetaHeader(event.headers[BETA_HEADER], isOAuth);
	});

	pi.registerCommand("fast", {
		description: "Manage Opus 4.8 fast mode: /fast [on|off|status]",
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
