import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettings, resolveConfig, settingsPaths } from "./extension-config.ts";

export const MAX_TIMER_MS = 2_147_483_647;
export const DEFAULT_CONFIG = {
	enabled: false,
	firstEventMs: 20_000,
	warningMs: 120_000,
	recoveryMs: 240_000,
} as const;

export type WatchdogConfig = {
	enabled: boolean;
	firstEventMs: number;
	warningMs: number;
	recoveryMs: number;
	maxStallRetries: number;
};

export type WatchdogRuntime = {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type ConfigCandidate = {
	blockIsObject?: unknown;
	enabled?: unknown;
	firstEventMs?: unknown;
	warningMs?: unknown;
	recoveryMs?: unknown;
	maxStallRetries?: unknown;
};

export type ConfigValidation =
	| { ok: true; config: WatchdogConfig }
	| { ok: false; error: string };

const DEFAULT_CANDIDATE: ConfigCandidate = { blockIsObject: true, ...DEFAULT_CONFIG };

export function coerce(raw: unknown): ConfigCandidate | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return { blockIsObject: true, enabled: raw };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { blockIsObject: false };

	const source = raw as Record<string, unknown>;
	const candidate: ConfigCandidate = { blockIsObject: true };
	for (const key of ["enabled", "firstEventMs", "warningMs", "recoveryMs", "maxStallRetries"] as const) {
		if (Object.hasOwn(source, key)) candidate[key] = source[key];
	}
	return candidate;
}

