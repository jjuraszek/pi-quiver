import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type, createAssistantMessageEventStream, isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	defineTool,
} from "@earendil-works/pi-coding-agent";
import providerStallWatchdog, {
	MAX_TIMER_MS,
	coerce,
	createProviderStallWatchdog,
	resolveWatchdogConfig,
	validateConfig,
	type ConfigCandidate,
} from "../extensions/provider-stall-watchdog.ts";

test("coerce: boolean shorthand toggles enabled", () => {
	assert.deepEqual(coerce(true), { blockIsObject: true, enabled: true });
	assert.deepEqual(coerce(false), { blockIsObject: true, enabled: false });
});

test("coerce preserves recognized values without type filtering", () => {
	const cases: Array<{ raw: unknown; expected: ConfigCandidate | undefined }> = [
		{ raw: undefined, expected: undefined },
		{ raw: "on", expected: { blockIsObject: false } },
		{
			raw: { enabled: true, warningMs: "bad", ignored: "value" },
			expected: { blockIsObject: true, enabled: true, warningMs: "bad" },
		},
		{
			raw: { enabled: "yes", firstEventMs: 0, warningMs: null, recoveryMs: Infinity, maxStallRetries: "many" },
			expected: { blockIsObject: true, enabled: "yes", firstEventMs: 0, warningMs: null, recoveryMs: Infinity, maxStallRetries: "many" },
		},
	];

	for (const { raw, expected } of cases) assert.deepEqual(coerce(raw), expected);
});

test("validateConfig accepts a complete valid candidate", () => {
	assert.deepEqual(
		validateConfig({ blockIsObject: true, enabled: true, firstEventMs: 20_000, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 }),
		{ ok: true, config: { enabled: true, firstEventMs: 20_000, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 } },
	);
});

test("validateConfig fails closed for invalid values", () => {
	const valid = { blockIsObject: true, enabled: true, firstEventMs: 20_000, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 };
	const cases: Array<{ name: string; candidate: ConfigCandidate }> = [
		{ name: "non-object block", candidate: { ...valid, blockIsObject: false } },
		{ name: "enabled wrong type", candidate: { ...valid, enabled: "true" } },
		{ name: "zero warning", candidate: { ...valid, warningMs: 0 } },
		{ name: "negative warning", candidate: { ...valid, warningMs: -1 } },
		{ name: "fractional warning", candidate: { ...valid, warningMs: 1.5 } },
		{ name: "non-finite warning", candidate: { ...valid, warningMs: Infinity } },
		{ name: "zero recovery", candidate: { ...valid, recoveryMs: 0 } },
		{ name: "negative recovery", candidate: { ...valid, recoveryMs: -1 } },
		{ name: "fractional recovery", candidate: { ...valid, recoveryMs: 1.5 } },
		{ name: "non-finite recovery", candidate: { ...valid, recoveryMs: NaN } },
		{ name: "equal delays", candidate: { ...valid, recoveryMs: 120_000 } },
		{ name: "warning after recovery", candidate: { ...valid, warningMs: 240_000 } },
		{ name: "delay above node maximum", candidate: { ...valid, recoveryMs: MAX_TIMER_MS + 1 } },
		{ name: "missing maxStallRetries", candidate: { ...valid, maxStallRetries: undefined } },
		{ name: "negative maxStallRetries", candidate: { ...valid, maxStallRetries: -1 } },
		{ name: "fractional maxStallRetries", candidate: { ...valid, maxStallRetries: 1.5 } },
		{ name: "maxStallRetries wrong type", candidate: { ...valid, maxStallRetries: "3" } },
		{ name: "zero firstEvent", candidate: { ...valid, firstEventMs: 0 } },
		{ name: "negative firstEvent", candidate: { ...valid, firstEventMs: -1 } },
		{ name: "fractional firstEvent", candidate: { ...valid, firstEventMs: 1.5 } },
		{ name: "non-finite firstEvent", candidate: { ...valid, firstEventMs: Infinity } },
		{ name: "missing firstEventMs", candidate: { ...valid, firstEventMs: undefined } },
		{ name: "firstEvent above node maximum", candidate: { ...valid, firstEventMs: MAX_TIMER_MS + 1 } },
	];

	for (const { name, candidate } of cases) {
		const result = validateConfig(candidate);
		assert.equal(result.ok, false, name);
	}
});

test("validateConfig accepts Node's maximum timer delay", () => {
	assert.deepEqual(
		validateConfig({ blockIsObject: true, enabled: true, firstEventMs: MAX_TIMER_MS, warningMs: 1, recoveryMs: MAX_TIMER_MS, maxStallRetries: 0 }),
		{ ok: true, config: { enabled: true, firstEventMs: MAX_TIMER_MS, warningMs: 1, recoveryMs: MAX_TIMER_MS, maxStallRetries: 0 } },
	);
});

