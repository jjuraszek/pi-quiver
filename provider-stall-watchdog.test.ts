import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
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
} from "./provider-stall-watchdog.ts";

test("coerce preserves recognized values without type filtering", () => {
	const cases: Array<{ raw: unknown; expected: ConfigCandidate | undefined }> = [
		{ raw: undefined, expected: undefined },
		{ raw: false, expected: { blockIsObject: false } },
		{
			raw: { enabled: true, warningMs: "bad", ignored: "value" },
			expected: { blockIsObject: true, enabled: true, warningMs: "bad" },
		},
		{
			raw: { enabled: "yes", warningMs: null, recoveryMs: Infinity, maxStallRetries: "many" },
			expected: { blockIsObject: true, enabled: "yes", warningMs: null, recoveryMs: Infinity, maxStallRetries: "many" },
		},
	];

	for (const { raw, expected } of cases) assert.deepEqual(coerce(raw), expected);
});

test("validateConfig accepts a complete valid candidate", () => {
	assert.deepEqual(
		validateConfig({ blockIsObject: true, enabled: true, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 }),
		{ ok: true, config: { enabled: true, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 } },
	);
});

test("validateConfig fails closed for invalid values", () => {
	const valid = { blockIsObject: true, enabled: true, warningMs: 120_000, recoveryMs: 240_000, maxStallRetries: 3 };
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
		{ name: "zero maxStallRetries", candidate: { ...valid, maxStallRetries: 0 } },
		{ name: "negative maxStallRetries", candidate: { ...valid, maxStallRetries: -1 } },
		{ name: "fractional maxStallRetries", candidate: { ...valid, maxStallRetries: 1.5 } },
		{ name: "maxStallRetries wrong type", candidate: { ...valid, maxStallRetries: "3" } },
	];

	for (const { name, candidate } of cases) {
		const result = validateConfig(candidate);
		assert.equal(result.ok, false, name);
	}
});

test("validateConfig accepts Node's maximum timer delay", () => {
	assert.deepEqual(
		validateConfig({ blockIsObject: true, enabled: true, warningMs: 1, recoveryMs: MAX_TIMER_MS, maxStallRetries: 1 }),
		{ ok: true, config: { enabled: true, warningMs: 1, recoveryMs: MAX_TIMER_MS, maxStallRetries: 1 } },
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
		{ providerStallWatchdog: false },
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } },
		(cwd) => {
			assert.deepEqual(resolveWatchdogConfig(cwd), {
				ok: true,
				config: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 3 },
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
				config: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 5 },
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
			assert.equal((result as { ok: true; config: { maxStallRetries: number } }).config.maxStallRetries, 3, "non-positive retry.maxRetries falls back to Pi's default");
		},
	);

	withSettings(
		{},
		{ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 0 } },
		(cwd) => {
			assert.equal(resolveWatchdogConfig(cwd).ok, false, "explicit non-positive maxStallRetries fails closed");
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
		timers, statuses, notifications, ctx,
	};
}

function semantic(type: "text_delta" | "thinking_delta" | "toolcall_delta", delta: string) {
	return { message: { role: "assistant" }, assistantMessageEvent: { type, delta } };
}

test("human TUI runs arm only after before_agent_start and semantic deltas reset silence", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 120_000, recoveryMs: 240_000 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" });
		h.emit("before_provider_request");
		assert.equal(h.timers.size, 0, "input alone is pending");
		h.emit("before_agent_start");
		h.emit("before_provider_request");
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
		h.emit("input", { source: "interactive" });
		h.emit("before_agent_start");
		h.emit("before_provider_request");
		h.advance(30_000);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 30s; aborting and asking Pi to retry in 1m (Esc aborts now)", "warning"]);
	});
});

function withEnabledWatchdog(assertion: (cwd: string) => void): void {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } }, assertion);
}

