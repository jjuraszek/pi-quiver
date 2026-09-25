import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type, createAssistantMessageEventStream, isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";
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
	redriveDelayMs,
	resolveRetrySettings,
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
	assertion: (cwd: string) => void | Promise<void>,
): Promise<void> | void {
	const root = mkdtempSync(join(tmpdir(), "provider-stall-watchdog-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const cleanup = () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	};
	try {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const result = assertion(cwd);
		if (result instanceof Promise) return result.finally(cleanup);
		cleanup();
	} catch (error) {
		cleanup();
		throw error;
	}
}

test("settings layers let valid project values repair invalid global shape and fields", () => {
	withSettings(
		{ quiver: { providerStallWatchdog: "on" } },
		{ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } },
		(cwd) => {
			assert.deepEqual(resolveWatchdogConfig(cwd), {
				ok: true,
				config: { enabled: true, firstEventMs: 20_000, warningMs: 10, recoveryMs: 20, maxStallRetries: 3 },
			});
		},
	);

	withSettings(
		{ quiver: { providerStallWatchdog: { enabled: "bad", warningMs: "bad", recoveryMs: -1 } } },
		{ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } },
		(cwd) => {
			assert.equal(resolveWatchdogConfig(cwd).ok, true);
		},
	);
});

test("maxStallRetries defaults to layered retry.maxRetries and explicit config wins", () => {
	withSettings(
		{ retry: { maxRetries: 5 }, quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } },
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
		{ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 2 } }, retry: { maxRetries: 7 } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, true);
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 2);
		},
	);

	withSettings(
		{ retry: { maxRetries: 0 } },
		{ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, true);
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 0, "an explicit retry.maxRetries of 0 is honoured, matching Pi's own `?? 3`");
		},
	);

	withSettings(
		{},
		{ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, true, "maxStallRetries: 0 means detect and fail fast, never auto-retry");
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 0);
		},
	);
});

test("resolveRetrySettings layers retry settings with defaults and validation", () => {
	withSettings({}, {}, (cwd) => {
		assert.deepEqual(resolveRetrySettings(cwd), { enabled: true, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 });
	});
	withSettings(
		{ retry: { enabled: false, baseDelayMs: 10, maxAgentDelayMs: 40 } },
		{ retry: { baseDelayMs: 5 } },
		(cwd) => {
			assert.deepEqual(resolveRetrySettings(cwd), { enabled: false, baseDelayMs: 5, maxAgentDelayMs: 40 });
		},
	);
	withSettings(
		{ retry: { enabled: "no", baseDelayMs: -1, maxAgentDelayMs: 1.5 } },
		{ retry: "bad" },
		(cwd) => {
			assert.deepEqual(resolveRetrySettings(cwd), { enabled: true, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 });
		},
	);
});

test("redriveDelayMs matches pi's retry backoff and clamps to Node's timer ceiling", () => {
	const settings = { enabled: true, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 };
	for (const attempt of [0, 1, 2, 3, 6, 40]) {
		assert.equal(redriveDelayMs(settings, attempt), retryDelayMs(settings, attempt), `attempt ${attempt}`);
	}
	assert.equal(redriveDelayMs({ baseDelayMs: 1, maxAgentDelayMs: MAX_TIMER_MS + 5 }, 40), MAX_TIMER_MS);
});

test("settings layers let invalid project values override valid global values and fail closed", () => {
	withSettings(
		{ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } },
		{ quiver: { providerStallWatchdog: { recoveryMs: "bad" } } },
		(cwd) => {
			const result = resolveWatchdogConfig(cwd);
			assert.equal(result.ok, false);
		},
	);
});

