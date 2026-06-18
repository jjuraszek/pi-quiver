/**
 * Session naming.
 *
 * - /session-name [name]  : manually set or show the session name.
 * - Auto-naming           : after the first agent turn, derive a concise name
 *                           from the conversation (unless one is already set).
 * - Ghostty tab rename     : whenever the name changes, rename the current
 *                           Ghostty tab - but only if the active terminal is
 *                           really Ghostty.
 *
 * OFF BY DEFAULT. The automatic behaviors (auto-naming + tab restore on
 * resume) do nothing until explicitly enabled via settings.json. The manual
 * /session-name command always works.
 *
 * Config (settings.json, project overrides global). Defaults shown:
 *   "sessionAutoName": { "enabled": false, "ghosttyTab": true }
 * Boolean shorthand: "sessionAutoName": true  // enables everything
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./extension-config.ts";

type Config = { enabled: boolean; ghosttyTab: boolean };
const DEFAULT_CONFIG: Config = { enabled: false, ghosttyTab: true };

export function coerce(raw: unknown): Partial<Config> | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return { enabled: raw, ghosttyTab: raw };
	if (raw && typeof raw === "object") {
		const o = raw as Record<string, unknown>;
		const out: Partial<Config> = {};
		if (typeof o.enabled === "boolean") out.enabled = o.enabled;
		if (typeof o.ghosttyTab === "boolean") out.ghosttyTab = o.ghosttyTab;
		return out;
	}
	return undefined;
}

function loadConfig(ctx: ExtensionContext): Config {
	return resolveConfig(ctx.cwd, "sessionAutoName", DEFAULT_CONFIG, coerce);
}

type ContentBlock = { type?: string; text?: string };

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const block = part as ContentBlock;
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Skill invocations are stored as `<skill name="x" ...>...16KB body...</skill>`
 * with the user's actual argument appended after the close tag. The boilerplate
 * body is naming poison, so collapse it to `[skill: x] <args>` and keep the args.
 */
export function stripSkillBodies(text: string): string {
	return text.replace(
		/<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g,
		(_m, name) => `[skill: ${name}]`,
	);
}

export function buildConversationText(ctx: ExtensionContext, maxChars = 4000): string {
	const sections: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role === "user" || role === "assistant") {
			const text = stripSkillBodies(extractText(e.message?.content)).replace(/\s+/g, " ").trim();
			if (text.length > 0) sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		} else if (role === "toolResult") {
			// Tool results carry strong signal (e.g. the fetched ticket identifier
			// and title). Include a trimmed snippet.
			const text = extractText(e.message?.content).replace(/\s+/g, " ").trim();
			if (text.length > 0) sections.push(`Result: ${text.slice(0, 400)}`);
		}
	}
	return sections.join("\n\n").slice(0, maxChars);
}

export function isGhosttyActive(
	env: NodeJS.ProcessEnv = process.env,
	isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
	if (!isTTY) return false;
	return (
		env.TERM_PROGRAM === "ghostty" ||
		env.TERM === "xterm-ghostty" ||
		env.GHOSTTY_RESOURCES_DIR != null ||
		env.GHOSTTY_BIN_DIR != null
	);
}

export function toTabLabel(name: string, maxWords = 4): string {
	return name
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, maxWords)
		.join(" ");
}

function renameGhosttyTab(label: string, enabled: boolean): void {
	if (!enabled || !isGhosttyActive()) return;
	// OSC 2: set window/tab title. Ghostty shows this as the tab title and
	// replaces it entirely.
	const clean = label.trim();
	if (clean) process.stdout.write(`\u001b]2;${clean}\u0007`);
}

type GeneratedName = { sessionName: string; tabLabel: string };

/**
 * Parse the model's two-line reply (`SESSION: ...` / `TAB: ...`). Tolerant of
 * surrounding prose, casing, and quotes; caps each field and derives the tab
 * label from the session name when the TAB line is missing. Returns undefined
 * when there is no usable SESSION line.
 */
