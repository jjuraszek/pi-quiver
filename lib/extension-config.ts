/** Pi-aware settings paths and config resolution for extensions. */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveConfigFrom, settingsPathsFor } from "./settings-core.ts";

export { readSettings, QUIVER_CONFIG_KEYS } from "./settings-core.ts";

export function settingsPaths(cwd: string): string[] {
	return settingsPathsFor(getAgentDir(), cwd);
}

export function resolveConfig<T extends object>(
	cwd: string,
	key: string,
	defaults: T,
	coerce: (raw: unknown, warn?: (message: string) => void) => Partial<T> | undefined,
	warn?: (message: string) => void,
): T {
	return resolveConfigFrom(settingsPaths(cwd), key, defaults, coerce, warn);
}
