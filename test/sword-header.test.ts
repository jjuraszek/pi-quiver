import { test } from "node:test";
import assert from "node:assert/strict";
import { coerce, swordLines } from "../extensions/sword-header.ts";

test("coerce: boolean shorthand toggles enabled", () => {
	assert.deepEqual(coerce(true), { enabled: true });
	assert.deepEqual(coerce(false), { enabled: false });
});

test("coerce: object form carries enabled when boolean", () => {
	assert.deepEqual(coerce({ enabled: true }), { enabled: true });
	assert.deepEqual(coerce({ enabled: false }), { enabled: false });
});

test("coerce: ignores non-boolean enabled and unknown keys", () => {
	assert.deepEqual(coerce({ enabled: "yes", other: 1 }), {});
});

test("coerce: invalid / absent inputs return undefined", () => {
	assert.equal(coerce(undefined), undefined);
	assert.equal(coerce(null), undefined);
	assert.equal(coerce("true"), undefined);
	assert.equal(coerce(42), undefined);
});

test("swordLines: stable shape, only accent/text tokens", () => {
	const lines = swordLines();
	assert.equal(lines.length, 10);
	for (const segs of lines) {
		assert.ok(segs.length >= 1);
		for (const [tok, text] of segs) {
			assert.ok(tok === "accent" || tok === "text", `unexpected token ${tok}`);
			assert.equal(typeof text, "string");
		}
	}
});

test("swordLines: blade rows carry a steel (text) segment", () => {
	const bladeRows = swordLines().filter((segs) => segs.some(([tok]) => tok === "text"));
	assert.equal(bladeRows.length, 3);
});
