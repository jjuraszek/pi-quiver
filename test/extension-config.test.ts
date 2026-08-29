import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../lib/extension-config.ts";
import { coerce as swordCoerce } from "../extensions/sword-header.ts";

type Cfg = { enabled: boolean; label: string };
const DEFAULTS: Cfg = { enabled: false, label: "default" };

function coerceCfg(raw: unknown): Partial<Cfg> | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return { enabled: raw };
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const o = raw as Record<string, unknown>;
		const out: Partial<Cfg> = {};
		if (typeof o.enabled === "boolean") out.enabled = o.enabled;
		if (typeof o.label === "string") out.label = o.label;
		return out;
	}
	return undefined;
}

function withSettings(
	global: Record<string, unknown>,
	project: Record<string, unknown>,
	fn: (cwd: string, files: { globalFile: string; projectFile: string }) => void,
): void {
	const agentDir = mkdtempSync(join(tmpdir(), "quiver-cfg-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "quiver-cfg-project-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const globalFile = join(agentDir, "settings.json");
		writeFileSync(globalFile, JSON.stringify(global));
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		const projectFile = join(projectDir, ".pi", "settings.json");
		writeFileSync(projectFile, JSON.stringify(project));
		fn(projectDir, { globalFile, projectFile });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}

test("nested-only non-legacy key resolves from quiver", () => {
	withSettings({}, { quiver: { slack: { enabled: true, label: "s" } } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "slack", DEFAULTS, coerceCfg), { enabled: true, label: "s" });
	});
});

test("flat-only legacy key keeps working", () => {
	withSettings({}, { fastMode: true }, (cwd) => {
		assert.equal(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg).enabled, true);
	});
});

test("flat non-legacy key is ignored", () => {
	withSettings({}, { slack: { enabled: true } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "slack", DEFAULTS, coerceCfg), DEFAULTS);
	});
});

test("both in one layer: nested value used whole, flat ignored", () => {
	withSettings({}, { fastMode: { enabled: false, label: "flat" }, quiver: { fastMode: { enabled: true, label: "nested" } } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg), { enabled: true, label: "nested" });
	});
});

test("presence suppresses flat even when nested is malformed", () => {
	withSettings({}, { fastMode: true, quiver: { fastMode: 42 } }, (cwd) => {
		assert.equal(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg).enabled, false);
	});
});

test("cross-layer: global flat + project nested, project wins per field", () => {
	withSettings({ fastMode: { enabled: true, label: "g" } }, { quiver: { fastMode: { label: "p" } } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg), { enabled: true, label: "p" });
	});
});

test("cross-layer: global nested + project flat, project wins per field", () => {
	withSettings({ quiver: { fastMode: { enabled: true, label: "g" } } }, { fastMode: { label: "p" } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg), { enabled: true, label: "p" });
	});
});

test("mixed per-key shapes in one layer resolve independently", () => {
	withSettings({}, { fastMode: true, quiver: { sessionAutoName: { enabled: true } } }, (cwd) => {
		assert.equal(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg).enabled, true);
		assert.equal(resolveConfig(cwd, "sessionAutoName", DEFAULTS, coerceCfg).enabled, true);
	});
});

test("non-object quiver root is ignored, flat resolution unaffected", () => {
	withSettings({}, { quiver: "nope", fastMode: true }, (cwd, files) => {
		const warnings: string[] = [];
		const cfg = resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(cfg.enabled, true);
		assert.deepEqual(warnings, [`pi-quiver: "quiver" in ${files.projectFile} is not an object; ignored.`]);
	});
});

test("warning: malformed flat legacy candidate", () => {
	withSettings({ fastMode: "bogus" }, {}, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [`pi-quiver: "fastMode" in ${files.globalFile} has an unrecognized value; ignored.`]);
	});
});

test("warning stacking: malformed nested in both layers emits per file", () => {
	withSettings({ quiver: { sessionAutoName: 1 } }, { quiver: { sessionAutoName: 2 } }, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "sessionAutoName", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [
			`pi-quiver: "sessionAutoName" in ${files.globalFile} has an unrecognized value; ignored.`,
			`pi-quiver: "sessionAutoName" in ${files.projectFile} has an unrecognized value; ignored.`,
		]);
	});
});

const DUPLICATE = (key: string) =>
	`pi-quiver: "${key}" is set both flat and under "quiver" (nested wins within a layer; across layers the project layer wins regardless of shape) - move the flat entry under "quiver".`;

test("warning: flat/nested duplicate in the same layer", () => {
	withSettings({}, { swordHeader: true, quiver: { swordHeader: true } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordHeader", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [DUPLICATE("swordHeader")]);
	});
});

test("warning: flat/nested duplicate across layers", () => {
	withSettings({ providerStallWatchdog: true }, { quiver: { providerStallWatchdog: true } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "providerStallWatchdog", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [DUPLICATE("providerStallWatchdog")]);
	});
});

test("warning: duplicate also covers a non-legacy key in both shapes", () => {
	withSettings({}, { slackDup: true, quiver: { slackDup: true } }, (cwd) => {
		const warnings: string[] = [];
		const cfg = resolveConfig(cwd, "slackDup", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(cfg.enabled, true, "nested still resolves");
		assert.deepEqual(warnings, [DUPLICATE("slackDup")]);
	});
});

test("warning dedupe: second resolution emits nothing", () => {
	withSettings({}, { quiver: { slackDedupe: 42 } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "slackDedupe", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		resolveConfig(cwd, "slackDedupe", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(warnings.length, 1);
	});
});

test("no callback: warnings are dropped, nothing throws", () => {
	withSettings({}, { quiver: "broken", fastMode: "alsoBroken" }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg), DEFAULTS);
	});
});

test("detectability pins: wrong-typed fields yield empty patch, no warning; wrong top-level type warns", () => {
	withSettings({}, { quiver: { swordPin: { enabled: "yes" } } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordPin", { enabled: false }, swordCoerce, (m) => warnings.push(m));
		assert.equal(warnings.length, 0, "{ enabled: 'yes' } is silently ineffective");
	});
	withSettings({}, { quiver: { swordPin: [] } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordPin", { enabled: false }, swordCoerce, (m) => warnings.push(m));
		assert.equal(warnings.length, 0, "[] is an object to this coercer: empty patch");
	});
	withSettings({}, { quiver: { swordPin: "bogus" } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordPin", { enabled: false }, swordCoerce, (m) => warnings.push(m));
		assert.equal(warnings.length, 1, "a string where an object is expected DOES warn");
	});
});

test("end-to-end through a real consumer coercer", () => {
	withSettings({}, { quiver: { swordHeader: { enabled: true } } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "swordHeader", { enabled: false }, swordCoerce), { enabled: true });
	});
});
