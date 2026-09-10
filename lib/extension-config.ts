/**
 * Shared settings-resolution for pi-quiver extensions that read opt-in
 * config from pi's `settings.json`.
 *
 * Layers, lowest precedence first:
 *   1. global - `<getAgentDir()>/settings.json`
 *   2. project - `<cwd>/.pi/settings.json`
 *
 * The global path comes from pi's own `getAgentDir()`, which honours the
 * `PI_CODING_AGENT_DIR` env override (else `~/.pi/agent`). That keeps it
 * correct when these extensions are consumed as a git-tag-pinned package -
 * unlike deriving the path from `import.meta.url`, which only held while an
 * extension lived inside `<agentHome>/extensions/`.
 *
 * Within each layer, a nested `quiver.<key>` takes precedence over the flat
 * `<key>` by presence alone (even when malformed); the flat top-level
 * fallback is frozen to the pre-quiver LEGACY_FLAT_KEYS and never extended.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DOC_TO_MD_OPTIONS } from "./doc-to-md-options.ts";

export function readSettings(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function settingsPaths(cwd: string): string[] {
	return [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")];
}

/** Flat top-level fallback is frozen to these pre-quiver keys; never extend. */
const LEGACY_FLAT_KEYS = new Set(["fastMode", "sessionAutoName", "swordHeader", "providerStallWatchdog"]);

/**
 * Lint allowlist: every pi-quiver settings block and its fields. A key read
 * by an extension but missing here is reported as unknown - register new
 * keys here first.
 */
export const QUIVER_CONFIG_KEYS: Record<string, readonly string[]> = {
	fastMode: ["enabled"],
	sessionAutoName: ["enabled", "ghosttyTab", "herdrTab", "rules", "deny", "revisitFirstTurn", "revisitEveryTurns"],
	swordHeader: ["enabled"],
	providerStallWatchdog: ["enabled", "firstEventMs", "warningMs", "recoveryMs", "maxStallRetries"],
	slack: ["enabled", "cachePath", "policyPath", "userTokenEnv", "botTokenEnv", "uploadThresholdChars"],
	docToMd: DOC_TO_MD_OPTIONS.filter((o) => o.settable).map((o) => o.key),
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const emittedWarnings = new Set<string>();

function emitWarning(warn: ((message: string) => void) | undefined, message: string): void {
	if (!warn || emittedWarnings.has(message)) return;
	emittedWarnings.add(message);
	warn(message);
}

/** Structural findings for one parsed settings file: flat legacy use, non-object quiver, unknown blocks, unknown fields. */
function lintSettings(settings: Record<string, unknown>): string[] {
	const lines: string[] = [];
	for (const key of Object.keys(settings)) if (LEGACY_FLAT_KEYS.has(key)) lines.push(`"${key}" at top level - move under "quiver"`);
	const root = settings.quiver;
	if (root === undefined) return lines;
	if (!isPlainObject(root)) return [...lines, `"quiver" is not an object - ignored`];
	const fieldLines: string[] = [];
	for (const [block, value] of Object.entries(root)) {
		if (!Object.hasOwn(QUIVER_CONFIG_KEYS, block)) {
			lines.push(`"quiver.${block}" - unknown block; accepted: ${Object.keys(QUIVER_CONFIG_KEYS).join(", ")}`);
			continue;
		}
		if (!isPlainObject(value)) continue;
		const fields = QUIVER_CONFIG_KEYS[block];
		for (const field of Object.keys(value)) if (!fields.includes(field)) fieldLines.push(`"quiver.${block}.${field}" - unknown; accepted: ${fields.join(", ")}`);
	}
	return [...lines, ...fieldLines];
}

function formatLint(findings: Array<[path: string, lines: string[]]>): string {
	const tail = "unknown or misplaced keys - unknown ones fall back to defaults";
	if (findings.length === 1) {
		const [path, lines] = findings[0];
		return [`pi-quiver settings (${path}): ${tail}`, ...lines.map((l) => `  ${l}`)].join("\n");
	}
	return [`pi-quiver settings: ${tail}`, ...findings.flatMap(([path, lines]) => [`  ${path}`, ...lines.map((l) => `    ${l}`)])].join("\n");
}

/**
 * Resolve a single extension config key across the settings layers.
 * `quiver.<key>` wins over flat `<key>` within a layer by presence (even
 * when malformed); flat fallback exists only for LEGACY_FLAT_KEYS. `coerce`
 * validates the layer's candidate into a partial patch (or `undefined` to
 * skip); patches merge over `defaults` in layer order (project wins).
 * `warn` receives one sentence per malformed key plus one condensed
 * structural lint (flat legacy use, unknown blocks, unknown fields) - each
 * distinct message once per process.
 */
export function resolveConfig<T extends object>(
	cwd: string,
	key: string,
	defaults: T,
	coerce: (raw: unknown) => Partial<T> | undefined,
	warn?: (message: string) => void,
): T {
	const cfg: T = { ...defaults };
	const findings: Array<[string, string[]]> = [];
	for (const path of settingsPaths(cwd)) {
		const settings = readSettings(path);
		if (!settings) continue;
		const lines = lintSettings(settings);
		if (lines.length > 0) findings.push([path, lines]);
		const nested = isPlainObject(settings.quiver) ? settings.quiver : undefined;
		const hasNested = nested !== undefined && Object.hasOwn(nested, key);
		const hasFlat = Object.hasOwn(settings, key);
		if (!hasNested && !(hasFlat && LEGACY_FLAT_KEYS.has(key))) continue;
		const candidate = hasNested ? nested![key] : settings[key];
		const patch = coerce(candidate);
		if (patch) Object.assign(cfg, patch);
		else emitWarning(warn, `pi-quiver: "${key}" in ${path} has an unrecognized value; ignored.`);
	}
	if (findings.length > 0) emitWarning(warn, formatLint(findings));
	return cfg;
}