test("unknown watchdog field is reported by the settings lint and the default firstEventMs still applies", () => {
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, timeoutMs: 720_000 } } }, (cwd) => {
		const warnings: string[] = [];
		assert.deepEqual(resolveWatchdogConfig(cwd, (m) => warnings.push(m)), {
			ok: true,
			config: { enabled: true, firstEventMs: 20_000, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 },
		});
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0].includes(`"quiver.providerStallWatchdog.timeoutMs" - unknown; accepted: enabled, firstEventMs, warningMs, recoveryMs, maxStallRetries`));
	});
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
	const sent: Array<[any, any]> = [];
	const sendControl = { fail: false };
	let terminalInput: ((data: string) => any) | undefined;
	let controller = new AbortController();
	const ctx = {
		mode,
		cwd,
		hasUI: mode === "tui" || mode === "rpc",
		signal: controller.signal,
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
			onTerminalInput: (handler: (data: string) => any) => {
				terminalInput = handler;
				return () => { terminalInput = undefined; };
			},
			notify: (text: string, type?: string) => notifications.push([text, type]),
		},
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
	})({ on: (event: string, handler: Handler) => handlers.set(event, handler), sendMessage: (message: any, options: any) => { if (sendControl.fail) throw new Error("session disposed"); sent.push([message, options]); } } as never);
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
		pressKey: (key: string) => terminalInput?.(key),
		get statusText() { return statuses.at(-1)?.[1]; },
		sent, sendControl, timers, statuses, notifications,
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 120_000, recoveryMs: 240_000 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 30_000, recoveryMs: 90_000 } } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.advance(30_000);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 30s; aborting and asking Pi to retry in 1m (Esc aborts now)", "warning"]);
	});
});

test("config warnings: flat providerStallWatchdog reaches announce via the settings lint", () => {
	withSettings(
		{},
		{
			providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 },
			quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		},
		(cwd) => {
			const h = watchdogHarness("tui", cwd);
			h.emit("before_provider_request");
			const hit = h.notifications.find(([text]) => text.includes('"providerStallWatchdog" at top level - move under "quiver"'));
			assert.ok(hit, "flat settings lint reaches announce");
			assert.equal(hit![1], "warning");
		},
	);
});

test("nested-only quiver.providerStallWatchdog config resolves", () => {
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 30_000, recoveryMs: 90_000 } } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.advance(30_000);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 30s; aborting and asking Pi to retry in 1m (Esc aborts now)", "warning"]);
	});
});

test("resolveRetryMaxRetries: quiver.retry is never consulted", () => {
	withSettings({}, { quiver: { retry: { maxRetries: 7 }, providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.emit("message_start", messageStart());
		h.advance(20);
		const notice = h.notifications.at(-1)![0];
		assert.ok(notice.includes("(1/3)"), `stall budget stays at pi's default 3, not quiver.retry's 7: ${notice}`);
	});
});

function withEnabledWatchdog(assertion: (cwd: string) => void | Promise<void>): void | Promise<void> {
	return withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } }, assertion);
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 100 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 100 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			h.emit("before_provider_request");
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } } }));
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
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ quiver: { providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } } }));
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 120_000, recoveryMs: 240_000 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 1 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 2 } } }, (cwd) => {
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

test("converted abort appends omission and re-drives after delay in print mode", async () => {
	await withSettings({}, { retry: { baseDelayMs: 5 }, quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		h.emit("before_provider_request"); h.advance(5);
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		const sibling = { type: "sibling" };
		assert.deepEqual(h.emit("turn_end", { messageEntryId: "entry-1", entries: [sibling] }), { entries: [sibling, { type: "context_edit", targetId: "entry-1", replacement: null }] });
		const settled = h.emit("agent_settled") as Promise<void>;
		h.advance(4); assert.equal(h.sent.length, 0);
		h.advance(1); await settled;
		assert.deepEqual(h.sent, [[{ customType: "provider-stall-watchdog", content: "The previous provider request stalled before completing and was retried automatically. Continue.", display: false }, { triggerTurn: true }]]);
	});
});

test("TUI pending re-drive shows countdown and Esc cancels it", async () => {
	await withEnabledWatchdog(async (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		h.emit("turn_end", { messageEntryId: "entry", entries: [] });
		await h.emit("agent_settled");
		assert.equal(h.statusText, "Retrying (1/3) in 2s... (Esc to cancel)");
		assert.deepEqual(h.pressKey("x"), undefined, "non-Esc passes through");
		assert.equal(h.statusText, "Retrying (1/3) in 2s... (Esc to cancel)");
		assert.deepEqual(h.pressKey("\x1b"), { consume: true }); h.advance(2_000);
		assert.equal(h.pressKey("\x1b"), undefined, "subscription is removed on cancellation");
		assert.equal(h.sent.length, 0);
		assert.equal(h.statusText, undefined);
		assert.deepEqual(h.notifications.at(-1), ["Automatic retry cancelled; submit the message again to retry manually.", undefined]);
	});
});

test("request-less re-drive error does not schedule another re-drive", async () => {
	await withSettings({}, { ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 1 } } }, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		stallAndConvert(h);
		const settled = h.emit("agent_settled") as Promise<void>;
		h.advance(2_000); await settled;
		h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
		const second = h.emit("agent_settled") as Promise<void>;
		h.advance(60_000);
		await second;
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.notifications.at(-1), ["The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.", undefined]);
		h.newController(); h.emit("before_provider_request"); h.advance(5);
		assert.deepEqual(h.notifications.at(-1), ["Provider sent no response for 5ms; stopping and retrying the request.", undefined], "the next stall starts a fresh chain rather than exhausting the budget");
	});
});