test("rpc and extension input clear pending origin, and non-TUI modes stay inert", () => {
	withEnabledWatchdog((cwd) => {
		for (const source of ["rpc", "extension"] as const) {
			const h = watchdogHarness("tui", cwd);
			h.emit("input", { source: "interactive" });
			h.emit("input", { source });
			h.emit("before_agent_start");
			h.emit("before_provider_request");
			assert.equal(h.timers.size, 0, source);
		}
		for (const mode of ["json", "rpc", "print"]) {
			const h = watchdogHarness(mode, cwd);
			h.emit("input", { source: "interactive" });
			h.emit("before_agent_start");
			h.emit("before_provider_request");
			assert.equal(h.timers.size, 0, mode);
		}
	});
});

test("handled interactive input followed by extension input is inert", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" });
		h.emit("input", { source: "extension" });
		h.emit("before_agent_start");
		h.emit("before_provider_request");
		assert.equal(h.timers.size, 0);
	});
});

test("every request gets a generation and only non-empty semantic deltas reset deadlines", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
		const first = [...h.timers.keys()];
		h.emit("before_provider_request");
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
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
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
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
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
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request"); h.advance(10);
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

test("removed old signal listeners cannot affect a new generation", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
		const [warning, recovery] = [...h.timers.values()].map((timer) => timer.callback);
		const oldController = h.newController();
		h.emit("before_provider_request");
		warning(); recovery(); oldController.abort();
		assert.equal(h.notifications.length, 0);
		assert.equal(h.timers.size, 2, "stale timer callbacks and removed old listeners leave the new generation armed");
	});
});

test("aborting the active signal during recovery clears the warning and disarms captured callbacks", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
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
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
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
			h.emit("input", { source: "interactive" }); h.emit("before_agent_start");
			writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20 } }));
			h.emit("session_shutdown");
			h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
		} finally {
			console.warn = originalWarn;
		}
		assert.equal(h.timers.size, 2);
	});
});

test("first recovery marks ownership, consumes retry, notifies, then synchronously aborts", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
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
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request"); h.advance(240_000);
		assert.deepEqual(h.notifications, [
			["No model progress for 2m; aborting and asking Pi to retry in 2m (Esc aborts now)", "warning"],
			["No model progress for 4m; aborting now. Pi will retry (1/3) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.", undefined],
		]);
	});
});

test("only watchdog-owned first abort is rewritten; external abort disarms delayed message_end", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
		h.abortCurrentSignal();
		const external = { role: "assistant", stopReason: "aborted", id: "external" };
		assert.equal(h.emit("message_end", { message: external }), undefined);
		assert.equal(h.aborts, 0);
	});
});

test("watchdog-first ownership survives a later Esc and an exhausted budget stops converting", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 1 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request"); h.advance(20); h.abortCurrentSignal();
		assert.equal((h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }) as any)?.message.stopReason, "error");
		h.newController(); h.emit("before_provider_request"); h.advance(20);
		assert.equal(h.aborts, 2);
		assert.deepEqual(h.notifications.at(-1), ["Stall retry budget (1) exhausted; aborting without another automatic retry. Submit the message again manually.", undefined]);
		assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined);
	});
});

test("consecutive stalls convert until maxStallRetries is exhausted", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, maxStallRetries: 2 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start");
		for (const expected of ["(1/2)", "(2/2)"]) {
			h.emit("before_provider_request"); h.advance(20);
			assert.ok(h.notifications.at(-1)![0].includes(expected), `recovery notice reports ${expected}`);
			assert.equal((h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }) as any)?.message.stopReason, "error");
			h.newController();
		}
		h.emit("before_provider_request"); h.advance(20);
		assert.deepEqual(h.notifications.at(-1), ["Stall retry budget (2) exhausted; aborting without another automatic retry. Submit the message again manually.", undefined]);
		assert.equal(h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }), undefined);
		assert.equal(h.aborts, 3);
	});
});

