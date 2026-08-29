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

const emittedWarnings = new Set<string>();

function emitWarning(warn: ((message: string) => void) | undefined, message: string): void {
	if (!warn || emittedWarnings.has(message)) return;
	emittedWarnings.add(message);
	warn(message);
}

/**
 * Resolve a single extension config key across the settings layers.
 * `quiver.<key>` wins over flat `<key>` within a layer by presence (even
 * when malformed); flat fallback exists only for LEGACY_FLAT_KEYS. `coerce`
 * validates the layer's candidate into a partial patch (or `undefined` to
 * skip); patches merge over `defaults` in layer order (project wins).
 * `warn` receives one sentence per malformed or flat/nested-duplicated key,
 * deduped per process.
 */
export function resolveConfig<T extends object>(
	cwd: string,
	key: string,
	defaults: T,
	coerce: (raw: unknown) => Partial<T> | undefined,
	warn?: (message: string) => void,
): T {
	const cfg: T = { ...defaults };
	let nestedSeen = false;
	let flatSeen = false;
	for (const path of settingsPaths(cwd)) {
		const settings = readSettings(path);
		if (!settings) continue;
		let root = settings.quiver;
		if (root !== undefined && (root === null || typeof root !== "object" || Array.isArray(root))) {
			emitWarning(warn, `pi-quiver: "quiver" in ${path} is not an object; ignored.`);
			root = undefined;
		}
		const nested = root as Record<string, unknown> | undefined;
		const hasNested = nested !== undefined && Object.hasOwn(nested, key);
		const hasFlat = Object.hasOwn(settings, key);
		nestedSeen ||= hasNested;
		flatSeen ||= hasFlat;
		if (!hasNested && !(hasFlat && LEGACY_FLAT_KEYS.has(key))) continue;
		const candidate = hasNested ? nested![key] : settings[key];
		const patch = coerce(candidate);
		if (patch) Object.assign(cfg, patch);
		else emitWarning(warn, `pi-quiver: "${key}" in ${path} has an unrecognized value; ignored.`);
	}
	if (nestedSeen && flatSeen) {
		emitWarning(
			warn,
			`pi-quiver: "${key}" is set both flat and under "quiver" (nested wins within a layer; across layers the project layer wins regardless of shape) - move the flat entry under "quiver".`,
		);
	}
	return cfg;
}