test("RPC returns immediately and input cancels its armed timer silently", async () => {
	await withSettings({}, RETRY_ON, async (cwd) => {
		const h = watchdogHarness("rpc", cwd);
		stallAndConvert(h);
		const result = h.emit("agent_settled") as Promise<void>;
		const status = h.statusText;
		const notices = h.notifications.length;
		h.emit("input", { text: "hello", source: "interactive" });
		h.advance(2_000);
		await result;
		assert.equal(status, "Retrying (1/3) in 2s... (Esc to cancel)");
		assert.equal(h.sent.length, 0);
		assert.deepEqual(h.statuses.at(-1), ["providerStallWatchdog", undefined]);
		assert.equal(h.notifications.length, notices);
	});
});

test("TUI timer cancellation events clear status without a notice", async () => {
	await withSettings({}, RETRY_ON, async (cwd) => {
		for (const event of ["input", "session_before_tree", "session_before_compact", "before_provider_request"]) {
			const h = watchdogHarness("tui", cwd);
			stallAndConvert(h); await h.emit("agent_settled");
			const notices = h.notifications.length;
			if (event === "before_provider_request") h.newController();
			h.emit(event, event === "input" ? { text: "hello", source: "interactive" } : {});
			if (event !== "before_provider_request") h.advance(2_000);
			assert.equal(h.sent.length, 0, event);
			assert.deepEqual(h.statuses.at(-1), ["providerStallWatchdog", undefined], event);
			assert.equal(h.notifications.length, notices, event);
		}
	});
});

test("TUI input after re-drive send resets the chain before the user's request", async () => {
	await withSettings({}, RETRY_ON, async (cwd) => {
		const h = watchdogHarness("tui", cwd);
		stallAndConvert(h); await h.emit("agent_settled");
		h.advance(2_000);
		assert.equal(h.sent.length, 1);
		h.emit("input", { text: "new prompt", source: "interactive" });
		h.newController(); h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		assert.ok(h.notifications.at(-1)?.[0].includes("(1/3)"), "the user's request starts at retry 1, not continuation retry 2");
		assert.equal(h.sent.length, 1, "the previous chain sent nothing else");
	});
});

test("TUI countdown expires and its own continuation retains the stall budget", async () => {
	await withSettings({}, RETRY_ON, async (cwd) => {
		const h = watchdogHarness("tui", cwd);
		stallAndConvert(h); await h.emit("agent_settled");
		h.advance(1_000);
		assert.equal(h.statusText, "Retrying (1/3) in 1s... (Esc to cancel)");
		h.advance(1_000);
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.statuses.at(-1), ["providerStallWatchdog", undefined]);
		h.newController(); h.emit("before_provider_request"); h.emit("message_start", messageStart()); h.advance(20);
		assert.ok(h.notifications.at(-1)?.[0].includes("(2/3)"));
	});
});

