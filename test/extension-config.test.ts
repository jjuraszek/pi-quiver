import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QUIVER_CONFIG_KEYS, resolveConfig } from "../lib/extension-config.ts";
import { DEFAULT_CONFIG as fastModeDefaults } from "../extensions/fast-mode.ts";
import { DEFAULT_CONFIG as sessionNameDefaults } from "../extensions/session-name.ts";
import { DEFAULT_CONFIG as swordHeaderDefaults, coerce as swordCoerce } from "../extensions/sword-header.ts";
import { DEFAULT_CONFIG as providerStallWatchdogDefaults } from "../extensions/provider-stall-watchdog.ts";
import { DEFAULT_SLACK_CONFIG as slackDefaults } from "../lib/slack-core.ts";
import { TUNABLE_DEFAULTS as docToMdDefaults } from "../lib/doc-to-md-options.ts";

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

const isLint = (m: string) => m.startsWith("pi-quiver settings");
const HEADER_TAIL = "unknown or misplaced keys - unknown ones fall back to defaults";

test("registry: every extension default-config key is registered; docToMd equals the settable option keys", () => {
	for (const field of Object.keys(fastModeDefaults)) {
		assert.ok(QUIVER_CONFIG_KEYS.fastMode.includes(field), `fastMode.${field} missing from QUIVER_CONFIG_KEYS`);
	}
	for (const field of Object.keys(sessionNameDefaults)) {
		assert.ok(QUIVER_CONFIG_KEYS.sessionAutoName.includes(field), `sessionAutoName.${field} missing from QUIVER_CONFIG_KEYS`);
	}
	for (const field of Object.keys(swordHeaderDefaults)) {
		assert.ok(QUIVER_CONFIG_KEYS.swordHeader.includes(field), `swordHeader.${field} missing from QUIVER_CONFIG_KEYS`);
	}
	for (const field of Object.keys(providerStallWatchdogDefaults)) {
		assert.ok(
			QUIVER_CONFIG_KEYS.providerStallWatchdog.includes(field),
			`providerStallWatchdog.${field} missing from QUIVER_CONFIG_KEYS`,
		);
	}
	for (const field of Object.keys(slackDefaults)) {
		assert.ok(QUIVER_CONFIG_KEYS.slack.includes(field), `slack.${field} missing from QUIVER_CONFIG_KEYS`);
	}
	assert.deepEqual([...QUIVER_CONFIG_KEYS.docToMd], Object.keys(docToMdDefaults));
});

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

test("non-object quiver root is ignored, flat resolution unaffected, one lint line", () => {
	withSettings({}, { quiver: "nope", fastMode: true }, (cwd, files) => {
		const warnings: string[] = [];
		const cfg = resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(cfg.enabled, true);
		assert.deepEqual(warnings, [
			[
				`pi-quiver settings (${files.projectFile}): ${HEADER_TAIL}`,
				`  "fastMode" at top level - move under "quiver"`,
				`  "quiver" is not an object - ignored`,
			].join("\n"),
		]);
	});
});

test("warning: malformed flat legacy candidate keeps its value sentence and gains the flat lint line", () => {
	withSettings({ fastMode: "bogus" }, {}, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings.filter((m) => !isLint(m)), [`pi-quiver: "fastMode" in ${files.globalFile} has an unrecognized value; ignored.`]);
		const lint = warnings.filter(isLint);
		assert.equal(lint.length, 1);
		assert.ok(lint[0].includes(`"fastMode" at top level - move under "quiver"`));
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

test("flat/nested duplicate in the same layer: only the flat lint line, nested still wins", () => {
	withSettings({}, { swordHeader: true, quiver: { swordHeader: true } }, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordHeader", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [
			`pi-quiver settings (${files.projectFile}): ${HEADER_TAIL}\n  "swordHeader" at top level - move under "quiver"`,
		]);
	});
});

test("flat/nested duplicate across layers: only the global file contributes", () => {
	withSettings({ providerStallWatchdog: true }, { quiver: { providerStallWatchdog: true } }, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "providerStallWatchdog", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [
			`pi-quiver settings (${files.globalFile}): ${HEADER_TAIL}\n  "providerStallWatchdog" at top level - move under "quiver"`,
		]);
	});
});

