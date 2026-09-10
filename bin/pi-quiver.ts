#!/usr/bin/env node
/**
 * pi-quiver CLI. `pi-quiver fetch <url> [flags]` runs the same fetch core
 * as the pi extension and prints its output to stdout.
 * Exit codes: 0 = response received (incl. non-2xx / truncated),
 * 1 = fetch failed (bad URL/protocol, DNS, timeout, write failure),
 * 2 = usage error.
 * `pi-quiver doc-to-md [flags] <path>` runs the same doc-to-md core as the pi
 * extension and prints its handle to stdout.
 * Exit codes: 0 = converted or inspected (incl. degraded fallback), 1 = runtime
 * error, 2 = usage error.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchUrl, type FetchOptions } from "../lib/fetch-core.ts";
import { DOC_TO_MD_OPTIONS, type PerCallInput, type Tunables, UsageError, coerceDocToMdSettings, convertDocument, inspectDocument, renderHelp, resolveOptions } from "../lib/doc-to-md-core.ts";

const USAGE =
	"Usage: pi-quiver fetch <url> [--method GET|HEAD|POST] [--header \"K: V\"]... [--body <str>] [--raw] [--timeout-ms <n>]\n" +
	"       pi-quiver doc-to-md [--info] [--pages <spec>] [--output-dir <dir>] [--overwrite] [tunable flags] <path>   (--help for all flags)";

export type ParsedArgs =
	| { ok: true; cmd: "fetch"; opts: FetchOptions }
	| { ok: true; cmd: "doc-to-md"; perCall: PerCallInput }
	| { ok: true; cmd: "doc-to-md-help" }
	| { ok: false; error: string };

function parseDocToMd(rest: string[]): ParsedArgs {
	if (rest.includes("--help") || rest.includes("-h")) return { ok: true, cmd: "doc-to-md-help" };
	const perCall: Record<string, unknown> = {};
	let path: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith("--")) { if (path !== undefined) return { ok: false, error: `unexpected argument: ${arg}` }; path = arg; continue; }
		const d = DOC_TO_MD_OPTIONS.find((o) => o.flag === arg);
		if (!d) return { ok: false, error: `unknown flag: ${arg}` };
		if (d.type === "bool") { perCall[d.key] = true; continue; }
		const value = rest[++i];
		if (value === undefined) return { ok: false, error: `${arg} requires a value` };
		if (d.type === "int") { const n = Number(value); if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `invalid ${arg}: ${value}` }; perCall[d.key] = n; }
		else perCall[d.key] = value;
	}
	if (!path) return { ok: false, error: "missing <path>" };
	return { ok: true, cmd: "doc-to-md", perCall: { ...perCall, path } as PerCallInput };
}

/** pi-free mirror of getAgentDir(): PI_CODING_AGENT_DIR (only ~ and ~/ expanded; empty = unset) else ~/.pi/agent. */
export function cliAgentDir(env: NodeJS.ProcessEnv): string {
	const raw = env.PI_CODING_AGENT_DIR;
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	if (raw && raw.length > 0) {
		if (raw === "~") return home;
		if (raw.startsWith("~/") || (process.platform === "win32" && raw.startsWith("~\\"))) return join(home, raw.slice(2));
		return raw;
	}
	return join(home, ".pi", "agent");
}

