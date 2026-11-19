import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { resolveConfig } from "../lib/extension-config.ts";

export const DEFAULT_CONFIG = { footer: true, transcript: false };

type Config = typeof DEFAULT_CONFIG;

export function coerce(raw: unknown): Partial<Config> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const patch: Partial<Config> = {};
	if ("footer" in raw && typeof raw.footer === "boolean") patch.footer = raw.footer;
	if ("transcript" in raw && typeof raw.transcript === "boolean") patch.transcript = raw.transcript;
	return patch;
}

export function formatTime(date: Date, locale?: string, timeZone?: string): string {
	return new Intl.DateTimeFormat(locale, {
		month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone,
	}).format(date);
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
	let config = { ...DEFAULT_CONFIG };
	let promptPending = false;

	const recordType = "message-timestamp";
	pi.registerEntryRenderer(recordType, (entry, _options, theme) => config.transcript
		? new Text(theme.fg("dim", formatTime(new Date(entry.timestamp))), 1, 0)
		: undefined);

	function refreshFooter(ctx: ExtensionContext) {
		const timestamp = config.footer ? newestMessageTime(ctx.sessionManager.getBranch()) : undefined;
		ctx.ui.setStatus("message-timestamps", timestamp === undefined ? undefined :
			ctx.ui.theme.fg("dim", `last message ${formatTime(new Date(timestamp))}`));
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		promptPending = false;
		config = resolveConfig(ctx.cwd, "messageTimestamps", DEFAULT_CONFIG, coerce, (m) => ctx.ui.notify(m, "warning"));
		refreshFooter(ctx);
	});

	function refresh(_event: unknown, ctx: ExtensionContext) {
		if (ctx.mode === "tui") refreshFooter(ctx);
	}
	pi.on("session_tree", refresh);

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role === "user") promptPending = config.transcript;
	});

	// message_end precedes persistence. Flush after the prompt's save, before the next sibling or model request.
	function afterMessageSave(_event: unknown, ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (promptPending && config.transcript) pi.appendEntry(recordType);
		promptPending = false;
		refreshFooter(ctx);
	}
	pi.on("message_start", afterMessageSave);
	pi.on("context", afterMessageSave);
	pi.on("turn_end", refresh);
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (config.transcript) pi.appendEntry(recordType);
		refreshFooter(ctx);
	});

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