test("non-legacy key in both shapes: flat is ignored silently, nested unknown block is linted, nested still resolves", () => {
	withSettings({}, { slackDup: true, quiver: { slackDup: true } }, (cwd, files) => {
		const warnings: string[] = [];
		const cfg = resolveConfig(cwd, "slackDup", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(cfg.enabled, true, "nested still resolves");
		assert.deepEqual(warnings, [
			`pi-quiver settings (${files.projectFile}): ${HEADER_TAIL}\n  "quiver.slackDup" - unknown block; accepted: fastMode, sessionAutoName, swordHeader, providerStallWatchdog, slack, docToMd`,
		]);
	});
});

test("warning dedupe: second resolution emits nothing", () => {
	withSettings({}, { quiver: { slack: 42 } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "slack", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		resolveConfig(cwd, "slack", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(warnings.length, 1);
	});
});

test("no callback: warnings are dropped, nothing throws", () => {
	withSettings({}, { quiver: "broken", fastMode: "alsoBroken" }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg), DEFAULTS);
	});
});

test("detectability pins: wrong-typed fields yield empty patch, no warning; wrong top-level type warns", () => {
	withSettings({}, { quiver: { swordHeader: { enabled: "yes" } } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordHeader", { enabled: false }, swordCoerce, (m) => warnings.push(m));
		assert.equal(warnings.length, 0, "{ enabled: 'yes' } is silently ineffective");
	});
	withSettings({}, { quiver: { swordHeader: [] } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordHeader", { enabled: false }, swordCoerce, (m) => warnings.push(m));
		assert.equal(warnings.length, 0, "[] is an object to this coercer: empty patch");
	});
	withSettings({}, { quiver: { swordHeader: "bogus" } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "swordHeader", { enabled: false }, swordCoerce, (m) => warnings.push(m));
		assert.equal(warnings.length, 1, "a string where an object is expected DOES warn");
	});
});

test("end-to-end through a real consumer coercer", () => {
	withSettings({}, { quiver: { swordHeader: { enabled: true } } }, (cwd) => {
		assert.deepEqual(resolveConfig(cwd, "swordHeader", { enabled: false }, swordCoerce), { enabled: true });
	});
});

test("lint: flat legacy key alone warns and still resolves", () => {
	withSettings({}, { fastMode: true }, (cwd, files) => {
		const warnings: string[] = [];
		const cfg = resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(cfg.enabled, true);
		assert.deepEqual(warnings, [`pi-quiver settings (${files.projectFile}): ${HEADER_TAIL}\n  "fastMode" at top level - move under "quiver"`]);
	});
});

test("lint: flat, unknown block, unknown field - one message, category order, accepted lists inline", () => {
	withSettings({}, { quiver: { fastMode: { enabld: true }, bogusBlock: { x: 1 } }, swordHeader: true, fastMode: true }, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [
			[
				`pi-quiver settings (${files.projectFile}): ${HEADER_TAIL}`,
				`  "swordHeader" at top level - move under "quiver"`,
				`  "fastMode" at top level - move under "quiver"`,
				`  "quiver.bogusBlock" - unknown block; accepted: fastMode, sessionAutoName, swordHeader, providerStallWatchdog, slack, docToMd`,
				`  "quiver.fastMode.enabld" - unknown; accepted: enabled`,
			].join("\n"),
		]);
	});
});

test("lint: both files contribute -> per-file sub-headers", () => {
	withSettings({ fastMode: true }, { quiver: { providerStallWatchdog: { timeoutMs: 1 } } }, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [
			[
				`pi-quiver settings: ${HEADER_TAIL}`,
				`  ${files.globalFile}`,
				`    "fastMode" at top level - move under "quiver"`,
				`  ${files.projectFile}`,
				`    "quiver.providerStallWatchdog.timeoutMs" - unknown; accepted: enabled, firstEventMs, warningMs, recoveryMs, maxStallRetries`,
			].join("\n"),
		]);
	});
});

test("lint: second resolution with the same files emits nothing; clean files emit nothing", () => {
	withSettings({}, { quiver: { nope: 1 } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		resolveConfig(cwd, "swordHeader", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.equal(warnings.length, 1);
	});
	withSettings({ quiver: { fastMode: { enabled: true } } }, { quiver: { slack: false } }, (cwd) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, []);
	});
});

test("lint: non-object block value and unknown-block object value produce no field lines", () => {
	withSettings({}, { quiver: { fastMode: true, nope: { a: 1 } } }, (cwd, files) => {
		const warnings: string[] = [];
		resolveConfig(cwd, "fastMode", DEFAULTS, coerceCfg, (m) => warnings.push(m));
		assert.deepEqual(warnings, [
			`pi-quiver settings (${files.projectFile}): ${HEADER_TAIL}\n  "quiver.nope" - unknown block; accepted: fastMode, sessionAutoName, swordHeader, providerStallWatchdog, slack, docToMd`,
		]);
	});
});