function withSettings(
	globalSettings: unknown,
	projectSettings: unknown,
	assertion: (cwd: string) => void,
): void {
	const root = mkdtempSync(join(tmpdir(), "provider-stall-watchdog-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		assertion(cwd);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
}

test("settings layers let valid project values repair invalid global shape and fields", () => {
	withSettings(
		{ providerStallWatchdog: "on" },
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		(cwd) => {
			assert.deepEqual(resolveWatchdogConfig(cwd), {
				ok: true,
				config: { enabled: true, firstEventMs: 20_000, warningMs: 10, recoveryMs: 20, maxStallRetries: 3 },
			});
		},
	);

	withSettings(
		{ providerStallWatchdog: { enabled: "bad", warningMs: "bad", recoveryMs: -1 } },
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		(cwd) => {
			assert.equal(resolveWatchdogConfig(cwd).ok, true);
		},
	);
});

test("maxStallRetries defaults to layered retry.maxRetries and explicit config wins", () => {
	withSettings(
		{ retry: { maxRetries: 5 }, providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		{},
		(cwd) => {
			assert.deepEqual(resolveWatchdogConfig(cwd), {
				ok: true,
				config: { enabled: true, firstEventMs: 20_000, warningMs: 10, recoveryMs: 20, maxStallRetries: 5 },
			});
		},
	);

	withSettings(
		{ retry: { maxRetries: 5 } },
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 2 }, retry: { maxRetries: 7 } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, true);
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 2);
		},
	);

	withSettings(
		{ retry: { maxRetries: 0 } },
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, true);
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 0, "an explicit retry.maxRetries of 0 is honoured, matching Pi's own `?? 3`");
		},
	);

	withSettings(
		{},
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, true, "maxStallRetries: 0 means detect and fail fast, never auto-retry");
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 0);
		},
	);
});

test("settings layers let invalid project values override valid global values and fail closed", () => {
	withSettings(
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		{ providerStallWatchdog: { recoveryMs: "bad" } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, false);
		},
	);
});

type Handler = (event: any, ctx: any) => unknown;

function watchdogHarness(mode = "tui", cwd = process.cwd()) {
	let now = 0;
	let nextTimer = 0;
	const timers = new Map<number, { at: number; delayMs: number; callback: () => void }>();
	const handlers = new Map<string, Handler>();
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: Array<[string, string | undefined]> = [];
	let aborts = 0;
	let controller = new AbortController();
	const ctx = {
		mode,
		cwd,
		hasUI: mode === "tui" || mode === "rpc",
		signal: controller.signal,
		ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]), notify: (text: string, type?: string) => notifications.push([text, type]) },
		abort: () => { aborts += 1; controller.abort(); },
	};
	createProviderStallWatchdog({
		now: () => now,
		setTimeout: (callback, delayMs) => {
			const handle = ++nextTimer;
			timers.set(handle, { at: now + delayMs, delayMs, callback });
			return handle;
		},
		clearTimeout: (handle) => { timers.delete(handle as number); },
	})({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
	return {
		emit: (event: string, payload: Record<string, unknown> = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx),
		advance: (ms: number) => { now += ms; for (;;) { const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); due[1].callback(); } },
		newController: () => {
			const previous = controller;
			controller = new AbortController();
			ctx.signal = controller.signal;
			return previous;
		},
		abortCurrentSignal: () => controller.abort(),
		get now() { return now; },
		get aborts() { return aborts; },
		timers, statuses, notifications,
	};
}

function semantic(type: "text_delta" | "thinking_delta" | "toolcall_delta", delta: string) {
	return { message: { role: "assistant" }, assistantMessageEvent: { type, delta } };
}

function messageStart(role: "assistant" | "user" | "toolResult" = "assistant") {
	return { message: { role } };
}

const ABORT_STUCK_NOTICE = "The stalled request did not stop within 10s of being aborted; the provider connection is unresponsive. No automatic retry will run - the turn will not end until the HTTP idle timeout expires.";

test("semantic deltas reset the mid-stream silence clock", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 120_000, recoveryMs: 240_000 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		assert.equal(h.timers.size, 2);
		h.advance(119_999);
		h.emit("message_update", semantic("text_delta", " "));
		h.advance(120_000);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 2m; aborting and asking Pi to retry in 2m (Esc aborts now)", "warning"]);
		assert.equal(h.statuses.length, 0, "the warning is a main-window notification, not a status line entry");
	});
});

test("warning status formats configured warning and remaining recovery thresholds", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 30_000, recoveryMs: 90_000 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.advance(30_000);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 30s; aborting and asking Pi to retry in 1m (Esc aborts now)", "warning"]);
	});
});