export function readCliSettings(cwd: string, env: NodeJS.ProcessEnv, warn: (m: string) => void): Partial<Tunables> {
	const out: Partial<Tunables> = {};
	for (const file of [join(cliAgentDir(env), "settings.json"), join(cwd, ".pi", "settings.json")]) {
		if (!existsSync(file)) continue;
		let raw: unknown;
		try { raw = (JSON.parse(readFileSync(file, "utf8")) as { quiver?: { docToMd?: unknown } }).quiver?.docToMd; } catch { warn(`pi-quiver: ${file} is not valid JSON; ignored.`); continue; }
		if (raw === undefined) continue;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const unknown = Object.keys(raw).filter((k) => !DOC_TO_MD_OPTIONS.some((o) => o.key === k && o.settable));
			if (unknown.length > 0) warn(`pi-quiver: quiver.docToMd in ${file} has keys that are not tunable settings; ignored: ${unknown.join(", ")}`);
		}
		const patch = coerceDocToMdSettings(raw, warn);
		if (patch) Object.assign(out, patch); else warn(`pi-quiver: "docToMd" in ${file} has an unrecognized value; ignored.`);
	}
	return out;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
	if (argv[0] === "doc-to-md") return parseDocToMd(argv.slice(1));
	if (argv[0] !== "fetch") return { ok: false, error: `unknown command: ${argv[0] ?? "(none)"}` };
	const rest = argv.slice(1);
	let url: string | undefined;
	let method: FetchOptions["method"] | undefined;
	let headers: Record<string, string> | undefined;
	let body: string | undefined;
	let raw: boolean | undefined;
	let timeoutMs: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--raw") { raw = true; continue; }
		if (arg === "--method" || arg === "--header" || arg === "--body" || arg === "--timeout-ms") {
			const value = rest[++i];
			if (value === undefined) return { ok: false, error: `${arg} requires a value` };
			if (arg === "--method") {
				if (value !== "GET" && value !== "HEAD" && value !== "POST") return { ok: false, error: `invalid --method: ${value}` };
				method = value;
			} else if (arg === "--header") {
				const sep = value.indexOf(": ");
				if (sep <= 0) return { ok: false, error: `malformed --header (expected "Key: Value"): ${value}` };
				headers ??= {};
				headers[value.slice(0, sep)] = value.slice(sep + 2);
			} else if (arg === "--body") body = value;
			else {
				const n = Number(value);
				if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `invalid --timeout-ms: ${value}` };
				timeoutMs = n;
			}
			continue;
		}
		if (arg.startsWith("--")) return { ok: false, error: `unknown flag: ${arg}` };
		if (url !== undefined) return { ok: false, error: `unexpected argument: ${arg}` };
		url = arg;
	}
	if (!url) return { ok: false, error: "missing <url>" };
	const opts: FetchOptions = { url };
	if (method !== undefined) opts.method = method;
	if (headers !== undefined) opts.headers = headers;
	if (body !== undefined) opts.body = body;
	if (raw !== undefined) opts.raw = raw;
	if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
	return { ok: true, cmd: "fetch", opts };
}

async function main(): Promise<number> {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n${USAGE}\n`);
		return 2;
	}
	if (parsed.cmd === "doc-to-md-help") {
		process.stdout.write(`${renderHelp()}\n`);
		return 0;
	}
	if (parsed.cmd === "doc-to-md") {
		let o;
		try {
			const settings = readCliSettings(process.cwd(), process.env, (m) => process.stderr.write(`${m}\n`));
			const pc = parsed.perCall;
			o = resolveOptions({ ...pc, path: resolve(process.cwd(), pc.path), ...(pc.outputDir ? { outputDir: resolve(process.cwd(), pc.outputDir) } : {}) }, settings, process.env);
		} catch (err) {
			if (err instanceof UsageError) { process.stderr.write(`${err.message}\n${USAGE}\n`); return 2; }
			throw err;
		}
		try {
			const r = o.info ? await inspectDocument(o) : await convertDocument(o);
			process.stdout.write(`${r.output}\n`);
			return 0;
		} catch (err) {
			process.stderr.write(`doc-to-md failed: ${err instanceof Error ? err.message : String(err)}\n`);
			return 1;
		}
	}
	try {
		const result = await fetchUrl(parsed.opts);
		process.stdout.write(`${result.output}\n`);
		return 0;
	} catch (err) {
		process.stderr.write(`fetch failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

function isMainEntry(): boolean {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
	} catch {
		return false;
	}
}

if (isMainEntry()) main().then((code) => { process.exitCode = code; });
