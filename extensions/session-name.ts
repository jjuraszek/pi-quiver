/**
 * Session naming.
 *
 * - /session-name [name]  : manually set or show the session name.
 * - Auto-naming           : after the first agent turn, derive a concise name
 *                           from the conversation (unless one is already set).
 * - Revisiting            : re-derive the name later in a long session, once
 *                           the work has revealed what it actually is.
 * - Deny list             : keep chosen words out of every name, whatever set
 *                           it - the model, /session-name, or pi's builtin.
 * - Ghostty tab rename     : whenever the name changes, rename the current
 *                           Ghostty tab - but only if the active terminal is
 *                           really Ghostty.
 *
 * OFF BY DEFAULT. The automatic behaviors (auto-naming + tab restore on
 * resume) do nothing until explicitly enabled via settings.json. The manual
 * /session-name command always works.
 *
 * Config (settings.json, project overrides global). Defaults shown:
 *   "sessionAutoName": {
 *     "enabled": false,
 *     "ghosttyTab": true,
 *     "rules": [],              // extra naming rules appended to the prompt
 *     "deny": [],               // phrases stripped from any name
 *     "revisitFirstTurn": 0,    // re-derive once at this round trip (0 = off)
 *     "revisitEveryTurns": 0    // and at every multiple of this (0 = off)
 *   }
 * Boolean shorthand: "sessionAutoName": true  // enables naming + tab sync
 *
 * Revisiting is opt-in and costs one short LLM call each time it fires, so
 * both cadence knobs default to 0. `revisitFirstTurn: 10` with
 * `revisitEveryTurns: 100` fires at round trips 10, 100, 200, 300 - early
 * once, because the first turn rarely knows what the session is, then rarely.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../lib/extension-config.ts";

// `complete` moved between pi-ai layouts: older builds re-export it from the
// package index, newer ones expose it only via the `/compat` subpath. A static
// import that targets one breaks at load time on the other (and a missing
// export aborts the whole extension, killing the manual command too). Resolve
// it lazily at call time, trying the index first then `/compat`.
type CompleteFn = typeof import("@earendil-works/pi-ai/compat").complete;

async function loadComplete(): Promise<CompleteFn> {
	const index = (await import("@earendil-works/pi-ai")) as Record<string, unknown>;
	if (typeof index.complete === "function") return index.complete as CompleteFn;
	return (await import("@earendil-works/pi-ai/compat")).complete;
}

type Config = {
	enabled: boolean;
	ghosttyTab: boolean;
	rules: string[];
	deny: string[];
	revisitFirstTurn: number;
	revisitEveryTurns: number;
};
const DEFAULT_CONFIG: Config = {
	enabled: false,
	ghosttyTab: true,
	rules: [],
	deny: [],
	revisitFirstTurn: 0,
	revisitEveryTurns: 0,
};

const stringList = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((s) => typeof s === "string")
		? v.map((s) => s.trim()).filter(Boolean)
		: undefined;

const turnCount = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;

export function coerce(raw: unknown): Partial<Config> | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return { enabled: raw, ghosttyTab: raw };
	if (raw && typeof raw === "object") {
		const o = raw as Record<string, unknown>;
		const out: Partial<Config> = {};
		if (typeof o.enabled === "boolean") out.enabled = o.enabled;
		if (typeof o.ghosttyTab === "boolean") out.ghosttyTab = o.ghosttyTab;
		const rules = stringList(o.rules);
		if (rules) out.rules = rules;
		const deny = stringList(o.deny);
		if (deny) out.deny = deny;
		const first = turnCount(o.revisitFirstTurn);
		if (first !== undefined) out.revisitFirstTurn = first;
		const every = turnCount(o.revisitEveryTurns);
		if (every !== undefined) out.revisitEveryTurns = every;
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

export function buildConversationText(
	ctx: ExtensionContext,
	maxChars = 4000,
	mostRecent = false,
): string {
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
	const conversation = sections.join("\n\n");
	return mostRecent ? conversation.slice(-maxChars) : conversation.slice(0, maxChars);
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

/**
 * Compile a deny phrase to a matcher. Phrases are literal, not regex: metachars
 * are escaped so a user can't crash naming with a bad pattern from settings.
 * Interior whitespace matches loosely, so one entry covers the spaced and
 * jammed spellings alike (`acme corp` catches `AcmeCorp` and `Acme  Corp`).
 * Word boundaries are added only where the phrase itself starts/ends on a word
 * character, since `\b` next to punctuation asserts the opposite of what a
 * reader expects.
 */
