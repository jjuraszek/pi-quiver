import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	coerce,
	toTabLabel,
	stripSkillBodies,
	buildConversationText,
	isGhosttyActive,
	parseGeneratedName,
	applyDenyList,
	shouldRevisit,
	countRoundTrips,
	buildNamingPrompt,
	parseRevisitReply,
	installSessionName,
	KEEP,
	withAuthBaseUrl,
} from "../extensions/session-name.ts";

test("stripSkillBodies: collapses skill body to [skill: name], preserves trailing args", () => {
	const body = "x".repeat(16_000);
	const text = `<skill name="brainstorming" foo="bar">${body}</skill> refine ticket ABC-123`;
	const out = stripSkillBodies(text);
	assert.equal(out, "[skill: brainstorming] refine ticket ABC-123");
	assert.ok(!out.includes("xxxx"), "skill body must be gone");
});

test("stripSkillBodies: handles multiple skill blocks", () => {
	const text = `<skill name="a">aaa</skill> mid <skill name="b">bbb</skill> end`;
	assert.equal(stripSkillBodies(text), "[skill: a] mid [skill: b] end");
});

test("stripSkillBodies: text without skill tags is untouched", () => {
	assert.equal(stripSkillBodies("plain user text"), "plain user text");
});

test("buildConversationText: initial naming uses the opening context", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "opening task" } },
		{ type: "message", message: { role: "assistant", content: "later discovery" } },
	];
	const ctx = { sessionManager: { getEntries: () => entries } };
	assert.equal(buildConversationText(ctx as never, 18), "User: opening task");
});

test("buildConversationText: revisiting uses the most recent context", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "opening task" } },
		{ type: "message", message: { role: "assistant", content: "later discovery" } },
	];
	const ctx = { sessionManager: { getEntries: () => entries } };
	assert.equal(buildConversationText(ctx as never, 26, true), "Assistant: later discovery");
});

test("toTabLabel: caps to maxWords (default 4)", () => {
	assert.equal(toTabLabel("one two three four five six"), "one two three four");
	assert.equal(toTabLabel("alpha beta", 1), "alpha");
	assert.equal(toTabLabel("just three words here", 10), "just three words here");
});

test("toTabLabel: strips control chars and collapses whitespace", () => {
	assert.equal(toTabLabel("refine\tABC-123\n\nticket"), "refine ABC-123 ticket");
	assert.equal(toTabLabel("  padded   words  "), "padded words");
});

test("coerce: boolean shorthand enables/disables everything", () => {
	assert.deepEqual(coerce(true), { enabled: true, ghosttyTab: true });
	assert.deepEqual(coerce(false), { enabled: false, ghosttyTab: false });
});

test("coerce: rules/deny accept string arrays, trimmed and de-blanked", () => {
	assert.deepEqual(coerce({ deny: ["acme corp", "  spaced  ", ""] }), {
		deny: ["acme corp", "spaced"],
	});
	assert.deepEqual(coerce({ rules: ["Lead with the ticket id"] }), {
		rules: ["Lead with the ticket id"],
	});
});

test("coerce: rules/deny reject non-string members wholesale", () => {
	assert.deepEqual(coerce({ deny: ["ok", 42] }), {});
	assert.deepEqual(coerce({ rules: "not an array" }), {});
});

test("coerce: revisit knobs accept non-negative integers only", () => {
	assert.deepEqual(coerce({ revisitFirstTurn: 10, revisitEveryTurns: 100 }), {
		revisitFirstTurn: 10,
		revisitEveryTurns: 100,
	});
	assert.deepEqual(coerce({ revisitFirstTurn: 0 }), { revisitFirstTurn: 0 });
	assert.deepEqual(coerce({ revisitFirstTurn: -1, revisitEveryTurns: 1.5 }), {});
	assert.deepEqual(coerce({ revisitEveryTurns: "100" }), {});
});

test("applyDenyList: no patterns is a passthrough", () => {
	assert.equal(applyDenyList("Fix AcmeCorp login bug", []), "Fix AcmeCorp login bug");
});