test("native retry completing successfully resets without degradation or re-drive", async () => {
	await withSettings({}, RETRY_ON, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		stallAndConvert(h);
		h.newController(); h.emit("before_provider_request");
		h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		h.emit("turn_end", { messageEntryId: "success", entries: [] });
		const notices = h.notifications.length;
		await h.emit("agent_settled");
		assert.equal(h.sent.length, 0);
		assert.equal(h.notifications.length, notices);
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } } }, (cwd) => {
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

const RETRY_ON = { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20, maxStallRetries: 3 } }, retry: { enabled: true, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 } };
const REDRIVE = { customType: "provider-stall-watchdog", content: "The previous provider request stalled before completing and was retried automatically. Continue.", display: false };
function stallAndConvert(h: ReturnType<typeof watchdogHarness>, entry = "entry-aborted") {
	h.emit("before_provider_request"); h.advance(5);
	const converted = h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }) as { message: { stopReason: string } };
	assert.equal(converted?.message.stopReason, "error");
	return h.emit("turn_end", { messageEntryId: entry, entries: [{ type: "custom", customType: "sibling" }] }) as { entries: unknown[] } | undefined;
}

test("only the converted watchdog turn is omitted, not another error or the exhausted attempt", async () => {
	await withSettings({}, { ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 1 } } }, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		assert.deepEqual(stallAndConvert(h)?.entries, [{ type: "custom", customType: "sibling" }, { type: "context_edit", targetId: "entry-aborted", replacement: null }]);
		const settled = h.emit("agent_settled") as Promise<void>; h.advance(2_000); await settled;
		h.newController(); h.emit("before_provider_request"); h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
		assert.equal(h.emit("turn_end", { messageEntryId: "other-error", entries: [] }), undefined);
		h.advance(5);
		assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined);
		assert.equal(h.emit("turn_end", { messageEntryId: "exhausted", entries: [] }), undefined);
		await h.emit("agent_settled"); assert.equal(h.sent.length, 1);
	});
});

test("print re-drive awaits uncapped doubling and capped third delay; successful continuation resets the chain", async () => {
	await withSettings({}, { ...RETRY_ON, retry: { enabled: true, baseDelayMs: 2_000, maxAgentDelayMs: 5_000 } }, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		stallAndConvert(h); let settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0].delayMs, 2_000); assert.equal(h.sent.length, 0);
		h.advance(2_000); await settled; assert.deepEqual(h.sent, [[REDRIVE, { triggerTurn: true }]]);
		h.newController(); stallAndConvert(h, "second"); settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0].delayMs, 4_000);
		h.advance(4_000); await settled; assert.equal(h.sent.length, 2);
		h.newController(); stallAndConvert(h, "third"); settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0].delayMs, 5_000);
		h.advance(5_000); await settled; assert.equal(h.sent.length, 3);
		h.newController(); h.emit("before_provider_request"); h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		assert.equal(h.emit("turn_end", { messageEntryId: "success", entries: [] }), undefined);
		await h.emit("agent_settled"); assert.equal(h.sent.length, 3);
		h.newController(); stallAndConvert(h); settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0].delayMs, 2_000); h.advance(2_000); await settled;
	});
});

test("print re-drive re-reads retry delay, cap, and enabled between stalls in one session", async () => {
	await withSettings({}, { ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 5 } } }, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		stallAndConvert(h); let settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0]?.delayMs, 2_000, "first stall uses the initial base delay");
		h.advance(2_000); await settled; assert.equal(h.sent.length, 1);

		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 5 } }, retry: { enabled: true, baseDelayMs: 500, maxAgentDelayMs: 60_000 } }));
		h.newController(); stallAndConvert(h, "second"); settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0]?.delayMs, 1_000, "second stall doubles the live base delay");
		h.advance(1_000); await settled; assert.equal(h.sent.length, 2);

		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 5 } }, retry: { enabled: true, baseDelayMs: 500, maxAgentDelayMs: 700 } }));
		h.newController(); stallAndConvert(h, "third"); settled = h.emit("agent_settled") as Promise<void>;
		assert.equal([...h.timers.values()][0]?.delayMs, 700, "third stall uses the live delay cap");
		h.advance(700); await settled; assert.equal(h.sent.length, 3);

		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 5 } }, retry: { enabled: false, baseDelayMs: 500, maxAgentDelayMs: 700 } }));
		h.newController(); assert.equal(stallAndConvert(h, "fourth"), undefined, "disabled retry leaves no omission draft");
		await h.emit("agent_settled");
		assert.deepEqual(h.notifications.at(-1), ["The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.", undefined]);
		assert.equal(h.sent.length, 3, "disabled retry sends no continuation");
		assert.equal(h.timers.size, 0, "disabled retry arms no timer");
	});
});

