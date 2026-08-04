/**
 * Sword header: replaces the startup logo with a hero's greatsword
 * (Michael J. Penick longsword, asciiart.eu), colored by the active theme:
 * hilt/grip/pommel = accent (rust), blade = text (bright steel). Art is used
 * verbatim; only the coloring is ours, so it tracks whatever theme is active.
 *
 * OFF BY DEFAULT. The header is only installed when explicitly enabled via
 * settings.json. The /builtin-header command always works to restore the
 * built-in pi header at runtime.
 *
 * Config (settings.json, project overrides global). Default shown:
 *   "swordHeader": false
 * Object form also accepted: "swordHeader": { "enabled": true }
 */

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../lib/extension-config.ts";

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

type Seg = [token: ThemeColor, text: string];

// Each line is an array of colored segments. Blade rows split the rust hilt
// prefix from the steel blade at the guard.
export function swordLines(): Seg[][] {
	return [
		[["accent", "                           ___"]],
		[["accent", "                          ( (("]],
		[["accent", "                           ) ))"]],
		[["accent", "  .::.                    / /("]],
		[
			["accent", " 'M .-;-.-.-.-.-.-.-.-.-/| (("],
			["text", "::::::::::::::::::::::::::::::::::::::::::::::.._"],
		],
		[
			["accent", "(J ( ( ( ( ( ( ( ( ( ( ( |  ))"],
			["text", "   -====================================-      _.>"],
		],
		[
			["accent", " `P `-;-`-`-`-`-`-`-`-`-\\| (("],
			["text", "::::::::::::::::::::::::::::::::::::::::::::::''"],
		],
		[["accent", "  `::'                    \\ \\("]],
		[["accent", "                           ) ))"]],
		[["accent", "                          (_(("]],
	];
}

function renderSwordLines(theme: Theme): string[] {
	return swordLines().map((segs) => segs.map(([tok, text]) => theme.fg(tok, text)).join(""));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const cfg = resolveConfig(ctx.cwd, "swordHeader", DEFAULT_CONFIG, coerce);
		if (!cfg.enabled) return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(_width: number): string[] {
				return renderSwordLines(theme);
			},
			invalidate() {},
		}));
	});

	pi.registerCommand("builtin-header", {
		description: "Restore the built-in pi header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
