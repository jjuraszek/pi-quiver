import { test } from "node:test";
import assert from "node:assert/strict";
import {
	coerce,
	shouldInject,
	injectSpeed,
	buildBetaHeader,
	resolveEnabled,
	FAST_MODE_BETA,
	FAST_SPEED,
} from "./fast-mode.ts";

test("coerce: boolean shorthand", () => {
	assert.deepEqual(coerce(true), { enabled: true });
	assert.deepEqual(coerce(false), { enabled: false });
});

test("coerce: object form with boolean enabled", () => {
	assert.deepEqual(coerce({ enabled: true }), { enabled: true });
	assert.deepEqual(coerce({ enabled: false }), { enabled: false });
});

test("coerce: skips undefined, non-boolean enabled, and junk", () => {
	assert.equal(coerce(undefined), undefined);
	assert.deepEqual(coerce({ enabled: "yes" }), {});
	assert.equal(coerce(42), undefined);
	assert.equal(coerce("nope"), undefined);
});

const opus = { id: "claude-opus-4-8", api: "anthropic-messages", provider: "anthropic" };

test("shouldInject: opus-4-8 anthropic passes when enabled", () => {
	assert.equal(shouldInject(true, opus), true);
	assert.equal(shouldInject(true, { ...opus, id: "claude-opus-4-8-20260901" }), true);
});

test("shouldInject: gated off cases", () => {
	assert.equal(shouldInject(false, opus), false);
	assert.equal(shouldInject(true, undefined), false);
	assert.equal(shouldInject(true, { ...opus, id: "claude-opus-4-7" }), false);
	assert.equal(shouldInject(true, { ...opus, api: "bedrock-converse-stream" }), false);
	assert.equal(shouldInject(true, { ...opus, provider: "opencode" }), false);
	assert.equal(shouldInject(true, { id: undefined, api: "anthropic-messages", provider: "anthropic" }), false);
});

test("injectSpeed: adds speed to a plain object", () => {
	assert.deepEqual(injectSpeed({ model: "x" }), { model: "x", speed: FAST_SPEED });
});

test("injectSpeed: overwrites existing speed idempotently", () => {
	assert.deepEqual(injectSpeed({ speed: "slow" }), { speed: FAST_SPEED });
});

test("injectSpeed: skips non-plain-object payloads", () => {
	assert.equal(injectSpeed(null), null);
	assert.equal(injectSpeed(undefined), undefined);
	assert.deepEqual(injectSpeed([1]), [1]);
});

test("buildBetaHeader: API-key path is fast-mode only", () => {
	assert.equal(buildBetaHeader(undefined, false), FAST_MODE_BETA);
	assert.equal(buildBetaHeader(null, false), FAST_MODE_BETA);
});

test("buildBetaHeader: OAuth path preserves identity betas", () => {
	assert.equal(
		buildBetaHeader(undefined, true),
		`claude-code-20250219,oauth-2025-04-20,${FAST_MODE_BETA}`,
	);
});

test("buildBetaHeader: merges an already-present list, dedups, trims", () => {
	assert.equal(
		buildBetaHeader("foo-beta , bar-beta", false),
		`foo-beta,bar-beta,${FAST_MODE_BETA}`,
	);
	assert.equal(buildBetaHeader(FAST_MODE_BETA, false), FAST_MODE_BETA);
	assert.equal(
		buildBetaHeader("claude-code-20250219", true),
		`claude-code-20250219,oauth-2025-04-20,${FAST_MODE_BETA}`,
	);
});

test("resolveEnabled: precedence config < flag(force-on) < live", () => {
	assert.equal(resolveEnabled({ config: false, flag: false, live: null }), false);
	assert.equal(resolveEnabled({ config: true, flag: false, live: null }), true);
	assert.equal(resolveEnabled({ config: false, flag: true, live: null }), true);
	assert.equal(resolveEnabled({ config: true, flag: true, live: false }), false);
	assert.equal(resolveEnabled({ config: false, flag: false, live: true }), true);
});

import fastMode from "./fast-mode.ts";

type Handler = (event: any, ctx: any) => any;

function harness(opts: { flag?: boolean; oauth?: boolean; model?: any; authFails?: boolean } = {}) {
	const hooks = new Map<string, Handler>();
	let status: string | undefined;
	const commands = new Map<string, any>();
	const notifications: Array<{ msg: string; level: string }> = [];
	const model = opts.model ?? { id: "claude-opus-4-8", api: "anthropic-messages", provider: "anthropic" };
	const ctx: any = {
		cwd: "/nonexistent-fast-mode-test",
		model,
		ui: {
			setStatus: (_k: string, t?: string) => { status = t; },
			notify: (msg: string, level: string) => { notifications.push({ msg, level }); },
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => opts.authFails
				? { ok: false, error: "boom" }
				: { ok: true, apiKey: opts.oauth ? "sk-ant-oat-xyz" : "sk-ant-api-xyz" },
		},
	};
	const pi: any = {
		getFlag: (n: string) => (n === "fast" ? opts.flag === true : undefined),
		registerFlag: () => {},
		registerCommand: (name: string, o: any) => commands.set(name, o),
		on: (event: string, h: Handler) => hooks.set(event, h),
	};
	fastMode(pi);
	return { hooks, commands, ctx, getStatus: () => status, getNotifications: () => notifications };
}