function withEnabledWatchdog(assertion: (cwd: string) => void): void {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } }, assertion);
}

test("every mode arms the first-event deadline with no preceding input or before_agent_start; only TUI arms mid-stream", () => {
	withEnabledWatchdog((cwd) => {
		for (const mode of ["tui", "json", "rpc", "print"]) {
			const h = watchdogHarness(mode, cwd);
			h.emit("before_provider_request");
			assert.equal(h.timers.size, 1, `${mode} arms the first-event deadline with no preceding input or before_agent_start`);
			h.emit("message_start", messageStart());
			assert.equal(h.timers.size, mode === "tui" ? 2 : 0, `${mode} arms the mid-stream pair only in tui`);
		}
	});
});

test("every request gets a generation and only non-empty semantic deltas reset deadlines", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		const first = [...h.timers.keys()];
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		assert.equal(h.timers.size, 2);
		assert.equal(first.some((handle) => h.timers.has(handle)), false, "new generation clears old deadlines");
		for (const update of [semantic("text_delta", ""), { message: { role: "assistant" }, assistantMessageEvent: { type: "text_start" } }]) h.emit("message_update", update);
		h.advance(10);
		assert.equal(h.notifications.filter(([, type]) => type === "warning").length, 1, "empty and non-semantic updates do not reset");
		for (const update of [semantic("text_delta", "\t"), semantic("thinking_delta", "\u00a0"), semantic("toolcall_delta", "\u200b")]) {
			h.emit("message_update", update); h.advance(9); assert.equal(h.timers.size, 2);
		}
		h.advance(1);
		assert.equal(h.timers.size, 1, "the reset warning fired while its recovery deadline remains armed");
	});
});

test("early current warning callback reschedules for the positive remaining silence", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		const [warningHandle, warning] = [...h.timers.entries()][0];
		h.advance(1);
		h.timers.delete(warningHandle);
		warning.callback();
		const replacement = [...h.timers.values()].find((timer) => timer.at === h.now + 9);
		assert.equal(h.notifications.length, 0, "early warning does not notify");
		assert.equal(h.aborts, 0, "early warning does not abort");
		assert.equal(h.timers.size, 2, "warning replacement and recovery remain armed");
		assert.equal(replacement?.delayMs, 9, "replacement uses the positive remaining delay");
		assert.equal(replacement?.at, h.now + 9);
	});
});

test("agent_end clears an armed warning and disarms its captured callbacks", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		const callbacks = [...h.timers.values()].map((timer) => timer.callback);
		h.advance(10);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 10ms; aborting and asking Pi to retry in 10ms (Esc aborts now)", "warning"]);
		h.emit("agent_end");
		assert.equal(h.timers.size, 0, "agent_end clears watchdog timers");
		const notifications = [...h.notifications];
		for (const callback of callbacks) callback();
		assert.deepEqual(h.notifications, notifications, "captured callbacks cannot notify again");
		assert.equal(h.aborts, 0, "captured callbacks cannot abort after agent_end");
		assert.equal(h.timers.size, 0, "captured callbacks cannot reschedule after agent_end");
	});
});

test("semantic progress permits a later warning, and terminal events clean only assistant requests", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 100 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(10);
		h.emit("message_update", semantic("text_delta", "x"));
		assert.equal(h.notifications.filter(([, type]) => type === "warning").length, 1);
		h.advance(10);
		assert.equal(h.timers.size, 1, "semantic progress permits a later warning while recovery remains armed");
		h.emit("message_end", { message: { role: "user" } });
		assert.equal(h.timers.size, 1);
		h.emit("message_end", { message: { role: "toolResult" } });
		assert.equal(h.timers.size, 1);
		h.emit("message_end", { message: { role: "assistant" } });
		assert.equal(h.timers.size, 0);
	});
});

// Pins the invariant that makes the unconditional `clearTimers(); schedule(ctx);` in message_update
// load-bearing: a fired warning timer is gone, so only a full re-arm can produce a second warning.
test("a second silence window after semantic progress emits a second warning notification", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 100 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.advance(10);
		const warnings = () => h.notifications.filter(([, type]) => type === "warning");
		assert.deepEqual(warnings(), [["No model progress for 10ms; aborting and asking Pi to retry in 90ms (Esc aborts now)", "warning"]]);
		h.emit("message_update", semantic("text_delta", "x"));
		h.advance(10);
		assert.deepEqual(
			warnings(),
			Array(2).fill(["No model progress for 10ms; aborting and asking Pi to retry in 90ms (Esc aborts now)", "warning"]),
			"the second silence window emits its own warning notification, not just an armed timer",
		);
		assert.equal(h.aborts, 0, "the second warning does not abort while recovery budget remains");
	});
});

