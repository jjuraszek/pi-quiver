import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
	let config = { ...DEFAULT_CONFIG };

	function refreshFooter(ctx: ExtensionContext) {
		const timestamp = config.footer ? newestMessageTime(ctx.sessionManager.getBranch()) : undefined;
		ctx.ui.setStatus("message-timestamps", timestamp === undefined ? undefined :
			ctx.ui.theme.fg("dim", `last message ${formatTime(new Date(timestamp))}`));
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		config = resolveConfig(ctx.cwd, "messageTimestamps", DEFAULT_CONFIG, coerce, (m) => ctx.ui.notify(m, "warning"));
		refreshFooter(ctx);
	});

	function refresh(_event: unknown, ctx: ExtensionContext) {
		if (ctx.mode === "tui") refreshFooter(ctx);
	}
	pi.on("session_tree", refresh);

	// message_end precedes persistence; these hooks see the time pi actually saved.
	pi.on("message_start", refresh);
	pi.on("context", refresh);
	pi.on("turn_end", refresh);
	pi.on("agent_settled", refresh);
}