test("disabled retry, live setting flip, and exhausted budgets never send", async () => {
	for (const maxStallRetries of [0, 2]) {
		await withSettings({}, { ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries } } }, async (cwd) => {
			const h = watchdogHarness("print", cwd);
			for (let i = 0; i < maxStallRetries; i++) { stallAndConvert(h); const settled = h.emit("agent_settled") as Promise<void>; h.advance(60_000); await settled; h.newController(); }
			h.emit("before_provider_request"); h.advance(5);
			assert.ok(h.notifications.at(-1)?.[0].includes("budget is spent"));
			assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined);
			assert.equal(h.emit("turn_end", { messageEntryId: "exhausted", entries: [] }), undefined);
			await h.emit("agent_settled"); assert.ok(h.notifications.at(-1)?.[0].startsWith("The stalled request was stopped"));
			assert.equal(h.sent.length, maxStallRetries);
		});
	}
	for (const flip of [false, true]) await withSettings({}, flip ? RETRY_ON : { ...RETRY_ON, retry: { enabled: false } }, async (cwd) => {
		const h = watchdogHarness("print", cwd);
		if (flip) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ ...RETRY_ON, retry: { enabled: false } }));
		assert.equal(stallAndConvert(h), undefined); await h.emit("agent_settled");
		assert.equal(h.sent.length, 0); assert.ok(h.notifications.at(-1)?.[0].startsWith("The stalled request was stopped"));
	});
});

test("exhaustion after native-style continuation and stale-runtime synchronous send failure", async () => {
	await withSettings({}, { ...RETRY_ON, quiver: { providerStallWatchdog: { ...RETRY_ON.quiver.providerStallWatchdog, maxStallRetries: 1 } } }, async (cwd) => {
		const h = watchdogHarness("print", cwd); stallAndConvert(h);
		h.newController(); h.emit("before_provider_request"); h.advance(5);
		assert.ok(h.notifications.at(-1)?.[0].includes("budget is spent"));
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		await h.emit("agent_settled"); assert.equal(h.sent.length, 0);
	});
	await withSettings({}, RETRY_ON, async (cwd) => {
		const h = watchdogHarness("print", cwd); h.sendControl.fail = true; stallAndConvert(h);
		const settled = h.emit("agent_settled") as Promise<void>; h.advance(2_000); await settled;
		assert.ok(h.notifications.at(-1)?.[0].startsWith("providerStallWatchdog: automatic retry failed to start:"));
		h.newController(); h.emit("before_provider_request"); h.advance(5);
		assert.ok(h.notifications.at(-1)?.[0].includes("stopping and retrying"));
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
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			retry: { enabled: retryEnabled, maxRetries: opts.maxRetries ?? 1, baseDelayMs: 1 },
			quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 20, warningMs: 10, recoveryMs: 20, ...(opts.maxStallRetries === undefined ? {} : { maxStallRetries: opts.maxStallRetries }) } },
		}));
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
		const settingsManager = SettingsManager.create(root, agentDir);
		const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [providerStallWatchdog] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), customTools: [defineTool({ name: "watchdog_tool", label: "watchdog tool", description: "test", parameters: Type.Object({}), execute: async () => { toolCalls += 1; return { content: [{ type: "text", text: "tool complete" }], details: undefined }; } })] });
		// InteractiveMode editor restoration is upstream Pi behavior; this pins the watchdog's public abort binding.
		const withUI = opts.withUI !== false;
		await session.bindExtensions({ ...(withUI ? { uiContext: { notify: (text: string) => notifications.push(text), setStatus: () => {}, setEditorText: (text: string) => editor.push(text), onTerminalInput: () => () => {} } as any } : {}), mode: opts.mode ?? "tui", abortHandler: () => { const queued = session.clearQueue(); for (const text of [...queued.steering, ...queued.followUp]) editor.push(text); void session.abort(); } });
		return { session, contexts, starts, editor, notifications, lastBranchAssistant: () => (session as any).sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message.role === "assistant").at(-1)?.message as any, projectedContext: () => (session as any).sessionManager.buildSessionProjection().messages as any[], get toolCalls() { return toolCalls; }, dispose: () => { session.dispose(); if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(root, { recursive: true, force: true }); } };
	} catch (error) { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(root, { recursive: true, force: true }); throw error; }
}