test("removed old signal listeners cannot affect a new generation", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		const [warning, recovery] = [...h.timers.values()].map((timer) => timer.callback);
		const oldController = h.newController();
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		warning(); recovery(); oldController.abort();
		assert.equal(h.notifications.length, 0);
		assert.equal(h.timers.size, 2, "stale timer callbacks and removed old listeners leave the new generation armed");
	});
});

test("aborting the active signal during recovery clears the warning and disarms captured callbacks", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		const [warning, recovery] = [...h.timers.values()].map((timer) => timer.callback);
		h.advance(10);
		assert.equal(h.timers.size, 1, "recovery remains armed after the warning");
		h.abortCurrentSignal();
		assert.equal(h.timers.size, 0, "active signal abort clears both watchdog deadlines");
		const notifications = [...h.notifications];
		warning(); recovery();
		assert.deepEqual(h.notifications, notifications, "captured callbacks cannot notify after active abort");
		assert.equal(h.timers.size, 0, "captured callbacks cannot rearm after active abort");
	});
});

test("shutdown invalidates captured timer callbacks", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		const [warning, recovery] = [...h.timers.values()].map((timer) => timer.callback);
		h.emit("session_shutdown");
		warning(); recovery();
		assert.equal(h.notifications.length, 0);
		assert.equal(h.timers.size, 0, "stale callbacks cannot reschedule after shutdown");
	});
});

test("shutdown clears invalid-config disablement for the next session", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			h.emit("before_provider_request");
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } }));
			h.emit("session_shutdown");
			h.emit("before_provider_request");
			h.emit("message_start", messageStart());
		} finally {
			console.warn = originalWarn;
		}
		assert.equal(h.timers.size, 2);
	});
});

test("config is resolved once per session and re-read after shutdown", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		const originalWarn = console.warn; let warnings = 0; console.warn = () => { warnings += 1; };
		try {
			h.emit("before_provider_request");
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } }));
			h.emit("before_provider_request");
		} finally { console.warn = originalWarn; }
		assert.equal(warnings, 0, "settings.json is not re-read mid-session");
		assert.equal(h.notifications.length, 0, "a mid-session re-read would report the now-invalid config");
		assert.equal(h.timers.size, 1, "the memoized config is reused mid-session");
		h.emit("session_shutdown");
		h.emit("before_provider_request");
		assert.equal(h.timers.size, 0, "shutdown drops the memoized config and the rewritten value takes effect");
		assert.equal(h.notifications.length, 1, "the post-shutdown re-read reports the now-invalid config");
	});
});

test("first recovery marks ownership, consumes retry, notifies, then synchronously aborts", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.advance(20);
		assert.equal(h.aborts, 1);
		assert.deepEqual(h.notifications, [
			["No model progress for 10ms; aborting and asking Pi to retry in 10ms (Esc aborts now)", "warning"],
			["No model progress for 20ms; aborting now. Pi will retry (1/3) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.", undefined],
		]);
		const message = { role: "assistant", stopReason: "aborted", preserved: { value: true } };
		assert.deepEqual(h.emit("message_end", { message }), { message: { ...message, stopReason: "error", errorMessage: "Provider semantic timeout after 20 ms without progress" } });
	});
});

test("default recovery notice formats elapsed consistently", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 120_000, recoveryMs: 240_000 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(240_000);
		assert.deepEqual(h.notifications, [
			["No model progress for 2m; aborting and asking Pi to retry in 2m (Esc aborts now)", "warning"],
			["No model progress for 4m; aborting now. Pi will retry (1/3) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.", undefined],
		]);
	});
});

test("only watchdog-owned first abort is rewritten; external abort disarms delayed message_end", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.abortCurrentSignal();
		const external = { role: "assistant", stopReason: "aborted", id: "external" };
		assert.equal(h.emit("message_end", { message: external }), undefined);
		assert.equal(h.aborts, 0);
	});
});

test("watchdog-first ownership survives a later Esc and an exhausted budget stops converting", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 1 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20); h.abortCurrentSignal();
		assert.equal((h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }) as any)?.message.stopReason, "error");
		h.newController(); h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		assert.equal(h.aborts, 2);
		assert.deepEqual(h.notifications.at(-1), ["Stall retry budget (1) exhausted; aborting without another automatic retry. Submit the message again manually.", undefined]);
		assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined);
	});
});

test("consecutive stalls convert until maxStallRetries is exhausted", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 2 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		for (const expected of ["(1/2)", "(2/2)"]) {
			h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
			assert.ok(h.notifications.at(-1)![0].includes(expected), `recovery notice reports ${expected}`);
			assert.equal((h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }) as any)?.message.stopReason, "error");
			h.newController();
		}
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		assert.deepEqual(h.notifications.at(-1), ["Stall retry budget (2) exhausted; aborting without another automatic retry. Submit the message again manually.", undefined]);
		assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined);
		assert.equal(h.aborts, 3);
	});
});