export function validateConfig(candidate: ConfigCandidate): ConfigValidation {
	if (candidate.blockIsObject !== true) return { ok: false, error: "providerStallWatchdog must be an object" };
	if (typeof candidate.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
	if (!isTimerDelay(candidate.firstEventMs)) return { ok: false, error: "firstEventMs must be a positive timer delay" };
	if (!isTimerDelay(candidate.warningMs)) return { ok: false, error: "warningMs must be a positive timer delay" };
	if (!isTimerDelay(candidate.recoveryMs)) return { ok: false, error: "recoveryMs must be a positive timer delay" };
	if (candidate.warningMs >= candidate.recoveryMs) return { ok: false, error: "warningMs must be less than recoveryMs" };
	if (!isNonNegativeInteger(candidate.maxStallRetries)) return { ok: false, error: "maxStallRetries must be a non-negative integer" };
	return {
		ok: true,
		config: {
			enabled: candidate.enabled,
			firstEventMs: candidate.firstEventMs,
			warningMs: candidate.warningMs,
			recoveryMs: candidate.recoveryMs,
			maxStallRetries: candidate.maxStallRetries,
		},
	};
}

function isTimerDelay(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Pi's own resolution is `settings.retry?.maxRetries ?? 3` over the same layered settings.json files. */
export function resolveRetryMaxRetries(cwd: string): number {
	let maxRetries = 3;
	for (const path of settingsPaths(cwd)) {
		const retry = readSettings(path)?.retry;
		if (retry === null || typeof retry !== "object" || Array.isArray(retry)) continue;
		const value = (retry as Record<string, unknown>).maxRetries;
		if (isNonNegativeInteger(value)) maxRetries = value;
	}
	return maxRetries;
}

export function resolveWatchdogConfig(cwd: string): ConfigValidation {
	const candidate = resolveConfig(cwd, "providerStallWatchdog", DEFAULT_CANDIDATE, coerce);
	if (candidate.blockIsObject === true && candidate.maxStallRetries === undefined) {
		candidate.maxStallRetries = resolveRetryMaxRetries(cwd);
	}
	return validateConfig(candidate);
}

const defaultRuntime: WatchdogRuntime = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEGRADATION_NOTICE = "The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.";
// Reduces, but cannot eliminate, the hang when an aborted provider operation never terminates;
// undici's headersTimeout/bodyTimeout stay the backstop past this point.
const ABORT_GRACE_MS = 10_000;

type Timer = { firstEvent?: unknown; warning?: unknown; recovery?: unknown; abortGuard?: unknown };

function formatElapsed(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

const ABORT_STUCK_NOTICE = `The stalled request did not stop within ${formatElapsed(ABORT_GRACE_MS)} of being aborted; the provider connection is unresponsive. No automatic retry will run - the turn will not end until the HTTP idle timeout expires.`;

function warningNotice(config: WatchdogConfig): string {
	return `No model progress for ${formatElapsed(config.warningMs)}; aborting and asking Pi to retry in ${formatElapsed(config.recoveryMs - config.warningMs)} (Esc aborts now)`;
}

function exhaustedNotice(config: WatchdogConfig): string {
	return `Stall retry budget (${config.maxStallRetries}) exhausted; aborting without another automatic retry. Submit the message again manually.`;
}

function firstEventRetryNotice(config: WatchdogConfig): string {
	return `Provider sent no response for ${formatElapsed(config.firstEventMs)}; stopping and retrying the request.`;
}

function firstEventExhaustedNotice(config: WatchdogConfig): string {
	return `Provider sent no response for ${formatElapsed(config.firstEventMs)} and the stall-retry budget is spent; the request was stopped.`;
}

export function createProviderStallWatchdog(runtime: WatchdogRuntime = defaultRuntime): (pi: ExtensionAPI) => void {
	return (pi) => {
		let midStreamEnabled = false;
		let firstEventSeen = false;
		let hasUI = false;
		let pendingTimeoutReason: string | undefined;
		let activeRun = false;
		let disabled = false;
		let config: WatchdogConfig | undefined;
		let generation = 0;
		let activeGeneration: number | undefined;
		let lastSemanticAt = 0;
		let warned = false;
		let deadlineEpoch = 0;
		let timers: Timer = {};
		let removeSignalListener: (() => void) | undefined;
		let ui: { notify(text: string, type?: string): void } | undefined;
		let watchdogAbortedGeneration: number | undefined;
		let stallRetriesUsed = 0;
		let continuationStarted = false;
		let convertedTimeout = false;

		const clearTimers = () => {
			for (const key of ["firstEvent", "warning", "recovery", "abortGuard"] as const) {
				if (timers[key] !== undefined) runtime.clearTimeout(timers[key]);
			}
			timers = {};
		};
		const announce = (text: string, type?: string) => {
			ui?.notify(text, type);
			if (!hasUI) console.warn(text);
		};
		const clear = () => {
			clearTimers();
			removeSignalListener?.();
			removeSignalListener = undefined;
			activeGeneration = undefined;
		};
		const disarm = () => { clear(); warned = false; };
		const resetRunState = () => {
			disarm();
			activeRun = false;
			stallRetriesUsed = 0;
			continuationStarted = false;
			convertedTimeout = false;
			watchdogAbortedGeneration = undefined;
			pendingTimeoutReason = undefined;
			firstEventSeen = false;
		};
		const armAbortGuard = (capturedGeneration: number) => {
			if (timers.abortGuard !== undefined) runtime.clearTimeout(timers.abortGuard);
			timers.abortGuard = runtime.setTimeout(() => {
				if (capturedGeneration !== activeGeneration || !activeRun) return;
				announce(ABORT_STUCK_NOTICE, "error");
				// Only the timers go: the generation stays armed so a message_end arriving after the grace
				// period still converts the abort the stall retry already paid for.
				clearTimers();
			}, ABORT_GRACE_MS);
		};
		// A stream event on a generation the watchdog already aborted: the stall cycle is over for this
		// request, so nothing re-enters it. The bytes only prove the connection was alive at this instant,
		// so the guard is re-armed rather than cleared - a wedge right after a straggler still escalates.
		const postAbortStreamEvent = () => {
			if (activeGeneration === undefined || watchdogAbortedGeneration !== activeGeneration) return false;
			armAbortGuard(activeGeneration);
			return true;
		};
		const abortStall = (
			ctx: { abort(): void },
			capturedGeneration: number,
			notices: { retry: () => string; exhausted: () => string },
			reason: string,
		) => {
			if (!config) return;
			clearTimers();
			warned = false;
			watchdogAbortedGeneration = capturedGeneration;
			// Armed before ctx.abort() so a synchronous teardown inside it cannot orphan the timer;
			// the generation check makes the callback a no-op if that teardown disarmed the watchdog.
			armAbortGuard(capturedGeneration);
			if (stallRetriesUsed >= config.maxStallRetries) {
				announce(notices.exhausted());
				ctx.abort();
				return;
			}
			pendingTimeoutReason = reason;
			stallRetriesUsed += 1;
			announce(notices.retry());
			ctx.abort();
		};
		const armFirstEvent = (ctx: { abort(): void }) => {
			if (activeGeneration === undefined || !config) return;
			const cfg = config;
			const capturedGeneration = activeGeneration;
			const capturedDeadlineEpoch = ++deadlineEpoch;
			const threshold = cfg.firstEventMs;
			const run = () => {
				if (capturedGeneration !== activeGeneration || capturedDeadlineEpoch !== deadlineEpoch || !activeRun || firstEventSeen) return;
				const elapsed = runtime.now() - lastSemanticAt;
				if (elapsed < threshold) {
					timers.firstEvent = runtime.setTimeout(run, threshold - elapsed);
					return;
				}
				abortStall(ctx, capturedGeneration, {
					retry: () => firstEventRetryNotice(cfg),
					exhausted: () => firstEventExhaustedNotice(cfg),
				}, `Provider first-event timeout after ${cfg.firstEventMs} ms without a stream event`);
			};
			timers.firstEvent = runtime.setTimeout(run, threshold);
		};
		const schedule = (ctx: { abort(): void }) => {
			if (activeGeneration === undefined || !config) return;
			const cfg = config;
			const capturedGeneration = activeGeneration;
			const capturedDeadlineEpoch = ++deadlineEpoch;
			const run = (kind: "warning" | "recovery", threshold: number) => () => {
				if (capturedGeneration !== activeGeneration || capturedDeadlineEpoch !== deadlineEpoch || !activeRun) return;
				const elapsed = runtime.now() - lastSemanticAt;
				if (elapsed < threshold) {
					timers[kind] = runtime.setTimeout(run(kind, threshold), threshold - elapsed);
					return;
				}
				if (kind === "warning" && !warned) {
					warned = true;
					announce(warningNotice(cfg), "warning");
				}
				if (kind === "recovery") {
					abortStall(ctx, capturedGeneration, {
						retry: () => `No model progress for ${formatElapsed(elapsed)}; aborting now. Pi will retry (${stallRetriesUsed}/${cfg.maxStallRetries}) if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.`,
						exhausted: () => exhaustedNotice(cfg),
					}, `Provider semantic timeout after ${cfg.recoveryMs} ms without progress`);
				}
			};
			timers.warning = runtime.setTimeout(run("warning", cfg.warningMs), cfg.warningMs);
			timers.recovery = runtime.setTimeout(run("recovery", cfg.recoveryMs), cfg.recoveryMs);
		};

		pi.on("before_provider_request", (_event, ctx) => {
			if (disabled) return;
			ui = ctx.ui;
			hasUI = ctx.hasUI;
			if (!config) {
				const resolved = resolveWatchdogConfig(ctx.cwd);
				if (!resolved.ok) {
					disabled = true;
					announce(`providerStallWatchdog disabled: ${resolved.error}`, "warning");
					return;
				}
				config = resolved.config;
			}
			activeRun = config.enabled;
			if (!activeRun) return;
			disarm();
			if (convertedTimeout) continuationStarted = true;
			activeGeneration = ++generation;
			lastSemanticAt = runtime.now();
			const target = ctx.signal;
			if (target) {
				const listener = () => {
					if (watchdogAbortedGeneration !== activeGeneration) disarm();
				};
				target.addEventListener("abort", listener, { once: true });
				removeSignalListener = () => target.removeEventListener("abort", listener);
			}
			midStreamEnabled = ctx.mode === "tui";
			firstEventSeen = false;
			armFirstEvent(ctx);
		});
		pi.on("message_start", (event, ctx) => {
			// Pi fires message_start for user and toolResult messages too; only an assistant one is
			// provider traffic, so the role check must stay ahead of the liveness re-arm below.
			if (event.message.role !== "assistant") return;
			if (postAbortStreamEvent()) return;
			if (!activeRun || activeGeneration === undefined || firstEventSeen) return;
			firstEventSeen = true;
			if (timers.firstEvent !== undefined) {
				runtime.clearTimeout(timers.firstEvent);
				timers.firstEvent = undefined;
			}
			if (!midStreamEnabled || !config) return;
			lastSemanticAt = runtime.now();
			warned = false;
			schedule(ctx);
		});
		pi.on("message_update", (event, ctx) => {
			if (postAbortStreamEvent()) return;
			const update = event.assistantMessageEvent;
			if (!midStreamEnabled || !firstEventSeen || activeGeneration === undefined || !(update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") || update.delta.length === 0) return;
			lastSemanticAt = runtime.now();
			warned = false;
			clearTimers();
			schedule(ctx);
		});
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const errorMessage = pendingTimeoutReason;
			pendingTimeoutReason = undefined;
			const matchesWatchdogAbort = errorMessage !== undefined
				&& event.message.stopReason === "aborted"
				&& activeGeneration === watchdogAbortedGeneration;
			disarm();
			// Mirror Pi's retry loop, which resets its attempt counter on any successful assistant turn.
			if (event.message.stopReason !== "aborted" && event.message.stopReason !== "error") stallRetriesUsed = 0;
			if (!matchesWatchdogAbort) return;
			convertedTimeout = true;
			continuationStarted = false;
			return { message: { ...event.message, stopReason: "error", errorMessage } };
		});
		pi.on("agent_end", () => disarm());
		pi.on("agent_settled", () => {
			if (convertedTimeout && !continuationStarted) announce(DEGRADATION_NOTICE);
			resetRunState();
		});
		pi.on("session_shutdown", () => {
			resetRunState();
			config = undefined;
			disabled = false;
		});
	};
}

export default createProviderStallWatchdog();
