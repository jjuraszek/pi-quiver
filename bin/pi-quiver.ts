#!/usr/bin/env node
/**
 * pi-quiver CLI. `pi-quiver fetch <url> [flags]` runs the same fetch core
 * as the pi extension and prints its output to stdout.
 * Exit codes: 0 = response received (incl. non-2xx / truncated),
 * 1 = fetch failed (bad URL/protocol, DNS, timeout, write failure),
 * 2 = usage error.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { fetchUrl, type FetchOptions } from "../lib/fetch-core.ts";

const USAGE =
	"Usage: pi-quiver fetch <url> [--method GET|HEAD|POST] [--header \"K: V\"]... [--body <str>] [--raw] [--timeout-ms <n>]";

export type ParsedArgs = { ok: true; opts: FetchOptions } | { ok: false; error: string };

export function parseCliArgs(argv: string[]): ParsedArgs {
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
				if (value !== "GET" && value !== "HEAD" && value !== "POST") {
					return { ok: false, error: `invalid --method: ${value}` };
				}
				method = value;
			} else if (arg === "--header") {
				const sep = value.indexOf(": ");
				if (sep <= 0) return { ok: false, error: `malformed --header (expected "Key: Value"): ${value}` };
				headers ??= {};
				headers[value.slice(0, sep)] = value.slice(sep + 2);
			} else if (arg === "--body") {
				body = value;
			} else {
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
	return { ok: true, opts };
}

async function main(): Promise<number> {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n${USAGE}\n`);
		return 2;
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

if (isMainEntry()) {
	main().then((code) => { process.exitCode = code; });
}