test("integration: disabled by default injects nothing", async () => {
	const h = harness();
	await h.hooks.get("session_start")!({}, h.ctx);
	const payload = await h.hooks.get("before_provider_request")!({ payload: { m: 1 } }, h.ctx);
	assert.equal(payload, undefined);
	const headers: Record<string, string> = {};
	await h.hooks.get("before_provider_headers")!({ headers }, h.ctx);
	assert.deepEqual(headers, {});
	assert.equal(h.getStatus(), undefined);
});

test("integration: --fast flag enables injection with speed + beta", async () => {
	const h = harness({ flag: true });
	await h.hooks.get("session_start")!({}, h.ctx);
	const payload = await h.hooks.get("before_provider_request")!({ payload: { m: 1 } }, h.ctx);
	assert.deepEqual(payload, { m: 1, speed: "fast" });
	const headers: Record<string, string> = {};
	await h.hooks.get("before_provider_headers")!({ headers }, h.ctx);
	assert.equal(headers["anthropic-beta"], FAST_MODE_BETA);
	assert.equal(h.getStatus(), "\u26a1 fast");
});

test("integration: OAuth preserves pi identity betas alongside fast-mode", async () => {
	const h = harness({ flag: true, oauth: true });
	await h.hooks.get("session_start")!({}, h.ctx);
	const headers: Record<string, string> = {};
	await h.hooks.get("before_provider_headers")!({ headers }, h.ctx);
	assert.equal(headers["anthropic-beta"], `claude-code-20250219,oauth-2025-04-20,${FAST_MODE_BETA}`);
});

test("integration: /fast on then off toggles live override over config", async () => {
	const h = harness();
	await h.hooks.get("session_start")!({}, h.ctx);
	await h.commands.get("fast")!.handler("on", h.ctx);
	const on = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.deepEqual(on, { speed: "fast" });
	await h.commands.get("fast")!.handler("off", h.ctx);
	const off = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.equal(off, undefined);
});

test("integration: non-qualifying model is untouched even when enabled", async () => {
	const h = harness({ flag: true, model: { id: "claude-opus-4-7", api: "anthropic-messages", provider: "anthropic" } });
	await h.hooks.get("session_start")!({}, h.ctx);
	const payload = await h.hooks.get("before_provider_request")!({ payload: { m: 1 } }, h.ctx);
	assert.equal(payload, undefined);
	const headers: Record<string, string> = {};
	await h.hooks.get("before_provider_headers")!({ headers }, h.ctx);
	assert.deepEqual(headers, {});
	assert.equal(h.getStatus(), "\u26a1 n/a");
});

test("integration: /fast status is read-only and prints exactly one status line", async () => {
	const h = harness({ flag: true });
	await h.hooks.get("session_start")!({}, h.ctx);
	const before = h.getNotifications().length;
	await h.commands.get("fast")!.handler("status", h.ctx);
	const notes = h.getNotifications();
	assert.equal(notes.length, before + 1);
	assert.match(notes[notes.length - 1].msg, /Fast mode is on/);
	const payload = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.deepEqual(payload, { speed: "fast" });
});

test("integration: /fast with no arg toggles with a single notify each call", async () => {
	const h = harness();
	await h.hooks.get("session_start")!({}, h.ctx);
	await h.commands.get("fast")!.handler("", h.ctx);
	let notes = h.getNotifications();
	assert.equal(notes.length, 1);
	assert.equal(notes[0].msg, "Fast mode enabled");
	const on = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.deepEqual(on, { speed: "fast" });

	await h.commands.get("fast")!.handler("", h.ctx);
	notes = h.getNotifications();
	assert.equal(notes.length, 2);
	assert.equal(notes[1].msg, "Fast mode disabled");
	const off = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.equal(off, undefined);
});

test("integration: /fast bogus warns and does not mutate state", async () => {
	const h = harness();
	await h.hooks.get("session_start")!({}, h.ctx);
	await h.commands.get("fast")!.handler("bogus", h.ctx);
	const notes = h.getNotifications();
	assert.equal(notes.length, 1);
	assert.equal(notes[0].level, "warning");
	assert.equal(notes[0].msg, "Usage: /fast [on|off|status]");
	const payload = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.equal(payload, undefined);
});

test("integration: live override survives a second session_start", async () => {
	const h = harness();
	await h.hooks.get("session_start")!({}, h.ctx);
	await h.commands.get("fast")!.handler("on", h.ctx);
	await h.hooks.get("session_start")!({}, h.ctx);
	const payload = await h.hooks.get("before_provider_request")!({ payload: {} }, h.ctx);
	assert.deepEqual(payload, { speed: "fast" });
});

test("integration: header hook skips mutation when OAuth detection fails", async () => {
	const h = harness({ flag: true, authFails: true });
	await h.hooks.get("session_start")!({}, h.ctx);
	const headers: Record<string, string> = {};
	await h.hooks.get("before_provider_headers")!({ headers }, h.ctx);
	assert.deepEqual(headers, {});
});