export function parseGeneratedName(raw: string): GeneratedName | undefined {
	const clean = (s: string) => s.replace(/["']/g, "").replace(/\s+/g, " ").trim();
	const pick = (re: RegExp) => {
		const m = raw.match(re);
		return m ? clean(m[1]) : "";
	};
	const sessionName = pick(/SESSION:\s*(.+)/i).slice(0, 60);
	let tabLabel = pick(/TAB:\s*(.+)/i).slice(0, 30);
	if (!sessionName) return undefined;
	if (!tabLabel) tabLabel = toTabLabel(sessionName);
	return { sessionName, tabLabel: toTabLabel(tabLabel) };
}

async function generateName(ctx: ExtensionContext): Promise<GeneratedName | undefined> {
	const conversation = buildConversationText(ctx);
	if (conversation.length < 8) return undefined;

	const model = ctx.model;
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return undefined;

	const prompt = [
		"Name this work session based on the concrete task being done below.",
		"Reply with EXACTLY two lines:",
		"SESSION: <3-6 word descriptive title>",
		"TAB: <1-4 word terse label, need not be a sentence>",
		"Rules:",
		"- Describe the actual task, NOT the tool/skill/command used to start it.",
		"- Lead with an action verb (e.g. refine, fix, add, rework).",
		"- Preserve ticket/issue IDs (e.g. ABC-123, PROJ-42, #99) verbatim.",
		"- No quotes, no trailing punctuation, plain ASCII.",
		"Example -> SESSION: Refine Linear Ticket ABC-123 / TAB: Refine ABC-123",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const response = await complete(
		model,
		{
			messages: [
				{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "low" },
	);

	const raw = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return parseGeneratedName(raw);
}

export default function (pi: ExtensionAPI) {
	let autoNameTried = false;
	// The session name is the single source of truth; the tab label is derived
	// from it. We remember the name we last reflected and the (possibly curated)
	// label we wrote so turn_start can re-assert it - pi writes its own OS title
	// (OSC 0: `pi - <name> - <cwd>`) on every name change and session
	// replacement, and that writer runs after our session_start handler. A
	// per-turn re-assert wins the race and keeps the tab in sync with the name.
	let lastSyncedName: string | null = null;
	let currentTabLabel: string | null = null;

	// Adopt a name we set ourselves, keeping any curated tab label (auto-naming
	// produces a separate TAB line that need not match the first words of the
	// session name), then write the tab.
	const setName = (cfg: Config, name: string, tabLabel?: string): void => {
		pi.setSessionName(name);
		lastSyncedName = name;
		currentTabLabel = toTabLabel(tabLabel ?? name);
		renameGhosttyTab(currentTabLabel, cfg.ghosttyTab);
	};

	// Re-assert the tab from the current session name. Self-heals when the name
	// changed outside setName (builtin/manual rename we didn't author): the
	// curated label no longer applies, so re-derive from the name.
	const syncTab = (cfg: Config): void => {
		if (!cfg.enabled || !cfg.ghosttyTab) return;
		const name = pi.getSessionName();
		if (!name) return;
		if (name !== lastSyncedName) {
			lastSyncedName = name;
			currentTabLabel = toTabLabel(name);
		}
		if (currentTabLabel) renameGhosttyTab(currentTabLabel, cfg.ghosttyTab);
	};

	pi.registerCommand("session-name", {
		description: "Set or show session name (usage: /session-name [new name])",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (name) {
				autoNameTried = true; // manual name wins; don't auto-overwrite later
				setName(loadConfig(ctx), name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} else {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig(ctx);
		if (!cfg.enabled) return; // off by default; opt in via settings.json
		const current = pi.getSessionName();
		if (current) {
			// A loaded/resumed/reloaded session already carries a name; reflect it.
			// The curated tab label is not persisted, so derive from the name.
			autoNameTried = true;
			lastSyncedName = current;
			currentTabLabel = toTabLabel(current);
			renameGhosttyTab(currentTabLabel, cfg.ghosttyTab);
		} else {
			// Fresh session: clear carryover so a new name re-derives cleanly and
			// auto-naming can run again.
			autoNameTried = false;
			lastSyncedName = null;
			currentTabLabel = null;
		}
	});

	// Re-assert at the start of every turn. This is the only signal we get that
	// fires after pi's own OS-title writer on session replacement, so it keeps
	// the tab pinned to the session name and picks up external renames.
	pi.on("turn_start", async (_event, ctx) => {
		syncTab(loadConfig(ctx));
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (autoNameTried || pi.getSessionName()) return;
		const cfg = loadConfig(ctx);
		if (!cfg.enabled) return; // off by default; opt in via settings.json
		autoNameTried = true;
		try {
			const generated = await generateName(ctx);
			if (generated && !pi.getSessionName()) {
				setName(cfg, generated.sessionName, generated.tabLabel);
				if (ctx.hasUI) ctx.ui.notify(`Auto-named session: ${generated.sessionName}`, "info");
			}
		} catch {
			// best-effort; ignore failures
		}
	});
}
