import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./extension-config.ts";

export const MAX_TIMER_MS = 2_147_483_647;
export const DEFAULT_CONFIG = {
	enabled: false,
	warningMs: 120_000,
	recoveryMs: 240_000,
} as const;

export type WatchdogConfig = {
	enabled: boolean;
	warningMs: number;
	recoveryMs: number;
};

export type WatchdogRuntime = {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type ConfigCandidate = {
	blockIsObject?: unknown;
	enabled?: unknown;
	warningMs?: unknown;
	recoveryMs?: unknown;
};

export type ConfigValidation =
	| { ok: true; config: WatchdogConfig }
	| { ok: false; error: string };

const DEFAULT_CANDIDATE: ConfigCandidate = { blockIsObject: true, ...DEFAULT_CONFIG };

export function coerce(raw: unknown): ConfigCandidate | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { blockIsObject: false };

	const source = raw as Record<string, unknown>;
	const candidate: ConfigCandidate = { blockIsObject: true };
	for (const key of ["enabled", "warningMs", "recoveryMs"] as const) {
		if (Object.hasOwn(source, key)) candidate[key] = source[key];
	}
	return candidate;
}

export function validateConfig(candidate: ConfigCandidate): ConfigValidation {
	if (candidate.blockIsObject !== true) return { ok: false, error: "providerStallWatchdog must be an object" };
	if (typeof candidate.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
	if (!isTimerDelay(candidate.warningMs)) return { ok: false, error: "warningMs must be a positive timer delay" };
	if (!isTimerDelay(candidate.recoveryMs)) return { ok: false, error: "recoveryMs must be a positive timer delay" };
	if (candidate.warningMs >= candidate.recoveryMs) return { ok: false, error: "warningMs must be less than recoveryMs" };
	return {
		ok: true,
		config: {
			enabled: candidate.enabled,
			warningMs: candidate.warningMs,
			recoveryMs: candidate.recoveryMs,
		},
	};
}

function isTimerDelay(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 && value <= MAX_TIMER_MS;
}

export function resolveWatchdogConfig(cwd: string): ConfigValidation {
	return validateConfig(resolveConfig(cwd, "providerStallWatchdog", DEFAULT_CANDIDATE, coerce));
}

const defaultRuntime: WatchdogRuntime = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const STATUS_KEY = "providerStallWatchdog";
const SECOND_STALL_NOTICE = "The retry also stopped making progress; aborting without another automatic retry. Submit the message again manually.";
const DEGRADATION_NOTICE = "The stalled request was stopped, but Pi did not start an automatic retry. Retry may be disabled, exhausted, or incompatible; submit the message again to retry manually.";

type Timer = { warning?: unknown; recovery?: unknown };

function formatElapsed(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

function warningStatus(config: WatchdogConfig): string {
	return `No model progress for ${formatElapsed(config.warningMs)}; aborting and asking Pi to retry once in ${formatElapsed(config.recoveryMs - config.warningMs)} (Esc aborts now)`;
}

export function createProviderStallWatchdog(runtime: WatchdogRuntime = defaultRuntime): (pi: ExtensionAPI) => void {
	return (pi) => {
		let pendingInteractive = false;
		let activeRun = false;
		let disabled = false;
		let config: WatchdogConfig | undefined;
		let generation = 0;
		let activeGeneration: number | undefined;
		let lastSemanticAt = 0;
		let warned = false;
		let epoch = 0;
		let deadlineEpoch = 0;
		let timers: Timer = {};
		let removeSignalListener: (() => void) | undefined;
		let ui: { setStatus(key: string, text: string | undefined): void; notify(text: string, type?: string): void } | undefined;
		let watchdogAbortedGeneration: number | undefined;
		let timeoutConversionPending = false;
		let stallRetryConsumed = false;
		let continuationStarted = false;
		let convertedTimeout = false;

		const clearTimers = () => {
			if (timers.warning !== undefined) runtime.clearTimeout(timers.warning);
			if (timers.recovery !== undefined) runtime.clearTimeout(timers.recovery);
			timers = {};
		};
		const clearDeadlines = () => {
			clearTimers();
			ui?.setStatus(STATUS_KEY, undefined);
		};
		const clear = () => {
			clearDeadlines();
			removeSignalListener?.();
			removeSignalListener = undefined;
			activeGeneration = undefined;
		};
		const disarm = () => { clear(); warned = false; };
		const resetRunState = () => {
			disarm();
			activeRun = false;
			pendingInteractive = false;
			stallRetryConsumed = false;
			continuationStarted = false;
			convertedTimeout = false;
			watchdogAbortedGeneration = undefined;
			timeoutConversionPending = false;
		};
		const schedule = (ctx: { ui: typeof ui; abort(): void }) => {
			if (activeGeneration === undefined || !config) return;
			const capturedGeneration = activeGeneration;
			const capturedEpoch = epoch;
			const capturedDeadlineEpoch = ++deadlineEpoch;
			const run = (kind: "warning" | "recovery", threshold: number) => () => {
				if (capturedEpoch !== epoch || capturedGeneration !== activeGeneration || capturedDeadlineEpoch !== deadlineEpoch || !activeRun || !config) return;
				const elapsed = runtime.now() - lastSemanticAt;
				if (elapsed < threshold) {
					timers[kind] = runtime.setTimeout(run(kind, threshold), threshold - elapsed);
					return;
				}
				if (kind === "warning" && !warned) {
					warned = true;
					ctx.ui?.setStatus(STATUS_KEY, warningStatus(config));
				}
				if (kind === "recovery") {
					clearDeadlines();
					warned = false;
					if (stallRetryConsumed) {
						ui?.notify(SECOND_STALL_NOTICE);
						ctx.abort();
						return;
					}
					watchdogAbortedGeneration = capturedGeneration;
					timeoutConversionPending = true;
					stallRetryConsumed = true;
					ui?.notify(`No model progress for ${formatElapsed(elapsed)}; aborting now. Pi will retry once if retry is enabled and capacity remains. Pending follow-ups are returned to the editor.`);
					ctx.abort();
				}
			};
			timers.warning = runtime.setTimeout(run("warning", config.warningMs), config.warningMs);
			timers.recovery = runtime.setTimeout(run("recovery", config.recoveryMs), config.recoveryMs);
		};

		pi.on("input", (event) => {
			if (!activeRun) pendingInteractive = event.source === "interactive";
		});
		pi.on("before_agent_start", (_event, ctx) => {
			if (!pendingInteractive) return;
			pendingInteractive = false;
			if (ctx.mode !== "tui" || disabled) return;
			const resolved = resolveWatchdogConfig(ctx.cwd);
			if (!resolved.ok) {
				disabled = true;
				console.warn(`providerStallWatchdog disabled: ${resolved.error}`);
				ctx.ui.notify(`providerStallWatchdog disabled: ${resolved.error}`, "warning");
				return;
			}
			config = resolved.config;
			activeRun = config.enabled;
		});
		pi.on("before_provider_request", (_event, ctx) => {
			if (!activeRun || ctx.mode !== "tui" || !config) return;
			disarm();
			if (convertedTimeout) continuationStarted = true;
			activeGeneration = ++generation;
			lastSemanticAt = runtime.now();
			ui = ctx.ui;
			const target = ctx.signal;
			if (target) {
				const listener = () => {
					if (watchdogAbortedGeneration !== activeGeneration) disarm();
				};
				target.addEventListener("abort", listener, { once: true });
				removeSignalListener = () => target.removeEventListener("abort", listener);
			}
			schedule(ctx);
		});
		pi.on("message_update", (event, ctx) => {
			const update = event.assistantMessageEvent;
			if (activeGeneration === undefined || !(update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") || update.delta.length === 0) return;
			lastSemanticAt = runtime.now();
			warned = false;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			clearTimers();
			schedule(ctx);
		});
		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const matchesWatchdogAbort = event.message.stopReason === "aborted"
				&& activeGeneration === watchdogAbortedGeneration
				&& timeoutConversionPending
				&& stallRetryConsumed;
			disarm();
			if (!matchesWatchdogAbort || !config) return;
			timeoutConversionPending = false;
			convertedTimeout = true;
			return { message: { ...event.message, stopReason: "error", errorMessage: `Provider semantic timeout after ${config.recoveryMs} ms without progress` } };
		});
		pi.on("agent_end", () => disarm());
		pi.on("agent_settled", () => {
			if (convertedTimeout && !continuationStarted) ui?.notify(DEGRADATION_NOTICE);
			resetRunState();
		});
		pi.on("session_shutdown", () => {
			epoch += 1;
			resetRunState();
			config = undefined;
			disabled = false;
		});
	};
}

export default createProviderStallWatchdog();
