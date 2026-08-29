import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { coerce, swordLines } from "../extensions/sword-header.ts";
import swordHeader from "../extensions/sword-header.ts";

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

test("session_start: malformed swordHeader settings warn via notify", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "sword-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "sword-project-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ swordHeader: "bogus" }));
	try {
		const hooks = new Map<string, (event: any, ctx: any) => any>();
		const pi: any = { on: (event: string, h: any) => hooks.set(event, h), registerCommand: () => {} };
		swordHeader(pi);
		const notifications: Array<[string, string | undefined]> = [];
		const ctx: any = {
			mode: "tui",
			cwd: projectDir,
			ui: { setHeader: () => {}, notify: (m: string, t?: string) => notifications.push([m, t]) },
		};
		await hooks.get("session_start")!({}, ctx);
		const hit = notifications.find(([m]) => m.includes('"swordHeader"'));
		assert.ok(hit, "malformed swordHeader warns");
		assert.equal(hit![1], "warning");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
});