test("applyDenyList: one phrase catches spaced, jammed, and cased spellings", () => {
	const deny = ["acme corp"];
	assert.equal(applyDenyList("Fix AcmeCorp login bug", deny), "Fix login bug");
	assert.equal(applyDenyList("Fix Acme Corp login bug", deny), "Fix login bug");
	assert.equal(applyDenyList("Fix ACME  CORP login bug", deny), "Fix login bug");
});

test("applyDenyList: respects word boundaries", () => {
	assert.equal(applyDenyList("Fix acmecorporate parser", ["acme corp"]), "Fix acmecorporate parser");
	assert.equal(applyDenyList("Fix supracme corp parser", ["acme corp"]), "Fix supracme corp parser");
});

test("applyDenyList: tidies the seam left behind", () => {
	assert.equal(applyDenyList("Acme Corp - login bug", ["acme corp"]), "login bug");
	assert.equal(applyDenyList("Fix - Acme Corp - login", ["acme corp"]), "Fix - login");
	assert.equal(applyDenyList("login bug (Acme Corp)", ["acme corp"]), "login bug");
});

test("applyDenyList: regex metacharacters are literal, not patterns", () => {
	assert.equal(applyDenyList("Fix a.b.c parser", ["a.b.c"]), "Fix parser");
	assert.equal(applyDenyList("Fix axbxc parser", ["a.b.c"]), "Fix axbxc parser");
	assert.equal(applyDenyList("Fix parser", ["(unclosed"]), "Fix parser");
});

test("applyDenyList: uses a safe fallback when stripping would empty it", () => {
	assert.equal(applyDenyList("Acme Corp", ["acme corp"]), "Session");
	assert.equal(applyDenyList("  Acme Corp  ", ["acme corp"]), "Session");
});

test("applyDenyList: Unicode letters get real word boundaries", () => {
	assert.equal(applyDenyList("Fix café parser", ["café"]), "Fix parser");
	assert.equal(applyDenyList("Fix cafés parser", ["café"]), "Fix cafés parser");
});

test("applyDenyList: applies every phrase", () => {
	assert.equal(applyDenyList("Fix Acme Foo login", ["acme", "foo"]), "Fix login");
});

test("shouldRevisit: fires when the first turn, then each multiple, is crossed", () => {
	const cfg = { revisitFirstTurn: 10, revisitEveryTurns: 100 };
	assert.deepEqual(
		[1, 9, 10, 11, 99, 100, 101, 200, 300].map((n) => shouldRevisit(n - 1, n, cfg)),
		[false, false, true, false, false, true, false, true, true],
	);
});

test("shouldRevisit: a multi-turn run that jumps past a cadence point still fires", () => {
	const cfg = { revisitFirstTurn: 10, revisitEveryTurns: 100 };
	assert.equal(shouldRevisit(3, 37, cfg), true, "crossed firstTurn=10 inside one run");
	assert.equal(shouldRevisit(37, 143, cfg), true, "crossed every=100 inside one run");
	assert.equal(shouldRevisit(11, 99, cfg), false, "no point inside (11, 99]");
	assert.equal(shouldRevisit(100, 199, cfg), false, "no point inside (100, 199]");
	assert.equal(shouldRevisit(99, 300, cfg), true, "multiple points collapse to one fire");
});

test("shouldRevisit: either knob at 0 disables only its own trigger", () => {
	assert.equal(shouldRevisit(9, 10, { revisitFirstTurn: 0, revisitEveryTurns: 100 }), false);
	assert.equal(shouldRevisit(99, 100, { revisitFirstTurn: 0, revisitEveryTurns: 100 }), true);
	assert.equal(shouldRevisit(9, 10, { revisitFirstTurn: 10, revisitEveryTurns: 0 }), true);
	assert.equal(shouldRevisit(99, 100, { revisitFirstTurn: 10, revisitEveryTurns: 0 }), false);
});