function assertRecoveredProjection(messages: any[]) {
	assert.equal(messages.filter((m) => m.role === "assistant" && m.stopReason === "error").length, 0, "converted attempts are omitted");
	assert.equal(messages.at(-1)?.role, "assistant");
	const previous = messages.at(-2);
	assert.equal(previous?.role, "custom", "the hidden re-drive precedes the final assistant in the projection");
	assert.equal(previous?.customType, REDRIVE.customType);
	assert.equal(previous?.content, REDRIVE.content);
}

test("installed runtime watchdog uses ExtensionContext.abort to clear queued follow-up through bound abortHandler and retry", async () => {
	const h = await runtimeWatchdogHarness(["tool", "stall", "success"]);
	try {
		const run = h.session.prompt("start"); await waitBounded(h.starts[1].promise, "stalled request start"); await h.session.followUp("keep this out of retry"); await waitBounded(run, "stalled run"); await waitBounded(h.starts[2].promise, "re-driven request"); await waitBounded(h.session.waitForIdle(), "recovered run");
		assert.equal(h.contexts.length, 3); assert.equal(h.toolCalls, 1, "watchdog_tool handler ran exactly once"); assert.deepEqual(h.editor, ["keep this out of retry"]);
		for (const [index, context] of h.contexts.entries()) assert.equal(context.messages.filter((message: any) => message.role === "user").length, index === 2 ? 2 : 1);
		for (const index of [1, 2]) {
			const toolResults = h.contexts[index].messages.filter((message: any) => message.role === "toolResult");
			assert.equal(toolResults.length, 1, `context ${index} has one completed tool result`);
			assert.equal(toolResults[0].toolCallId, "watchdog-tool-call", `context ${index} completed the watchdog tool call`);
		}
		assert.equal(h.lastBranchAssistant()?.role, "assistant"); assert.equal(h.lastBranchAssistant()?.stopReason, "stop");
		assert.equal(h.projectedContext().filter((m: any) => m.role === "assistant" && m.stopReason === "error").length, 0, "the converted abort is omitted from model context");
		assert.equal(h.contexts[2].messages.at(-1)?.role, "user", "the hidden re-drive is the last user turn");
	} finally { h.dispose(); }
});

test("installed runtime aborts a stalled request past the stall budget without recursive retry", async () => {
	const h = await runtimeWatchdogHarness(["stall", "stall"], true, { maxStallRetries: 1 });
	try { await waitBounded(h.session.prompt("start"), "first stalled run"); await waitBounded(h.starts[1].promise, "second stalled request"); await waitBounded(h.session.waitForIdle(), "second stalled run"); assert.equal(h.contexts.length, 2); assert.equal(h.lastBranchAssistant()?.stopReason, "aborted"); assert.equal(h.projectedContext().at(-1)?.stopReason, "aborted"); assert.equal(h.projectedContext().filter((m: any) => m.role === "custom" && m.customType === REDRIVE.customType).length, 1, "exhaustion adds no second re-drive"); assert.ok(h.notifications.includes("Provider sent no response for 20ms and the stall-retry budget is spent; the request was stopped.")); assert.equal(h.notifications.at(-1), "The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually."); }
	finally { h.dispose(); }
});

