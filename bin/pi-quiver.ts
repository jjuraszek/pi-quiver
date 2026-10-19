#!/usr/bin/env node
/**
 * pi-quiver CLI. `pi-quiver fetch <url> [flags]` runs the same fetch core
 * as the pi extension and prints its output to stdout.
 * Exit codes: 0 = response received (incl. non-2xx / truncated),
 * 1 = fetch failed (bad URL/protocol, DNS, timeout, write failure),
 * 2 = usage error.
 * `pi-quiver slack post|reply|dm|canvas` sends Slack mutations.
 * Slack exits: 0 sent, 1 runtime, 2 usage, 3 credential unavailable,
 * 4 definitive failure, 5 outcome unknown.
 * `pi-quiver doc-to-md [flags] <path>` runs the same doc-to-md core as the pi
 * extension and prints its handle to stdout.
 * Exit codes: 0 = converted or inspected (incl. degraded fallback), 1 = runtime
 * error, 2 = usage error.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchUrl, type FetchOptions } from "../lib/fetch-core.ts";
import { DOC_TO_MD_OPTIONS, type DocToMdDetails, type PerCallInput, type Tunables, UsageError, coerceDocToMdSettings, convertDocument, exitOnSignalKillingChildren, inspectDocument, renderHelp, resolveOptions } from "../lib/doc-to-md-core.ts";
import { SLACK_TEXT_HARD_LIMIT, MAX_TEXT_LENGTH, assertTextWithinLimit, assertHeadline, defaultApiCall, defaultUploadBytes, discoverRepoRoot, ERROR_HINTS, postMessage, resolveCredential, resolveSlackConfig, SlackError, type ApiCall, type UploadBytes } from "../lib/slack-core.ts";

const SLACK_HELP = `pi-quiver slack post --channel <id> --text <text> [--detail <text> | --detail-file <path>] [--blocks-file <path>] [--no-unfurl] [--as user|bot] [--token-from-env] [--dry-run]
pi-quiver slack reply --channel <id> --thread-ts <ts> (--text <t> | --text-file <path>) [--no-unfurl] [--as user|bot] [--token-from-env] [--dry-run]
pi-quiver slack dm --user <id> (--text <t> | --text-file <path>) [--blocks-file <path>] [--no-unfurl] [--as user|bot] [--token-from-env] [--dry-run]
pi-quiver slack canvas --id <id> --markdown-file <path> [--as user|bot] [--token-from-env] [--dry-run]
User post text must be a one-line headline; bot post text may be multi-line. Dry-run validates credentials without network calls.
Exit codes: 0 sent, 1 runtime error, 2 usage, 3 credential unavailable, 4 definitive failure, 5 outcome unknown.`;

const USAGE =
	"Usage: pi-quiver fetch <url> [--method GET|HEAD|POST] [--header \"K: V\"]... [--body <str>] [--raw] [--timeout-ms <n>]\n" +
	"       pi-quiver doc-to-md [--json] [--info] [--page-images] [--words] [--pages <spec>] [--output-dir <dir>] [--overwrite] [--ocr] [--ocr-mode textless|all] [tunable flags] <path>   (--help for all flags)\n" + SLACK_HELP;

type SlackArgs = {
	ok: true;
	cmd: "slack";
	sub: "post" | "reply" | "dm" | "canvas";
	as: "user" | "bot";
	channel?: string;
	user?: string;
	id?: string;
	threadTs?: string;
	text?: string;
	textFile?: string;
	detail?: string;
	detailFile?: string;
	blocksFile?: string;
	markdownFile?: string;
	noUnfurl?: boolean;
	tokenFromEnv?: boolean;
	dryRun?: boolean;
};

export type ParsedArgs =
	| SlackArgs
	| { ok: true; cmd: "slack-help" }
	| { ok: true; cmd: "version" }
	| { ok: true; cmd: "fetch"; opts: FetchOptions }
	| { ok: true; cmd: "doc-to-md"; perCall: PerCallInput; json: boolean }
	| { ok: true; cmd: "doc-to-md-help" }
	| { ok: false; error: string };

function parseSlack(rest: string[]): ParsedArgs {
	if (rest.length === 1 && rest[0] === "--help") return { ok: true, cmd: "slack-help" };
	const sub = rest[0];
	if (sub !== "post" && sub !== "reply" && sub !== "dm" && sub !== "canvas") return { ok: false, error: `unknown Slack command: ${sub ?? "(none)"}` };
	const allowed = {
		post: ["channel", "text", "detail", "detail-file", "blocks-file"],
		reply: ["channel", "thread-ts", "text", "text-file"],
		dm: ["user", "text", "text-file", "blocks-file"],
		canvas: ["id", "markdown-file"],
	}[sub];
	const booleans: { noUnfurl?: boolean; tokenFromEnv?: boolean; dryRun?: boolean } = {};
	const values: Record<string, string> = {};
	for (let i = 1; i < rest.length; i++) {
		const flag = rest[i];
		const key = flag.slice(2);
		if (flag === "--token-from-env") { booleans.tokenFromEnv = true; continue; }
		if (flag === "--dry-run") { booleans.dryRun = true; continue; }
		if (flag === "--no-unfurl" && sub !== "canvas") { booleans.noUnfurl = true; continue; }
		if (!flag.startsWith("--") || !(key === "as" || allowed.includes(key))) return { ok: false, error: `unexpected Slack argument: ${flag}` };
		const value = rest[++i];
		if (value === undefined || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` };
		values[key] = value;
	}
	if (values.as !== undefined && values.as !== "user" && values.as !== "bot") return { ok: false, error: "--as must be user or bot" };
	for (const pair of [["text", "text-file"], ["detail", "detail-file"]]) {
		if (pair.every((k) => values[k] !== undefined)) return { ok: false, error: `--${pair[0]} and --${pair[1]} are exclusive` };
	}
	const required = sub === "post" ? ["channel", "text"] : sub === "reply" ? ["channel", "thread-ts"] : sub === "dm" ? ["user"] : ["id", "markdown-file"];
	for (const key of required) if (values[key] === undefined || (key !== "text" && !values[key])) return { ok: false, error: `missing --${key}` };
	if ((sub === "reply" || sub === "dm") && values.text === undefined && values["text-file"] === undefined) return { ok: false, error: "missing --text or --text-file" };
	if (values.channel !== undefined && !/^[CDG][A-Z0-9]+$/.test(values.channel)) return { ok: false, error: "--channel requires a raw channel ID" };
	if (values.user !== undefined && !/^U[A-Z0-9]+$/.test(values.user)) return { ok: false, error: "--user requires a raw user ID" };
	const result: SlackArgs = { ok: true, cmd: "slack", sub, as: values.as === "bot" ? "bot" : "user", ...booleans };
	for (const key of allowed) {
		if (values[key] !== undefined) Object.assign(result, { [key.replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase())]: values[key] });
	}
	return result;
}

function parseDocToMd(rest: string[]): ParsedArgs {
	if (rest.includes("--help") || rest.includes("-h")) return { ok: true, cmd: "doc-to-md-help" };
	const json = rest.includes("--json");
	const args = rest.filter((a) => a !== "--json");
	const perCall: Record<string, unknown> = {};
	let path: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) { if (path !== undefined) return { ok: false, error: `unexpected argument: ${arg}` }; path = arg; continue; }
		const negated = arg.startsWith("--no-") ? DOC_TO_MD_OPTIONS.find((o) => o.type === "bool" && o.settable && o.flag === `--${arg.slice(5)}`) : undefined;
		if (negated) { perCall[negated.key] = false; continue; }
		const d = DOC_TO_MD_OPTIONS.find((o) => o.flag === arg);
		if (!d) return { ok: false, error: `unknown flag: ${arg}` };
		if (d.type === "bool") { perCall[d.key] = true; continue; }
		const value = args[++i];
		if (value === undefined) return { ok: false, error: `${arg} requires a value` };
		if (d.type === "int") { const n = Number(value); if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `invalid ${arg}: ${value}` }; perCall[d.key] = n; }
		else perCall[d.key] = value;
	}
	if (!path) return { ok: false, error: "missing <path>" };
	return { ok: true, cmd: "doc-to-md", perCall: { ...perCall, path } as PerCallInput, json };
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
	if (argv.length === 1 && argv[0] === "--version") return { ok: true, cmd: "version" };
	if (argv[0] === "slack") return parseSlack(argv.slice(1));
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

function slackFailureCode(err: unknown, mutationStarted: boolean, method: string | undefined): number {
	if (err instanceof SlackError) {
		if (err.code === "missing_token" || err.code === "credential_command_failed") return 3;
		if (err.code === "detail_failed") return 4;
		if (err.code === "outcome_unknown") return 5;
		if ((err.code === "transport" || err.code === "unexpected_response") && mutationStarted) return 5;
		if (method === "canvases.edit" && (err.code === "internal_error" || err.code === "fatal_error")) return 5;
		return 4;
	}
	return mutationStarted ? 5 : 1;
}

export async function runSlack(parsed: Extract<ParsedArgs, { ok: true; cmd: "slack" }>, deps: {
	env: NodeJS.ProcessEnv;
	cwd: string;
	apiCall: ApiCall;
	uploadBytes: UploadBytes;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}): Promise<number> {
	let token: string | undefined;
	const redact = (text: string): string => token ? text.split(token).join("<redacted>") : text;
	const stdout = (text: string): void => deps.stdout(redact(text));
	const stderr = (text: string): void => deps.stderr(redact(text));
	let text = parsed.text;
	let detail = parsed.detail;
	let markdown: string | undefined;
	let blocks: unknown[] | undefined;
	const read = (path: string): string => {
		try { return readFileSync(resolve(deps.cwd, path), "utf8"); }
		catch { throw new Error(`cannot read file: ${path}`); }
	};
	try {
		if (parsed.textFile !== undefined) text = read(parsed.textFile);
		if (parsed.detailFile !== undefined) detail = read(parsed.detailFile);
		if (parsed.markdownFile !== undefined) markdown = read(parsed.markdownFile);
		if (parsed.blocksFile !== undefined) {
			const content = read(parsed.blocksFile);
			let value: unknown;
			try { value = JSON.parse(content); } catch { throw new Error(`invalid JSON array in --blocks-file: ${parsed.blocksFile}`); }
			if (!Array.isArray(value)) throw new Error(`--blocks-file must contain a JSON array: ${parsed.blocksFile}`);
			blocks = value;
		}
		if (parsed.sub === "post" && parsed.as === "user") assertHeadline(text ?? "");
		if (parsed.sub !== "canvas" && !text) throw new Error("text must not be empty");
		if (parsed.dryRun && (parsed.sub === "post" || parsed.sub === "dm" || (parsed.sub === "reply" && parsed.as === "bot"))) {
			assertTextWithinLimit(text!, parsed.as === "bot" ? SLACK_TEXT_HARD_LIMIT : MAX_TEXT_LENGTH);
		}
	} catch (err) {
		stderr(`usage: ${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
		return 2;
	}
	let acknowledgedParent: string | undefined;
	let mutationStarted = false;
	let method: string | undefined;
	const trackedApiCall: ApiCall = async (name, credential, params, opts) => {
		method = name;
		if (["chat.postMessage", "canvases.edit", "files.getUploadURLExternal", "files.completeUploadExternal"].includes(name)) mutationStarted = true;
		return deps.apiCall(name, credential, params, opts);
	};
	const warnings: string[] = [];
	const flushWarnings = (): void => { for (const warning of warnings.splice(0)) stderr(`${warning}\n`); };
	try {
		const cfg = resolveSlackConfig(deps.cwd, deps.env, (message) => warnings.push(message), cliAgentDir(deps.env));
		if (parsed.tokenFromEnv) {
			const key = parsed.as === "user" ? cfg.userTokenEnv : cfg.botTokenEnv;
			token = deps.env[key];
			if (!token) throw new SlackError("missing_token", `No Slack ${parsed.as} token in process environment key ${key}`);
		} else {
			const repoRoot = discoverRepoRoot(deps.cwd);
			token = await resolveCredential(parsed.as, cfg, deps.env, repoRoot);
		}
		flushWarnings();
		if (parsed.dryRun) return 0;
		if (parsed.sub === "canvas") {
			await trackedApiCall("canvases.edit", token, {
				canvas_id: parsed.id,
				changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
			}, { retry: true });
			stdout(`canvas=${parsed.id}\n`);
			return 0;
		}
		let channel = parsed.channel;
		if (parsed.sub === "dm") {
			const opened = await trackedApiCall("conversations.open", token, { users: parsed.user }, { retry: true });
			const id = (opened.channel as { id?: unknown } | undefined)?.id;
			if (typeof id !== "string" || !id) throw new SlackError("unexpected_response", "conversations.open returned no channel.id");
			channel = id;
		}
		const unfurl = parsed.noUnfurl ? { unfurl_links: false, unfurl_media: false } : {};
		const coreDeps = { apiCall: trackedApiCall, uploadBytes: deps.uploadBytes, token, identity: parsed.as, thresholdChars: cfg.uploadThresholdChars };
		let result;
		if (parsed.sub === "post" && parsed.as === "bot" && /\r?\n/.test(text!) && detail !== undefined) {
			const parent = await postMessage({ channel: channel!, text, ...unfurl }, coreDeps);
			acknowledgedParent = parent.ts;
			if (parent.warning) stderr(`${parent.warning}\n`);
			// Threaded upload recovery replaces the cause; this two-call route needs its original outcome.
			let detailFailure: { error: unknown } | undefined;
			const detailApiCall: ApiCall = async (...args) => {
				try { return await trackedApiCall(...args); }
				catch (error) { detailFailure = { error }; throw error; }
			};
			const detailUploadBytes: UploadBytes = async (...args) => {
				try { return await deps.uploadBytes(...args); }
				catch (error) { detailFailure = { error }; throw error; }
			};
			let child;
			try {
				// Composed detail retains the announce upload policy, not the direct bot-text limit.
				child = await postMessage({ channel: parent.channel, text: detail, thread_ts: parent.ts, ...(blocks !== undefined ? { blocks } : {}), ...unfurl }, { ...coreDeps, identity: undefined, apiCall: detailApiCall, uploadBytes: detailUploadBytes });
			} catch (error) {
				throw error instanceof SlackError && error.code === "detail_failed" && detailFailure ? detailFailure.error : error;
			}
			result = { ...parent, detailTs: child.detailTs ?? child.ts, warning: child.warning };
		} else result = await postMessage({
			channel: channel!, text, ...unfurl,
			...(blocks !== undefined ? { blocks } : {}),
			...(detail !== undefined ? { thread_body: detail } : {}),
			...(parsed.threadTs !== undefined ? { thread_ts: parsed.threadTs } : {}),
		}, coreDeps);
		if (result.warning) stderr(`${result.warning}\n`);
		stdout([result.ts !== undefined ? `ts=${result.ts}` : undefined, result.permalink !== undefined ? `permalink=${result.permalink}` : undefined, result.detailTs !== undefined ? `detail_ts=${result.detailTs}` : undefined].filter((s) => s !== undefined).join(" ") + "\n");
		return 0;
	} catch (err) {
		flushWarnings();
		const code = slackFailureCode(err, mutationStarted, method);
		if (err instanceof SlackError) {
			let message = err.message.includes(err.code) ? err.message : `${err.code}: ${err.message}`;
			const hint = ERROR_HINTS[err.code];
			if (hint && !message.includes(hint)) message += `; ${hint}`;
			if (typeof err.data?.channel === "string") message += ` channel=${err.data.channel}`;
			stderr(`${message}\n`);
			if (code === 4) {
				const parent = acknowledgedParent ?? (err.code === "detail_failed" && typeof err.data?.ts === "string" ? err.data.ts : undefined);
				stdout(`${parent !== undefined ? `ts=${parent} ` : ""}error=${err.code}\n`);
			}
		} else stderr(`slack failed: ${err instanceof Error ? err.message : String(err)}\n`);
		if (code === 5) stderr("Check the channel before retrying.\n");
		return code;
	}
}

function packageVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const path = join(dir, "package.json");
		if (existsSync(path)) return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
		const parent = dirname(dir);
		if (parent === dir) throw new Error("No ancestor package.json found");
		dir = parent;
	}
}

async function main(): Promise<number> {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (!parsed.ok) {
		process.stderr.write(`${process.argv[2] === "slack" ? "usage: " : ""}${parsed.error}\n${USAGE}\n`);
		return 2;
	}
	if (parsed.cmd === "slack-help") { process.stdout.write(`${SLACK_HELP}\n`); return 0; }
	if (parsed.cmd === "version") {
		try { process.stdout.write(`${packageVersion()}\n`); return 0; }
		catch (err) { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); return 1; }
	}
	if (parsed.cmd === "slack") return runSlack(parsed, {
		env: process.env, cwd: process.cwd(), apiCall: defaultApiCall, uploadBytes: defaultUploadBytes,
		stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); },
	});
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
			if (parsed.json) {
				const payload = o.info ? r.details : (({ path, backend, pymupdfVersion, inputType, file, outputDir, ...handle }) => handle)(r.details as DocToMdDetails);
				process.stdout.write(`${JSON.stringify(payload)}\n`);
			} else process.stdout.write(`${r.output}\n`);
			return 0;
		} catch (err) {
			if (err instanceof UsageError) { process.stderr.write(`${err.message}\n${USAGE}\n`); return 2; }
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

if (isMainEntry()) {
	exitOnSignalKillingChildren();
	main().then((code) => { process.exitCode = code; });
}