test("shouldRevisit: never fires at or below zero round trips, nor going backwards", () => {
	const cfg = { revisitFirstTurn: 10, revisitEveryTurns: 100 };
	assert.equal(shouldRevisit(-1, 0, cfg), false);
	assert.equal(shouldRevisit(-6, -5, cfg), false);
	assert.equal(shouldRevisit(100, 100, cfg), false);
	assert.equal(shouldRevisit(200, 100, cfg), false);
});

test("countRoundTrips: counts assistant messages only", () => {
	const entries = [
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant" } },
		{ type: "message", message: { role: "toolResult" } },
		{ type: "message", message: { role: "assistant" } },
		{ type: "summary", message: { role: "assistant" } },
	];
	const ctx = { sessionManager: { getEntries: () => entries } };
	assert.equal(countRoundTrips(ctx as never), 2);
});

test("countRoundTrips: empty transcript is zero", () => {
	const ctx = { sessionManager: { getEntries: () => [] } };
	assert.equal(countRoundTrips(ctx as never), 0);
});

test("buildNamingPrompt: user rules land after the built-ins so they win", () => {
	const prompt = buildNamingPrompt("User: hi", { rules: ["Never lead with a verb"] });
	const builtIn = prompt.indexOf("- Lead with an action verb");
	const custom = prompt.indexOf("- Never lead with a verb");
	assert.ok(builtIn > -1 && custom > builtIn, "custom rule must follow the built-in it overrides");
});

test("buildNamingPrompt: no current name means no KEEP option offered", () => {
	const prompt = buildNamingPrompt("User: hi");
	assert.ok(!prompt.includes("KEEP"));
	assert.ok(prompt.includes("<conversation>\nUser: hi\n</conversation>"));
});

test("buildNamingPrompt: a current name turns it into a revisit", () => {
	const prompt = buildNamingPrompt("User: hi", { currentName: "Refine ABC-123" });
	assert.ok(prompt.includes("This session is already named: Refine ABC-123"));
	assert.ok(prompt.includes("KEEP"));
});

test("parseRevisitReply: KEEP verdict, tolerant of casing and punctuation", () => {
	assert.equal(parseRevisitReply("KEEP"), KEEP);
	assert.equal(parseRevisitReply("  keep  "), KEEP);
	assert.equal(parseRevisitReply("*KEEP*"), KEEP);
});

test("parseRevisitReply: KEEP on one line does not swallow a proposed name", () => {
	assert.deepEqual(
		parseRevisitReply("I considered KEEP.\nSESSION: Rename stale session\nTAB: Rename Session"),
		{ sessionName: "Rename stale session", tabLabel: "Rename Session" },
	);
});

test("parseRevisitReply: a real name still parses", () => {
	assert.deepEqual(parseRevisitReply("SESSION: Add fetch retry\nTAB: Fetch Retry"), {
		sessionName: "Add fetch retry",
		tabLabel: "Fetch Retry",
	});
});

test("parseRevisitReply: unparseable reply is undefined, not a rename", () => {
	assert.equal(parseRevisitReply("I am not sure what to do here"), undefined);
});

test("parseRevisitReply: a name merely mentioning keep is not a KEEP verdict", () => {
	assert.deepEqual(parseRevisitReply("SESSION: Keep alive probe fix\nTAB: Keepalive"), {
		sessionName: "Keep alive probe fix",
		tabLabel: "Keepalive",
	});
});

type Hook = (event: any, ctx: any) => Promise<void>;