test("installed runtime retries multiple consecutive stalls within the stall budget", async () => {
	const h = await runtimeWatchdogHarness(["stall", "stall", "success"], true, { maxStallRetries: 2, maxRetries: 2 });
	try {
		await waitBounded(h.session.prompt("start"), "first stalled run"); await waitBounded(h.starts[2].promise, "third request"); await waitBounded(h.session.waitForIdle(), "multi-stall run");
		assert.equal(h.contexts.length, 3);
		assert.equal(h.lastBranchAssistant()?.role, "assistant");
		assert.equal(h.lastBranchAssistant()?.stopReason, "stop");
		assertRecoveredProjection(h.projectedContext());
	} finally { h.dispose(); }
});

test("installed runtime degrades without a continuation when retry is disabled", async () => {
	const h = await runtimeWatchdogHarness(["stall"], false);
	try { await waitBounded(h.session.prompt("start"), "retry-disabled stalled run"); assert.equal(h.contexts.length, 1); assert.equal(h.lastBranchAssistant()?.stopReason, "error"); assert.equal(h.projectedContext().some((m: any) => m.role === "assistant" && m.stopReason === "error"), true); assert.equal(h.notifications.at(-1), "The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually."); }
	finally { h.dispose(); }
});

test("installed runtime converts a request that never emits a stream event", async () => {
	const h = await runtimeWatchdogHarness(["stall", "success"]);
	try {
		await waitBounded(h.session.prompt("start"), "first run"); await waitBounded(h.starts[1].promise, "re-driven request"); await waitBounded(h.session.waitForIdle(), "no-first-event run");
		assert.equal(h.contexts.length, 2, "the unresponsive request was retried");
		assert.equal(h.lastBranchAssistant()?.stopReason, "stop");
		assertRecoveredProjection(h.projectedContext());
		assert.equal(h.notifications.at(0), "Provider sent no response for 20ms; stopping and retrying the request.");
	} finally { h.dispose(); }
});

test("installed runtime still converts a mid-stream stall after the first event", async () => {
	const h = await runtimeWatchdogHarness(["slow", "success"]);
	try {
		await waitBounded(h.session.prompt("start"), "first run"); await waitBounded(h.starts[1].promise, "re-driven request"); await waitBounded(h.session.waitForIdle(), "mid-stream stall run");
		assert.equal(h.contexts.length, 2);
		assert.equal(h.lastBranchAssistant()?.stopReason, "stop");
		assertRecoveredProjection(h.projectedContext());
		// Pins the recovery notice specifically (retry budget + "returned to the editor"), not the warning
		// notice, which also starts with "No model progress for" - the recovery notice is always the last one
		// to fire. The elapsed-ms figure is left as \d+ because it is measured against real timers and jitters
		// a millisecond or two past the configured recoveryMs.
		assert.match(
			h.notifications.at(-1)!,
			/^No model progress for \d+ms; aborting now\. Pi will retry \(1\/1\) if retry is enabled and capacity remains\. Pending follow-ups are returned to the editor\.$/,
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
		assert.equal(h.lastBranchAssistant()?.stopReason, "stop");
		assertRecoveredProjection(h.projectedContext());
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
		await waitBounded(h.starts[1].promise, "re-driven extension-origin request"); await waitBounded(h.session.waitForIdle(), "extension-origin retry");
		assert.equal(h.contexts.length, 2, "the extension-origin turn was watched and retried");
		assert.equal(h.lastBranchAssistant()?.stopReason, "stop");
		assertRecoveredProjection(h.projectedContext());
	} finally { h.dispose(); }
});

test("a request with no assistant message_start aborts at firstEventMs", () => {
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 10, warningMs: 20, recoveryMs: 30 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 10, warningMs: 20, recoveryMs: 30 } } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("before_provider_request");
		h.advance(9);
		h.emit("message_update", semantic("text_delta", "x"));
		h.advance(1);
		assert.equal(h.aborts, 1, "the first-event deadline is only cleared by message_start");
	});
});

test("an abort that never yields message_end escalates after the grace period", () => {
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } } }, (cwd) => {
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
	withSettings({}, { quiver: { providerStallWatchdog: { enabled: true, firstEventMs: 5, warningMs: 10, recoveryMs: 20 } } }, (cwd) => {
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