test("a successful assistant turn resets the stall retry counter", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request"); h.advance(20);
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		h.newController(); h.emit("before_provider_request");
		h.emit("message_update", semantic("text_delta", "x"));
		h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
		h.newController(); h.emit("before_provider_request"); h.advance(20);
		assert.deepEqual(h.notifications.at(-1), ["No model progress for 20ms; aborting now. Pi will retry (1/3) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.", undefined]);
	});
});

test("settlement only resets retry and reports an unavailable continuation", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request"); h.advance(20);
		h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } }); h.emit("agent_settled");
		assert.deepEqual(h.notifications.at(-1), ["The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.", undefined]);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.newController(); h.emit("before_provider_request"); h.advance(20);
		assert.equal(h.aborts, 2);
	});
});

test("interactive steering during an active run does not reset the stall retry counter", () => {
	withEnabledWatchdog((cwd) => {
		const h = watchdogHarness("tui", cwd);
		h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request"); h.advance(20);
		h.emit("input", { source: "interactive" }); h.newController(); h.emit("before_provider_request"); h.advance(20);
		assert.ok(h.notifications.at(-1)![0].includes("(2/3)"), "steering does not reset the counter");
	});
});

test("invalid config disables once without timers", () => {
	withSettings({}, { providerStallWatchdog: { enabled: true, warningMs: 20, recoveryMs: 10 } }, (cwd) => {
		const h = watchdogHarness("tui", cwd);
		const originalWarn = console.warn; let warnings = 0; console.warn = () => { warnings += 1; };
		try {
			h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
			h.emit("input", { source: "interactive" }); h.emit("before_agent_start"); h.emit("before_provider_request");
		} finally { console.warn = originalWarn; }
		assert.equal(warnings, 1); assert.equal(h.notifications.length, 1); assert.equal(h.timers.size, 0);
	});
});

type RuntimeScript = "tool" | "stall" | "success";

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

async function runtimeWatchdogHarness(scripts: RuntimeScript[], retryEnabled = true, opts: { maxStallRetries?: number; maxRetries?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), "provider-stall-watchdog-runtime-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const contexts: any[] = []; const starts = scripts.map(() => deferred<void>()); const editor: string[] = []; const notifications: string[] = []; let toolCalls = 0;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ providerStallWatchdog: { enabled: true, warningMs: 10, recoveryMs: 20, ...(opts.maxStallRetries === undefined ? {} : { maxStallRetries: opts.maxStallRetries }) } }));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const runtime = await ModelRuntime.create({ modelsPath: null });
		runtime.registerProvider("watchdog-test", { apiKey: "test-key", baseUrl: "https://watchdog.test", api: "watchdog-test", models: [{ id: "watchdog-test-model", name: "Watchdog test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, maxTokens: 1_024 }], streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream(); const index = contexts.push(context) - 1;
			void (async () => {
				await options?.onPayload?.({ request: index }, model); await options?.onResponse?.({ status: 200, headers: {} }, model); starts[index].resolve();
				const aborted = () => stream.push({ type: "error", reason: "aborted", error: { ...runtimeAssistant([]), stopReason: "aborted", errorMessage: "aborted" } });
				if (options?.signal?.aborted) return aborted();
				if (scripts[index] === "stall") { options?.signal?.addEventListener("abort", aborted, { once: true }); return; }
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
		await session.bindExtensions({ uiContext: { notify: (text: string) => notifications.push(text), setStatus: () => {}, setEditorText: (text: string) => editor.push(text) } as any, mode: "tui", abortHandler: () => { const queued = session.clearQueue(); for (const text of [...queued.steering, ...queued.followUp]) editor.push(text); void session.abort(); } });
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
	try { await waitBounded(h.session.prompt("start"), "second stalled run"); assert.equal(h.contexts.length, 2); assert.equal((h.session.messages.at(-1) as any).stopReason, "aborted"); assert.equal(h.notifications.at(-1), "Stall retry budget (1) exhausted; aborting without another automatic retry. Submit the message again manually."); }
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