test("a successful assistant turn resets the stall retry counter", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		h.newController(); h.emit("before_provider_request"); h.emit("message_start", messageStart());
		h.emit("message_update", semantic("text_delta", "x"));
		h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
		h.newController(); h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 20ms; aborting now. Pi will retry (1/3) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.", undefined]);
	});
});

test("settlement only resets retry and reports an unavailable continuation", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }); h.emit("agent_settled");
		assert.deepEqual(h.notifications.at(-1), ["The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.", undefined]);
		h.newController(); h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		assert.equal(h.aborts, 2);
	});
});

test("invalid config disables once without timers", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } }, (cwd) => {
		for (const [mode, expectedWarnings] of [["tui", 0], ["print", 1]] as const) {
			const h = watchdogHarness(mode, cwd);
			const originalWarn = console.warn; let warnings = 0; console.warn = () => { warnings += 1; };
			try {
				h.emit("before_provider_request");
				h.emit("before_provider_request");
			} finally { console.warn = originalWarn; }
			assert.equal(warnings, expectedWarnings, `${mode} duplicates the report on stderr only when no UI is bound`);
			// The harness records every notify; a real headless run has pi's no-op UI context bound here.
			assert.equal(h.notifications.length, 1, `${mode} reports the config error exactly once per session`);
			assert.equal(h.timers.size, 0);
		}
	});
});

type RuntimeScript = "tool" | "stall" | "slow" | "success";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

function runtimeAssistant(content: any[], stopReason: "stop" | "toolUse" = "stop") {
	return { role: "assistant" as const, content, api: "watchdog-test", provider: "watchdog-test", model: "watchdog-test-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
}

async function waitBounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise, new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000); })]); }
	finally { if (timeout) clearTimeout(timeout); }
}

async function runtimeWatchdogHarness(scripts: RuntimeScript[], retryEnabled = true, opts: { maxStallRetries?: number; maxRetries?: number; mode?: "tui" | "print"; withUI?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "provider-stall-watchdog-runtime-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const contexts: any[] = []; const starts = scripts.map(() => deferred<void>()); const editor: string[] = []; const notifications: string[] = []; let toolCalls = 0;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ providerStallWatchdog: { enabled: true, firstEventMs: 20, warningMs: 10, recoveryMs: 20, ...(opts.maxStallRetries === undefined ? {} : { maxStallRetries: opts.maxStallRetries }) } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerProvider("watchdog-test", { apiKey: "test-key", baseUrl: "https://watchdog.test", api: "watchdog-test", models: [{ id: "watchdog-test-model", name: "Watchdog test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, maxTokens: 1_024 }], streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream(); const index = contexts.push(context) - 1;
			void (async () => {
				await options?.onPayload?.({ request: index }, model); await options?.onResponse?.({ status: 200, headers: {} }, model); starts[index].resolve();
				const aborted = () => stream.push({ type: "error", reason: "aborted", error: { ...runtimeAssistant([]), stopReason: "aborted", errorMessage: "aborted" } });
				if (options?.signal?.aborted) return aborted();
				if (scripts[index] === "stall") { options?.signal?.addEventListener("abort", aborted, { once: true }); return; }
				if (scripts[index] === "slow") { stream.push({ type: "start", partial: runtimeAssistant([]) }); options?.signal?.addEventListener("abort", aborted, { once: true }); return; }
				const message = scripts[index] === "tool" ? runtimeAssistant([{ type: "toolCall", id: "watchdog-tool-call", name: "watchdog_tool", arguments: {} }], "toolUse") : runtimeAssistant([{ type: "text", text: "recovered" }]);
				stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message });
			})();
			return stream;
		} });
		const model = runtime.getModel("watchdog-test", "watchdog-test-model")!;
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: retryEnabled, maxRetries: opts.maxRetries ?? 1, baseDelayMs: 1 } });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [providerStallWatchdog] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), customTools: [defineTool({ name: "watchdog_tool", label: "watchdog tool", description: "test", parameters: Type.Object({}), execute: async () => { toolCalls += 1; return { content: [{ type: "text", text: "tool complete" }], details: undefined }; } })] });
		// InteractiveMode editor restoration is upstream Pi behavior; this pins the watchdog's public abort binding.
		const withUI = opts.withUI !== false;
		await session.bindExtensions({ ...(withUI ? { uiContext: { notify: (text: string) => notifications.push(text), setStatus: () => {}, setEditorText: (text: string) => editor.push(text) } as any } : {}), mode: opts.mode ?? "tui", abortHandler: () => { const queued = session.clearQueue(); for (const text of [...queued.steering, ...queued.followUp]) editor.push(text); void session.abort(); } });
		return { session, contexts, starts, editor, notifications, get toolCalls() { return toolCalls; }, dispose: () => { session.dispose(); if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(root, { recursive: true, force: true }); } };
	} catch (error) { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(root, { recursive: true, force: true }); throw error; }
}

