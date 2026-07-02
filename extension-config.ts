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

/**
 * Resolve a single extension config key across the settings layers. `coerce`
 * validates each layer's raw value into a partial patch (or `undefined` to
 * skip); patches merge over `defaults` in layer order (project wins).
 */
export function resolveConfig<T extends object>(
	cwd: string,
	key: string,
	defaults: T,
	coerce: (raw: unknown) => Partial<T> | undefined,
): T {
	const cfg: T = { ...defaults };
	for (const path of settingsPaths(cwd)) {
		const patch = coerce(readSettings(path)?.[key]);
		if (patch) Object.assign(cfg, patch);
	}
	return cfg;
}