function extensionHarness(generated: Array<typeof KEEP | { sessionName: string; tabLabel: string }>) {
	const cwd = mkdtempSync(join(tmpdir(), "session-name-test-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			sessionAutoName: {
				enabled: true,
				ghosttyTab: false,
				rules: ["Lead with the ticket id"],
				deny: ["grid strong"],
				revisitFirstTurn: 10,
				revisitEveryTurns: 100,
			},
		}),
	);
	const hooks = new Map<string, Hook>();
	const entries: any[] = [];
	const notifications: string[] = [];
	let name: string | undefined;
	const pi: any = {
		on: (event: string, hook: Hook) => hooks.set(event, hook),
		registerCommand: () => {},
		setSessionName: (next: string) => { name = next; },
		getSessionName: () => name,
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ type: "custom", customType, data });
		},
	};
	const ctx: any = {
		cwd,
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getEntries: () => entries },
	};
	const generate = async () => generated.shift();
	const installed = installSessionName(pi, generate);
	// agent_settled fires the revisit detached so it never holds anything up;
	// tests drive the hook then await settlement explicitly.
	const runAgentSettled = async (currentInstalled = installed) => {
		await hooks.get("agent_settled")!({}, ctx);
		await currentInstalled.revisitSettled();
	};
	return {
		ctx,
		entries,
		hooks,
		notifications,
		runAgentSettled,
		getName: () => name,
		setExternalName: (next: string) => { name = next; },
		destroy: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function addRoundTrips(entries: any[], count: number): void {
	const current = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
	for (let n = current; n < count; n++) {
		entries.push({ type: "message", message: { role: "assistant", content: `turn ${n + 1}` } });
	}
}

test("installed extension: auto names revisit silently and retain provenance across resume", async () => {
	const h = extensionHarness([
		{ sessionName: "GridStrong setup", tabLabel: "GridStrong" },
		{ sessionName: "E-42 naming rules", tabLabel: "E-42 names" },
		{ sessionName: "E-42 mature context", tabLabel: "E-42 context" },
	]);
	try {
		await h.hooks.get("session_start")!({}, h.ctx);
		await h.hooks.get("agent_end")!({}, h.ctx);
		assert.equal(h.getName(), "setup", "deny list cleans the initial auto name");

		addRoundTrips(h.entries, 10);
		await h.runAgentSettled();
		assert.equal(h.getName(), "E-42 naming rules");

		// A new extension instance models process/session resume. Persisted
		// provenance keeps this machine-authored, so round trip 100 may replace it.
		const resumed = installSessionName(
			{
				on: (event: string, hook: Hook) => h.hooks.set(event, hook),
				registerCommand: () => {},
				setSessionName: (next: string) => h.setExternalName(next),
				getSessionName: h.getName,
				appendEntry: (customType: string, data: unknown) => {
					h.entries.push({ type: "custom", customType, data });
				},
			} as never,
			async () => ({ sessionName: "E-42 mature context", tabLabel: "E-42 context" }),
		);
		await h.hooks.get("session_start")!({}, h.ctx);
		addRoundTrips(h.entries, 100);
		await h.runAgentSettled(resumed);
		assert.equal(h.getName(), "E-42 mature context");
	} finally {
		h.destroy();
	}
});

test("installed extension: agent_settled returns before the revisit LLM call resolves", async () => {
	const h = extensionHarness([]);
	try {
		await h.hooks.get("session_start")!({}, h.ctx);
		h.setExternalName("E-42 naming rules");
		addRoundTrips(h.entries, 10);
		// The empty harness queue makes generate resolve undefined, but the
		// property under test is the handler itself: it must complete without
		// waiting on the generate promise, so a slow provider call never holds
		// up whatever the host does after the agent settles.
		const settled = h.hooks.get("agent_settled")!({}, h.ctx);
		assert.equal(settled, undefined, "handler is synchronous; revisit runs detached");
	} finally {
		h.destroy();
	}
});

test("installed extension: external human names are cleaned but only get stale suggestions", async () => {
	const h = extensionHarness([{ sessionName: "E-42 mature context", tabLabel: "E-42 context" }]);
	try {
		h.setExternalName("Human GridStrong Work");
		await h.hooks.get("session_info_changed")!({}, h.ctx);
		assert.equal(h.getName(), "Human Work");

		addRoundTrips(h.entries, 10);
		await h.runAgentSettled();
		assert.equal(h.getName(), "Human Work", "human wording is never overwritten");
		assert.deepEqual(h.notifications, [
			"Session name looks stale. Suggested: E-42 mature context - /session-name to apply",
		]);
	} finally {
		h.destroy();
	}
});

test("coerce: partial object only carries the keys present", () => {
	assert.deepEqual(coerce({ enabled: true }), { enabled: true });
	assert.deepEqual(coerce({ ghosttyTab: false }), { ghosttyTab: false });
	assert.deepEqual(coerce({ enabled: true, ghosttyTab: false }), { enabled: true, ghosttyTab: false });
});

test("coerce: ignores non-boolean fields and unknown keys", () => {
	assert.deepEqual(coerce({ enabled: "yes", ghosttyTab: 1, other: true }), {});
});

test("coerce: invalid / absent inputs return undefined", () => {
	assert.equal(coerce(undefined), undefined);
	assert.equal(coerce("true"), undefined);
	assert.equal(coerce(42), undefined);
	assert.equal(coerce(null), undefined);
});

test("isGhosttyActive: false when not a TTY regardless of env", () => {
	assert.equal(isGhosttyActive({ TERM_PROGRAM: "ghostty" }, false), false);
});

test("isGhosttyActive: env matrix (TTY on)", () => {
	assert.equal(isGhosttyActive({ TERM_PROGRAM: "ghostty" }, true), true);
	assert.equal(isGhosttyActive({ TERM: "xterm-ghostty" }, true), true);
	assert.equal(isGhosttyActive({ GHOSTTY_RESOURCES_DIR: "/x" }, true), true);
	assert.equal(isGhosttyActive({ GHOSTTY_BIN_DIR: "/x" }, true), true);
	assert.equal(isGhosttyActive({ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" }, true), false);
	assert.equal(isGhosttyActive({}, true), false);
});

test("parseGeneratedName: two-line reply → session name + tab label", () => {
	const got = parseGeneratedName("SESSION: Refine Linear Ticket ABC-123\nTAB: Refine ABC-123");
	assert.deepEqual(got, { sessionName: "Refine Linear Ticket ABC-123", tabLabel: "Refine ABC-123" });
});

test("parseGeneratedName: tolerant of casing, quotes, and surrounding prose", () => {
	const raw = `Here is your answer:\nsession: "Add fetch retry logic"\ntab: 'Fetch Retry'\nThanks!`;
	assert.deepEqual(parseGeneratedName(raw), { sessionName: "Add fetch retry logic", tabLabel: "Fetch Retry" });
});

test("parseGeneratedName: missing TAB line derives label from session name (capped)", () => {
	const got = parseGeneratedName("SESSION: Fix the broken config resolution heuristic now");
	assert.equal(got?.sessionName, "Fix the broken config resolution heuristic now");
	assert.equal(got?.tabLabel, "Fix the broken config"); // 4-word cap
});

test("parseGeneratedName: tab label is capped to 4 words", () => {
	const got = parseGeneratedName("SESSION: Anything\nTAB: one two three four five");
	assert.equal(got?.tabLabel, "one two three four");
});

test("parseGeneratedName: no SESSION line → undefined", () => {
	assert.equal(parseGeneratedName("TAB: only a tab"), undefined);
	assert.equal(parseGeneratedName("no markers at all"), undefined);
});

// Copilot business/enterprise tokens pin requests to a credential-specific
// endpoint (auth.baseUrl); ignoring it yields 421 Misdirected Request.
test("withAuthBaseUrl: overrides model.baseUrl when auth carries one", () => {
	const model = { id: "kimi-k3", baseUrl: "https://api.individual.githubcopilot.com" };
	const got = withAuthBaseUrl(model, { baseUrl: "https://api.business.githubcopilot.com" });
	assert.equal(got.baseUrl, "https://api.business.githubcopilot.com");
	assert.equal(got.id, "kimi-k3");
	assert.notEqual(got, model); // copy, never mutate the registry's model
	assert.equal(model.baseUrl, "https://api.individual.githubcopilot.com");
});

test("withAuthBaseUrl: returns model unchanged when auth has no baseUrl", () => {
	const model = { id: "kimi-k3", baseUrl: "https://api.individual.githubcopilot.com" };
	assert.equal(withAuthBaseUrl(model, {}), model);
	assert.equal(withAuthBaseUrl(model, { baseUrl: undefined }), model);
});