test("installed runtime watchdog uses ExtensionContext.abort to clear queued follow-up through bound abortHandler and retry", async () => {
	const h = await runtimeWatchdogHarness(["tool", "stall", "success"]);
	try {
		const run = h.session.prompt("start"); await waitBounded(h.starts[1].promise, "stalled request start"); await h.session.followUp("keep this out of retry"); await waitBounded(run, "recovered run");
		assert.equal(h.contexts.length, 3); assert.equal(h.toolCalls, 1, "watchdog_tool handler ran exactly once"); assert.deepEqual(h.editor, ["keep this out of retry"]);
		for (const context of h.contexts) assert.equal(context.messages.filter((message: any) => message.role === "user").length, 1);
		for (const index of [1, 2]) {
			const toolResults = h.contexts[index].messages.filter((message: any) => message.role === "toolResult");
			assert.equal(toolResults.length, 1, `context ${index} has one completed tool result`);
			assert.equal(toolResults[0].toolCallId, "watchdog-tool-call", `context ${index} completed the watchdog tool call`);
		}
		assert.equal(h.session.messages.at(-1)?.role, "assistant"); assert.equal((h.session.messages.at(-1) as any).stopReason, "stop");
	} finally { h.dispose(); }
});

test("installed runtime aborts a stalled request past the stall budget without recursive retry", async () => {
	const h = await runtimeWatchdogHarness(["stall", "stall"], true, { maxStallRetries: 1 });
	try { await waitBounded(h.session.prompt("start"), "second stalled run"); assert.equal(h.contexts.length, 2); assert.equal((h.session.messages.at(-1) as any).stopReason, "aborted"); assert.equal(h.notifications.at(-1), "Provider sent no response for 20ms and the stall-retry budget is spent; the request was stopped."); }
	finally { h.dispose(); }
});

test("installed runtime retries multiple consecutive stalls within the stall budget", async () => {
	const h = await runtimeWatchdogHarness(["stall", "stall", "success"], true, { maxStallRetries: 2, maxRetries: 2 });
	try {
		await waitBounded(h.session.prompt("start"), "multi-stall run");
		assert.equal(h.contexts.length, 3);
		assert.equal(h.session.messages.at(-1)?.role, "assistant");
		assert.equal((h.session.messages.at(-1) as any).stopReason, "stop");
	} finally { h.dispose(); }
});

test("installed runtime degrades without a continuation when retry is disabled", async () => {
	const h = await runtimeWatchdogHarness(["stall"], false);
	try { await waitBounded(h.session.prompt("start"), "retry-disabled stalled run"); assert.equal(h.contexts.length, 1); assert.equal((h.session.messages.at(-1) as any).stopReason, "error"); assert.equal(h.notifications.at(-1), "The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually."); }
	finally { h.dispose(); }
});

test("installed runtime converts a request that never emits a stream event", async () => {
	const h = await runtimeWatchdogHarness(["stall", "success"]);
	try {
		await waitBounded(h.session.prompt("start"), "no-first-event run");
		assert.equal(h.contexts.length, 2, "the unresponsive request was retried");
		assert.equal((h.session.messages.at(-1) as any).stopReason, "stop");
		assert.equal(h.notifications.at(0), "Provider sent no response for 20ms; stopping and retrying the request.");
	} finally { h.dispose(); }
});

test("installed runtime still converts a mid-stream stall after the first event", async () => {
	const h = await runtimeWatchdogHarness(["slow", "success"]);
	try {
		await waitBounded(h.session.prompt("start"), "mid-stream stall run");
		assert.equal(h.contexts.length, 2);
		assert.equal((h.session.messages.at(-1) as any).stopReason, "stop");
		// Pins the recovery notice specifically (retry budget + "returned to the editor"), not the warning
		// notice, which also starts with "No model progress for" - the recovery notice is always the last one
		// to fire. The elapsed-ms figure is left as \d+ because it is measured against real timers and jitters
		// a millisecond or two past the configured recoveryMs.
		assert.match(
			h.notifications.at(-1)!,
			/^No model progress for \d+ms; aborting now\. Pi will retry \(1\/3\) if retry is enabled and capacity remains\. Pending follow-ups are returned to the editor\.$/,
			"the mid-stream recovery tier produced its notice",
		);
	} finally { h.dispose(); }
});