function denyMatcher(phrase: string): RegExp | undefined {
	const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (!escaped) return undefined;
	const body = escaped.replace(/\s+/g, "\\s*");
	const trimmed = phrase.trim();
	const word = /[\p{L}\p{N}_]/u;
	const lead = word.test(trimmed[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
	const tail = word.test(trimmed.at(-1) ?? "") ? "(?![\\p{L}\\p{N}_])" : "";
	return new RegExp(`${lead}${body}${tail}`, "giu");
}

/**
 * Strip every deny phrase from a name and tidy the seam left behind: doubled
 * spaces, brackets emptied by the removal, and separators stranded against each
 * other. Structure the author intended is preserved - dropping the middle of
 * `Fix - Acme - login` leaves `Fix - login`, not `Fix login`.
 *
 * Returns `Session` when stripping would empty the name. A generic fallback is
 * less informative, but unlike either a blank or the original it actually
 * honors the deny-list contract.
 */
export function applyDenyList(name: string, deny: string[]): string {
	if (deny.length === 0) return name;
	let out = name;
	for (const phrase of deny) {
		const re = denyMatcher(phrase);
		if (re) out = out.replace(re, " ");
	}
	out = out
		.replace(/\s+/g, " ")
		.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "")
		.replace(/([-:|/])(?:\s*[-:|/])+/g, "$1")
		.replace(/^[\s\-:|/]+|[\s\-:|/]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return out || "Session";
}

/**
 * Whether a revisit point lies in `(prev, n]`. Points are `revisitFirstTurn`
 * once, then every multiple of `revisitEveryTurns` - so 10/100 gives 10, 100,
 * 200. Interval semantics rather than exact-hit because the check only runs
 * when the agent settles: a 30-round-trip automated run never stops exactly on
 * round trip 10, but it does cross it. Either knob at 0 disables its own
 * trigger.
 */
export function shouldRevisit(
	prev: number,
	n: number,
	cfg: { revisitFirstTurn: number; revisitEveryTurns: number },
): boolean {
	if (n <= 0 || n <= prev) return false;
	const from = Math.max(prev, 0);
	if (cfg.revisitFirstTurn > 0 && from < cfg.revisitFirstTurn && n >= cfg.revisitFirstTurn) {
		return true;
	}
	return (
		cfg.revisitEveryTurns > 0 &&
		Math.floor(n / cfg.revisitEveryTurns) > Math.floor(from / cfg.revisitEveryTurns)
	);
}

/**
 * Assistant messages so far, i.e. completed model round trips. Derived from the
 * transcript rather than tallied in memory so a resumed session keeps counting
 * where it left off instead of restarting the revisit cadence.
 */
export function countRoundTrips(ctx: ExtensionContext): number {
	let n = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; message?: { role?: string } };
		if (e.type === "message" && e.message?.role === "assistant") n++;
	}
	return n;
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

/**
 * A revisit may conclude the existing name still fits, which is the common case
 * and must not cost a rename.
 */
export const KEEP = "keep" as const;

/**
 * Parse a revisit reply: either the KEEP verdict or a fresh two-line name.
 * Checked before {@link parseGeneratedName} because a KEEP reply has no SESSION
 * line and would otherwise be indistinguishable from a failed generation.
 */
export function parseRevisitReply(raw: string): typeof KEEP | GeneratedName | undefined {
	if (/^\W*KEEP\W*$/i.test(raw.trim())) return KEEP;
	return parseGeneratedName(raw);
}

type NameAuthor = "auto" | "human";
type NameAuthorEntry = { name: string; author: NameAuthor };
const NAME_AUTHOR_ENTRY = "pi-quiver.session-name-author";

type PromptOptions = { rules?: string[]; currentName?: string };

/**
 * Build the naming prompt. With `currentName` set this is a revisit: the model
 * is told what the session is already called and given the option to keep it,
 * because a long session usually earns its name early and churning it on every
 * revisit would be worse than not revisiting at all.
 *
 * User `rules` land after the built-in ones so they win on conflict - that is
 * the point of exposing them, since house naming conventions routinely
 * contradict a general-purpose default.
 */
export function buildNamingPrompt(conversation: string, opts: PromptOptions = {}): string {
	const { rules = [], currentName } = opts;
	const lines = [
		"Name this work session based on the concrete task being done below.",
		"Reply with EXACTLY two lines:",
		"SESSION: <3-6 word descriptive title>",
		"TAB: <1-4 word terse label, need not be a sentence>",
		"Rules:",
		"- Describe the actual task, NOT the tool/skill/command used to start it.",
		"- Lead with an action verb (e.g. refine, fix, add, rework).",
		"- Preserve ticket/issue IDs (e.g. ABC-123, PROJ-42, #99) verbatim.",
		"- No quotes, no trailing punctuation, plain ASCII.",
		...rules.map((r) => `- ${r}`),
		"Example -> SESSION: Refine Linear Ticket ABC-123 / TAB: Refine ABC-123",
	];
	if (currentName) {
		lines.push(
			"",
			`This session is already named: ${currentName}`,
			"That name may have been chosen by a human, so prefer keeping it.",
			"Reply with the single word KEEP if it still describes the work below,",
			"even loosely. Only propose a new name if the session has clearly moved",
			"on to different work, or the rules above are now plainly violated.",
		);
	}
	lines.push("", "<conversation>", conversation, "</conversation>");
	return lines.join("\n");
}

// Copilot business/enterprise credentials pin requests to an account-specific
// endpoint reported by getApiKeyAndHeaders as auth.baseUrl; the catalog model
// still carries the individual endpoint, and hitting it with such a token
// fails with 421 Misdirected Request. Mirror pi's own request path: prefer the
// credential's endpoint when present.
export function withAuthBaseUrl<M extends { baseUrl: string }>(
	model: M,
	auth: { baseUrl?: string },
): M {
	return auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
}

async function generateName(
	ctx: ExtensionContext,
	opts: PromptOptions = {},
): Promise<typeof KEEP | GeneratedName | undefined> {
	const conversation = buildConversationText(ctx, 4000, Boolean(opts.currentName));
	if (conversation.length < 8) return undefined;

	const model = ctx.model;
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	// ok=true with apiKey=undefined is the env-key path: the key lives in
	// process.env (e.g. ANTHROPIC_API_KEY), not auth.json. getApiKeyAndHeaders
	// deliberately opts out of the env fallback (includeFallback: false), so it
	// reports no apiKey. Don't bail on that - complete() resolves the env key
	// itself via withEnvApiKey/getEnvApiKey. Only bail when auth genuinely failed.
	if (!auth?.ok) return undefined;

	const prompt = buildNamingPrompt(conversation, opts);

	const complete = await loadComplete();
	const response = await complete(
		withAuthBaseUrl(model, auth),
		{
			messages: [
				{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, reasoningEffort: "low" },
	);

	const raw = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	return opts.currentName ? parseRevisitReply(raw) : parseGeneratedName(raw);
}

type NameGenerator = (
	ctx: ExtensionContext,
	opts?: PromptOptions,
) => Promise<typeof KEEP | GeneratedName | undefined>;

export function installSessionName(pi: ExtensionAPI, generate: NameGenerator = generateName) {
	let autoNameTried = false;
	// Who chose the current name. A human's wording is never overwritten by a
	// revisit - at most we suggest - so unknown provenance (a resumed session, a
	// rename from outside this extension) is treated as human.
	let nameAuthor: NameAuthor = "human";
	// Round trips already acted on; the next check covers (lastRevisitAt, n].
	let lastRevisitAt = 0;
	let revisitInFlight = false;
	// Last detached revisit, exposed so tests (and a curious host) can await
	// completion of work that deliberately outlives the agent_settled handler.
	let revisitDone: Promise<void> = Promise.resolve();
	// The next name-change event expected from our own write. Tracking the value
	// rather than a synchronous flag also covers hosts that emit the event later.
	let expectedInternalName: string | null = null;
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
	const recordNameAuthor = (name: string, author: NameAuthor): void => {
		nameAuthor = author;
		pi.appendEntry<NameAuthorEntry>(NAME_AUTHOR_ENTRY, { name, author });
	};

	const restoredNameAuthor = (ctx: ExtensionContext, name: string): NameAuthor => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as {
				type?: string;
				customType?: string;
				data?: Partial<NameAuthorEntry>;
			};
			if (entry.type !== "custom" || entry.customType !== NAME_AUTHOR_ENTRY) continue;
			if (entry.data?.name === name && (entry.data.author === "auto" || entry.data.author === "human")) {
				return entry.data.author;
			}
			break;
		}
		return "human";
	};

	const setName = (
		cfg: Config,
		name: string,
		tabLabel?: string,
		author?: NameAuthor,
	): void => {
		const clean = applyDenyList(name, cfg.deny);
		if (author) recordNameAuthor(clean, author);
		expectedInternalName = clean;
		pi.setSessionName(clean);
		lastSyncedName = clean;
		currentTabLabel = toTabLabel(applyDenyList(tabLabel ?? clean, cfg.deny));
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
				setName(loadConfig(ctx), name, undefined, "human");
				ctx.ui.notify(`Session named: ${pi.getSessionName()}`, "info");
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
			nameAuthor = restoredNameAuthor(ctx, current);
			setName(cfg, current);
		} else {
			// Fresh session: clear carryover so a new name re-derives cleanly and
			// auto-naming can run again.
			autoNameTried = false;
			nameAuthor = "human";
			lastSyncedName = null;
			currentTabLabel = null;
		}
		lastRevisitAt = countRoundTrips(ctx);
	});

	// The deny gate. setName cleans everything this extension writes, but pi's
	// builtin rename and any other extension bypass it, so re-clean whatever the
	// name ends up as. session_info_changed cannot veto a change - it only
	// reports one - so the correction is a second write, guarded against the
	// echo of our own.
	pi.on("session_info_changed", async (_event, ctx) => {
		const current = pi.getSessionName();
		if (current === expectedInternalName) {
			expectedInternalName = null;
			return;
		}
		expectedInternalName = null;
		if (!current) return;
		const cfg = loadConfig(ctx);
		if (!cfg.enabled) return;
		recordNameAuthor(current, "human");
		if (cfg.deny.length === 0) return;
		const clean = applyDenyList(current, cfg.deny);
		if (clean !== current) setName(cfg, clean, undefined, "human");
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
			const generated = await generate(ctx, { rules: cfg.rules });
			if (generated && generated !== KEEP && !pi.getSessionName()) {
				setName(cfg, generated.sessionName, generated.tabLabel, "auto");
				if (ctx.hasUI) ctx.ui.notify(`Auto-named session: ${pi.getSessionName()}`, "info");
			}
		} catch {
			// best-effort; ignore failures
		}
	});

	// Revisit. A name derived from the first turn describes the opening move,
	// which is frequently not what the session turns out to be about - the work
	// only reveals itself after the agent has been at it a while. Re-deriving at
	// a couple of points catches that drift.
	//
	// agent_settled, not turn_end: it fires only once the run is fully idle (no
	// retry, compaction, or queued continuation pending), so an automated
	// multi-turn workflow - a subagent chain, a gauntlet phase - is never
	// renamed mid-flight and never waits on a naming call. Cadence points the
	// run crossed fire once, at the settle. The LLM call still runs detached so
	// the freed-up UI is not held hostage by a slow provider.
	pi.on("agent_settled", (_event, ctx) => {
		if (revisitInFlight) return;
		const cfg = loadConfig(ctx);
		if (!cfg.enabled) return;
		if (cfg.revisitFirstTurn === 0 && cfg.revisitEveryTurns === 0) return;
		const current = pi.getSessionName();
		if (!current) return; // unnamed; auto-naming owns that case
		const n = countRoundTrips(ctx);
		if (!shouldRevisit(lastRevisitAt, n, cfg)) return;
		lastRevisitAt = n;
		revisitInFlight = true;
		revisitDone = (async () => {
			try {
				const result = await generate(ctx, { rules: cfg.rules, currentName: current });
				if (!result || result === KEEP) return;
				if (pi.getSessionName() !== current) return; // renamed under us mid-call
				if (nameAuthor === "auto") {
					setName(cfg, result.sessionName, result.tabLabel, "auto");
					if (ctx.hasUI) ctx.ui.notify(`Renamed session: ${pi.getSessionName()}`, "info");
				} else if (ctx.hasUI) {
					// Human wording is theirs to change; surface the drift and stop.
					const suggestion = applyDenyList(result.sessionName, cfg.deny);
					ctx.ui.notify(
						`Session name looks stale. Suggested: ${suggestion} - /session-name to apply`,
						"info",
					);
				}
			} catch {
				// best-effort; ignore failures
			} finally {
				revisitInFlight = false;
			}
		})();
	});

	return { revisitSettled: () => revisitDone };
}

export default function (pi: ExtensionAPI) {
	installSessionName(pi);
}
