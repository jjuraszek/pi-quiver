import { test } from "node:test";
import assert from "node:assert/strict";
import { coerce, toTabLabel, stripSkillBodies, isGhosttyActive, parseGeneratedName } from "../extensions/session-name.ts";

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