test("installed runtime recovers an unresponsive request in headless print mode", async () => {
	const h = await runtimeWatchdogHarness(["stall", "success"], true, { mode: "print", withUI: false });
	const warnings: string[] = [];
	const logs: string[] = [];
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = (text: string) => { warnings.push(text); };
	console.log = (text: string) => { logs.push(text); };
	try {
		await waitBounded(h.session.prompt("start"), "headless no-first-event run");
		assert.equal(h.contexts.length, 2, "headless runs retry the unresponsive request");
		assert.equal((h.session.messages.at(-1) as any).stopReason, "stop");
		assert.ok(warnings.includes("Provider sent no response for 20ms; stopping and retrying the request."), "headless diagnostics go to stderr");
		// json mode multiplexes its protocol on stdout; a stray console.log would corrupt it.
		assert.deepEqual(logs, [], "headless diagnostics never reach stdout");
	} finally { console.warn = originalWarn; console.log = originalLog; h.dispose(); }
});

test("installed runtime arms for an extension-origin turn that never emits before_agent_start", async () => {
	const h = await runtimeWatchdogHarness(["stall", "success"]);
	try {
		await waitBounded(
			h.session.sendCustomMessage({ customType: "watchdog-origin", content: "start", display: false }, { triggerTurn: true }),
			"triggerTurn run",
		);
		assert.equal(h.contexts.length, 2, "the extension-origin turn was watched and retried");
	} finally { h.dispose(); }
});

test("a request with no assistant message_start aborts at firstEventMs", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		assert.equal(h.timers.size, 1, "only the first-event deadline is armed before the first stream event");
		h.advance(5);
		assert.equal(h.aborts, 1);
		assert.deepEqual(h.notifications, [["Provider sent no response for 5ms; stopping and retrying the request.", undefined]]);
		const message = { role: "assistant", stopReason: "aborted" };
		assert.deepEqual(h.emit("message_end", { message }), { message: { ...message, stopReason: "error", errorMessage: "Provider first-event timeout after 5 ms without a stream event" } });
	});
});

test("an assistant message_start swaps the first-event deadline for the mid-stream pair, permanently", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		assert.equal(h.timers.size, 2, "warning and recovery replace the first-event deadline");
		h.advance(5);
		assert.equal(h.aborts, 0, "the cleared first-event deadline cannot fire");
		h.emit("message_start", messageStart());
		assert.equal(h.timers.size, 2, "a second start in the same request is a no-op");
		h.advance(5);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 10ms; aborting and asking Pi to retry in 10ms (Esc aborts now)", "warning"]);
	});
});

test("a non-assistant message_start leaves the first-event deadline armed", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart("user"));
		h.emit("message_start", messageStart("toolResult"));
		assert.equal(h.timers.size, 1);
		h.advance(5);
		assert.equal(h.aborts, 1);
	});
});

test("an early first-event callback reschedules for the remaining silence", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 10, warningMs: 20, recoveryMs: 30 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		const [handle, timer] = [...h.timers.entries()][0];
		h.advance(1);
		h.timers.delete(handle);
		timer.callback();
		const replacement = [...h.timers.values()][0];
		assert.equal(h.aborts, 0, "early first-event callback does not abort");
		assert.equal(replacement?.delayMs, 9, "replacement uses the positive remaining delay");
	});
});

test("a later request in the same run re-arms the first-event deadline after an earlier stream started", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.emit("before_provider_request");
		assert.equal(h.timers.size, 1, "the post-tool request arms the first-event deadline again");
		h.advance(5);
		assert.equal(h.aborts, 1, "firstEventSeen is per request, not per run");
	});
});

test("deltas before the first assistant message_start do not reset the first-event deadline", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 10, warningMs: 20, recoveryMs: 30 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(9);
		h.emit("message_update", semantic("text_delta", "x"));
		h.advance(1);
		assert.equal(h.aborts, 1, "the first-event deadline is only cleared by message_start");
	});
});

test("an abort that never yields message_end escalates after the grace period", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		assert.equal(h.aborts, 1);
		assert.equal(h.timers.size, 1, "the abort grace deadline is armed");
		h.advance(10_000);
		assert.deepEqual(h.notifications.at(-1), [ABORT_STUCK_NOTICE, "error"]);
		assert.equal(h.timers.size, 0);
		h.advance(60_000);
		assert.equal(h.notifications.length, 2, "the escalation fires once and rearms nothing");
		const message = { role: "assistant", stopReason: "aborted" };
		assert.deepEqual(
			h.emit("message_end", { message }),
			{ message: { ...message, stopReason: "error", errorMessage: "Provider first-event timeout after 5 ms without a stream event" } },
			"a late message_end still converts, so the stall retry the abort spent buys the retry Pi now runs",
		);
	});
});

