import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { resolveConfigFrom } from "../lib/settings-core.ts";

export const DEFAULT_CONFIG = { footer: true, transcript: false };

type Config = typeof DEFAULT_CONFIG;

function coerce(raw: unknown): Partial<Config> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const patch: Partial<Config> = {};
	if ("footer" in raw && typeof raw.footer === "boolean") patch.footer = raw.footer;
	if ("transcript" in raw && typeof raw.transcript === "boolean") patch.transcript = raw.transcript;
	return patch;
}

export function resolveTimestampConfig(settings: ReturnType<ExtensionAPI["getSettings"]>, warn?: (message: string) => void): Config {
	const global = resolveConfigFrom([join(getAgentDir(), "settings.json")], "messageTimestamps", DEFAULT_CONFIG, coerce, warn);
	const { quiver } = settings as { quiver?: { messageTimestamps?: unknown } };
	return { ...global, ...coerce(quiver?.messageTimestamps) };
}

export function formatTime(date: Date): string {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function newestMessageTime(branch: readonly SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" || entry.type === "custom_message") return entry.timestamp;
	}
	return undefined;
}

export function parseArgs(args: string) {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "status" } as const;
	const [target, state, extra] = trimmed.split(/\s+/);
	if (!extra && (target === "footer" || target === "transcript") && (state === "on" || state === "off")) {
		return { kind: "set", target, on: state === "on" } as const;
	}
	return { kind: "usage" } as const;
}

export default function (pi: ExtensionAPI) {
	let config: { footer: boolean; transcript?: boolean } = { footer: DEFAULT_CONFIG.footer };
	let promptPending = false;

	const recordType = "message-timestamp";
	pi.registerEntryRenderer(recordType, (entry, _options, theme) => {
		if (config.transcript === undefined) {
			// Reload and session replacement bind the destination's core settings before replay, but emit session_start after it.
			config = resolveTimestampConfig(pi.getSettings());
		}
		return config.transcript ? new Text(theme.fg("dim", formatTime(new Date(entry.timestamp))), 1, 0) : undefined;
	});

	function refreshFooter(ctx: ExtensionContext) {
		const timestamp = config.footer ? newestMessageTime(ctx.sessionManager.getBranch()) : undefined;
		ctx.ui.setStatus("message-timestamps", timestamp === undefined ? undefined :
			ctx.ui.theme.fg("dim", formatTime(new Date(timestamp))));
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		promptPending = false;
		config = resolveTimestampConfig(pi.getSettings(), (m) => ctx.ui.notify(m, "warning"));
		refreshFooter(ctx);
	});

	function refresh(_event: unknown, ctx: ExtensionContext) {
		if (ctx.mode === "tui") refreshFooter(ctx);
	}
	pi.on("session_tree", refresh);

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role === "user") promptPending = config.transcript === true;
	});

	// message_end precedes persistence. Flush after the prompt's save, before the next sibling or model request.
	function flushPromptRecord(_event: unknown, ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (promptPending && config.transcript) pi.appendEntry(recordType);
		promptPending = false;
	}
	pi.on("message_start", flushPromptRecord);
	pi.on("context", flushPromptRecord);
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (config.transcript) pi.appendEntry(recordType);
	});

	pi.on("message_start", refresh);
	pi.on("context", refresh);
	pi.on("tool_execution_start", refresh);
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);

	pi.registerCommand("timestamps", {
		description: "Show or toggle footer and transcript timestamps",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const parsed = parseArgs(args);
			if (parsed.kind === "usage") {
				ctx.ui.notify("Usage: /timestamps [footer|transcript] [on|off]", "warning");
				return;
			}
			if (parsed.kind === "set") {
				config[parsed.target] = parsed.on;
				if (parsed.target === "footer") refreshFooter(ctx);
			}
			ctx.ui.notify(`Message timestamps: footer ${config.footer ? "on" : "off"}, transcript ${config.transcript ? "on" : "off"}`, "info");
		},
	});
}