test("post-abort stream events push the abort grace deadline out without re-entering the stall cycle", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		assert.equal(h.aborts, 1);
		for (let tick = 0; tick < 5; tick += 1) {
			h.advance(9_000);
			h.emit("message_start", messageStart());
			h.emit("message_update", semantic("text_delta", "x"));
			assert.equal(h.timers.size, 1, "re-arming replaces the grace deadline instead of orphaning handles");
		}
		assert.equal(h.aborts, 1, "the already-aborted generation is not aborted a second time");
		assert.deepEqual(h.notifications, [["Provider sent no response for 5ms; stopping and retrying the request.", undefined]], "a stream that keeps producing bytes past the grace period raises no failure notice");
	});
});

test("a post-abort stream event followed by silence escalates one grace period later", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		h.advance(5_000);
		h.emit("message_update", semantic("text_delta", "x"));
		h.advance(9_999);
		assert.equal(h.notifications.length, 1, "the straggler event pushed the deadline out");
		h.advance(1);
		assert.deepEqual(h.notifications.at(-1), [ABORT_STUCK_NOTICE, "error"], "a wedge after the straggler still escalates");
		h.advance(60_000);
		assert.equal(h.notifications.length, 2, "the escalation fires exactly once");
		assert.equal(h.aborts, 1);
	});
});

test("a non-assistant message_start after the abort does not count as connection liveness", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		h.advance(5_000);
		h.emit("message_start", messageStart("toolResult"));
		h.advance(5_000);
		assert.deepEqual(h.notifications.at(-1), [ABORT_STUCK_NOTICE, "error"], "a user or toolResult message_start is not provider traffic and must not push the deadline out");
	});
});

test("an aborted final message's own message_start does not stop its message_end from converting", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		assert.equal(h.aborts, 1);
		// F2b: pi's agent loop emits an assistant message_start for the final error/aborted message when no
		// partial was added. It belongs to the already-aborted generation, so it re-arms the guard instead of
		// entering phase 2, and its own message_end follows an instant later.
		h.emit("message_start", messageStart());
		assert.equal(h.timers.size, 1, "the failure message's own start re-arms the grace deadline, it does not arm phase 2");
		const message = { role: "assistant", stopReason: "aborted" };
		assert.deepEqual(
			h.emit("message_end", { message }),
			{ message: { ...message, stopReason: "error", errorMessage: "Provider first-event timeout after 5 ms without a stream event" } },
		);
		assert.equal(h.timers.size, 0, "the converted turn leaves nothing armed");
		h.advance(60_000);
		assert.deepEqual(h.notifications, [["Provider sent no response for 5ms; stopping and retrying the request.", undefined]], "nothing escalates after the conversion");
	});
});

test("the abort grace deadline is armed on the exhausted path and cleared by message_end", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		assert.deepEqual(h.notifications, [["Provider sent no response for 5ms and the stall-retry budget is spent; the request was stopped.", undefined]]);
		assert.equal(h.timers.size, 1, "the exhausted path also arms the grace deadline");
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		assert.equal(h.timers.size, 0, "message_end clears the grace deadline");
		h.advance(10_000);
		assert.equal(h.notifications.length, 1, "a cleared grace deadline cannot escalate");
	});
});

test("an exhausted-path abort that never yields message_end escalates after the grace period", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(5);
		assert.equal(h.aborts, 1);
		h.advance(10_000);
		assert.deepEqual(h.notifications.at(-1), [ABORT_STUCK_NOTICE, "error"], "the exhausted path escalates too, it is not left with the full original exposure");
		assert.equal(h.timers.size, 0, "the escalation tears its own deadline down");
		h.advance(60_000);
		assert.equal(h.notifications.length, 2, "the escalation fires once and rearms nothing");
		assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined, "no conversion was pending, so the notice and the teardown are the whole effect");
	});
});

test("an rpc abort reaches the bound notify and stays off stderr", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } }, (cwd) => {
		const h = watchdogHarness("rpc", cwd);
		const originalWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (text: string) => { warnings.push(text); };
		try {
			h.emit("before_provider_request");
			h.advance(5);
		} finally { console.warn = originalWarn; }
		assert.equal(h.aborts, 1);
		assert.deepEqual(h.notifications, [["Provider sent no response for 5ms; stopping and retrying the request.", undefined]], "rpc binds a real notify, so the notice is delivered");
		assert.deepEqual(warnings, [], "hasUI is true in rpc; a stderr copy would double-report");
	});
});

test("both synthetic timeout errors satisfy Pi's own retry predicate", () => {
	for (const errorMessage of [
		"Provider first-event timeout after 20000 ms without a stream event",
		"Provider semantic timeout after 240000 ms without progress",
	]) {
		assert.equal(
			isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage } as never),
			true,
			`Pi must classify "${errorMessage}" as retryable, or the watchdog's conversion degrades to manual resubmission`,
		);
	}
});
