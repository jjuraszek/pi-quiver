/**
 * Fetch Extension
 *
 * Registers a `fetch` tool that retrieves URLs with context-safe output routing.
 * HTML is extracted to structured Markdown via readability + turndown (boilerplate
 * stripped, headings/lists/tables/code fences preserved). Binary content (images,
 * PDFs, archives, etc.) is saved untouched to a temp file and only the path is
 * returned. Text/Markdown/JSON over 32 KB or 1000 lines is written to a temp file
 * with a 60-line preview; smaller content is returned inline. Parsable downloads
 * are capped at 1 MB; binary downloads at 50 MB.
 */

import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

interface FetchToolDetails {
	url?: string;
	status?: number;
	contentType?: string;
	charset?: string;
	bytes?: number;
	truncated?: boolean;
	category?: "binary" | "markdown" | "json" | "text";
	spilled?: boolean;
	file?: string;
	lines?: number;
	via?: "gh";
	ghCommand?: string;
}

type GhTarget =
	| { kind: "issue"; url: string }
	| { kind: "pr"; url: string }
	| { kind: "repo"; slug: string }
	| { kind: "run"; slug: string; runId: string; url: string };

const RESERVED_OWNERS = new Set([
	"orgs", "users", "sponsors", "topics", "marketplace", "apps",
	"collections", "stars", "settings", "notifications", "codespaces",
	"features", "trending", "security", "customer-stories",
]);
const GH_NAME = /^[A-Za-z0-9._-]+$/;

export function classifyGitHubTarget(url: URL): GhTarget | null {
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;
	const segs = url.pathname.split("/").filter((s) => s.length > 0);
	if (segs.length < 2) return null;
	const [owner, repo] = segs;
	if (!GH_NAME.test(owner) || !GH_NAME.test(repo)) return null;
	if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
	if (segs.length === 4 && segs[2] === "issues" && /^\d+$/.test(segs[3])) {
		return { kind: "issue", url: `https://github.com/${owner}/${repo}/issues/${segs[3]}` };
	}
	if (segs.length === 4 && segs[2] === "pull" && /^\d+$/.test(segs[3])) {
		return { kind: "pr", url: `https://github.com/${owner}/${repo}/pull/${segs[3]}` };
	}
	if (segs.length === 5 && segs[2] === "actions" && segs[3] === "runs" && /^\d+$/.test(segs[4])) {
		return { kind: "run", slug: `${owner}/${repo}`, runId: segs[4], url: `https://github.com/${owner}/${repo}/actions/runs/${segs[4]}` };
	}
	if (segs.length === 2) {
		return { kind: "repo", slug: `${owner}/${repo}` };
	}
	return null;
}

export function buildGhArgs(target: GhTarget): string[] {
	if (target.kind === "issue") return ["issue", "view", target.url, "--comments"];
	if (target.kind === "pr") return ["pr", "view", target.url, "--comments"];
	if (target.kind === "run") return ["run", "view", target.runId, "--repo", target.slug];
	return ["repo", "view", target.slug];
}

const GH_MAX_BUFFER = 10_000_000; // 10 MB — an order above PARSABLE_MAX_BYTES

type GhResult = { ok: true; stdout: string } | { ok: false };
export type GhRunner = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<GhResult>;

const execFileAsync = promisify(execFile);

export const runGh: GhRunner = async (args, timeoutMs, signal) => {
	try {
		const { stdout } = await execFileAsync("gh", args, {
			timeout: timeoutMs,
			signal,
			maxBuffer: GH_MAX_BUFFER,
			encoding: "utf8",
		});
		if (!stdout.trim()) return { ok: false };
		return { ok: true, stdout };
	} catch {
		return { ok: false };
	}
};

interface GhRoutingParams {
	raw?: boolean;
	method?: string;
	body?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

export function planGhRouting(params: GhRoutingParams, url: URL): GhTarget | null {
	if (params.raw) return null;
	if ((params.method ?? "GET") !== "GET") return null;
	if (params.body) return null;
	if (params.headers && Object.keys(params.headers).length > 0) return null;
	return classifyGitHubTarget(url);
}

function ghCommandLabel(target: GhTarget): string {
	if (target.kind === "issue") return "issue view --comments";
	if (target.kind === "pr") return "pr view --comments";
	if (target.kind === "run") return "run view";
	return "repo view";
}

function ghSourceLine(target: GhTarget, ref: string): string {
	if (target.kind === "issue") return `gh issue view ${ref} --comments`;
	if (target.kind === "pr") return `gh pr view ${ref} --comments`;
	if (target.kind === "run") return `gh run view ${target.runId} --repo ${target.slug}`;
	return `gh repo view ${ref}`;
}

function renderGhResult(target: GhTarget, stdout: string): { content: { type: "text"; text: string }[]; details: FetchToolDetails } {
	const body = stdout.trimEnd();
	const ref = target.kind === "repo" ? target.slug : target.url;
	const { spill, bytes, lines } = applyGate(body);
	const baseDetails: FetchToolDetails = {
		url: ref,
		bytes,
		lines,
		category: "markdown",
		via: "gh",
		ghCommand: ghCommandLabel(target),
	};
	const source = `Source: ${ghSourceLine(target, ref)}`;
	if (!spill) {
		return {
			content: [{ type: "text", text: [source, "", body].join("\n") }],
			details: { ...baseDetails, spilled: false },
		};
	}
	const spillUrl = target.kind === "repo" ? `https://github.com/${target.slug}` : target.url;
	const file = spillToFile(spillUrl, body, "md");
	return {
		content: [{
			type: "text",
			text: [
				source,
				`Body: ${formatSize(bytes)} across ${lines} lines — written to file (too large to inline)`,
				`Saved-To: ${file}`,
				"",
				"Read slices of this file with the read tool (offset/limit) or grep it; do not read the whole file unless you must. Markdown is grep-able by heading (^#).",
				"",
				`----- preview (first ${PREVIEW_LINES} lines) -----`,
				buildPreview(body),
			].join("\n"),
		}],
		details: { ...baseDetails, spilled: true, file },
	};
}

export async function executeGhRouting(
	params: GhRoutingParams,
	url: URL,
	signal: AbortSignal | undefined,
	runner: GhRunner = runGh,
): Promise<{ content: { type: "text"; text: string }[]; details: FetchToolDetails } | null> {
	const target = planGhRouting(params, url);
	if (!target) return null;
	const gh = await runner(buildGhArgs(target), params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
	if (!gh.ok) return null;
	return renderGhResult(target, gh.stdout);
}

const PARSABLE_MAX_BYTES = 1_000_000; // text/markdown/json download ceiling
const BINARY_MAX_BYTES = 50_000_000; // file-destined download ceiling
const SNIFF_MAX_BYTES = 64_000; // classification window
const DEFAULT_TIMEOUT_MS = 20_000;
const INLINE_MAX_BYTES = 32_000;
const INLINE_MAX_LINES = 1_000;
const PREVIEW_LINES = 60;
const PREVIEW_MAX_BYTES = 4_000;
const FIREFOX_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:135.0) Gecko/20100101 Firefox/135.0";
const DEFAULT_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function parseCharset(contentType: string): string {
	const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
	return (m?.[1] ?? "utf-8").trim().toLowerCase();
}

function decodeBuffer(buf: Buffer, charset: string): string {
	try {
		return new TextDecoder(charset, { fatal: false }).decode(buf);
	} catch {
		return new TextDecoder("utf-8", { fatal: false }).decode(buf);
	}
}

function buildPreview(body: string): string {
	let preview = body.split("\n").slice(0, PREVIEW_LINES).join("\n");
	if (preview.length > PREVIEW_MAX_BYTES) {
		preview = `${preview.slice(0, PREVIEW_MAX_BYTES)}\n…[preview truncated]`;
	}
	return preview;
}

// --- Turndown singleton ---

const turndownService = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
turndownService.use(gfm);

// --- Content classification ---

function mimeType(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

const TEXT_ALLOWLIST: RegExp[] = [
	/^text\//,
	/^application\/(json|xml|xhtml\+xml|javascript)$/,
	/\+json$/,
	/\+xml$/,
];
// octet-stream is intentionally absent — it falls to the NUL-sniff branch.
const KNOWN_BINARY: RegExp[] = [
	/^audio\//,
	/^video\//,
	/^font\//,
	/^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|wasm)$/,
];

export function categorize(contentType: string, sniff: Buffer, raw: boolean): "binary" | "markdown" | "json" | "text" {
	const mime = mimeType(contentType);
	if (/^image\//.test(mime)) return "binary"; // includes image/svg+xml
	const isText = TEXT_ALLOWLIST.some((re) => re.test(mime));
	const isBinary = KNOWN_BINARY.some((re) => re.test(mime));
	if (!isText && !isBinary) return sniff.includes(0) ? "binary" : "text";
	if (isBinary && !isText) return "binary";
	if (sniff.includes(0)) return "binary"; // NUL downgrade of a text candidate
	if (raw) return "text"; // raw=true skips all transformations (markdown + JSON pretty-print)
	if (mime === "text/html" || mime === "application/xhtml+xml") return "markdown";
	if (mime === "application/json" || /\+json$/.test(mime)) return "json";
	return "text";
}

export function htmlToMarkdown(html: string, url: string): string | null {
	let doc: Document;
	try {
		doc = new JSDOM(html, { url }).window.document;
	} catch {
		return null;
	}
	let article: { title?: string | null; content?: string | null } | null = null;
	try {
		article = new Readability(doc).parse();
	} catch {
		return null;
	}
	if (!article?.content) return null;
	let md: string;
	try {
		md = turndownService.turndown(article.content).trim();
	} catch {
		return null;
	}
	if (!md) return null;
	if (article.title) md = `# ${article.title}\n\n${md}`;
	return md;
}

export function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

export function applyGate(body: string): { spill: boolean; bytes: number; lines: number } {
	const bytes = Buffer.byteLength(body, "utf8");
	const lines = body.length ? body.split("\n").length : 0;
	const spill = body.length > 0 && (bytes > INLINE_MAX_BYTES || lines > INLINE_MAX_LINES);
	return { spill, bytes, lines };
}

// --- Temp file helpers ---

function tempFilePath(url: string, ext: string): string {
	const dir = join(tmpdir(), "pi-fetch");
	mkdirSync(dir, { recursive: true });
	let host = "page";
	try {
		host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
	} catch {
		// keep default
	}
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(dir, `${stamp}-${host}-${hash}.${ext}`);
}

function spillToFile(url: string, body: string, ext: string): string {
	const file = tempFilePath(url, ext);
	writeFileSync(file, body, "utf8");
	return file;
}

function textExtension(category: "markdown" | "json" | "text", contentType: string): string {
	if (category === "markdown") return "md";
	if (category === "json") return "json";
	return mimeType(contentType).includes("xml") ? "xml" : "txt";
}

const BINARY_EXT: Record<string, string> = {
	"application/pdf": "pdf",
	"application/zip": "zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/gzip": "gz",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};

export function binaryExtension(contentType: string): string {
	const mime = mimeType(contentType);
	if (BINARY_EXT[mime]) return BINARY_EXT[mime];
	const sub = (mime.split("/")[1] ?? "").replace(/^x-/, "").replace(/[^a-z0-9]+/g, "").slice(0, 8);
	return sub || "bin";
}

// --- Streaming body collection ---

type Category = "binary" | "markdown" | "json" | "text";

interface CollectedBody {
	category: Category;
	buffer?: Buffer; // text/markdown/json (raw, pre-transform)
	file?: string; // binary
	bytes: number; // bytes kept (post-cap)
	truncated: boolean;
}

function writeChunk(stream: ReturnType<typeof createWriteStream>, b: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(b, (err) => (err ? reject(err) : resolve()));
	});
}

async function pumpToFile(
	stream: ReturnType<typeof createWriteStream>,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	prefix: Buffer,
	exhausted: boolean,
): Promise<{ bytes: number; truncated: boolean }> {
	let bytes = 0;
	let truncated = false;
	let head = prefix;
	if (head.length > BINARY_MAX_BYTES) {
		head = head.subarray(0, BINARY_MAX_BYTES);
		truncated = true;
	}
	await writeChunk(stream, head);
	bytes += head.length;
	while (!exhausted && !truncated) {
		const { done, value } = await reader.read();
		if (done) break;
		let chunk = Buffer.from(value);
		if (bytes + chunk.length > BINARY_MAX_BYTES) {
			chunk = chunk.subarray(0, BINARY_MAX_BYTES - bytes);
			truncated = true;
		}
		await writeChunk(stream, chunk);
		bytes += chunk.length;
	}
	await new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
	return { bytes, truncated };
}

export async function collectBody(res: Response, contentType: string, raw: boolean): Promise<CollectedBody> {
	const reader = res.body!.getReader();
	const prefixParts: Buffer[] = [];
	let prefixLen = 0;
	let exhausted = false;
	while (prefixLen < SNIFF_MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) {
			exhausted = true;
			break;
		}
		const chunk = Buffer.from(value);
		prefixParts.push(chunk);
		prefixLen += chunk.length;
	}
	const prefix = Buffer.concat(prefixParts);
	const category = categorize(contentType, prefix.subarray(0, SNIFF_MAX_BYTES), raw);

	if (category === "binary") {
		const file = tempFilePath(res.url, binaryExtension(contentType));
		const stream = createWriteStream(file);
		try {
			const { bytes, truncated } = await pumpToFile(stream, reader, prefix, exhausted);
			if (truncated) await reader.cancel().catch(() => {});
			return { category, file, bytes, truncated };
		} catch (err) {
			stream.destroy();
			await rm(file, { force: true });
			await reader.cancel().catch(() => {});
			throw err;
		}
	}

	const parts = [prefix];
	let bytes = prefix.length;
	let streamDone = exhausted;
	while (!streamDone && bytes < PARSABLE_MAX_BYTES) {
		const { done, value } = await reader.read();
		if (done) { streamDone = true; break; }
		const chunk = Buffer.from(value);
		parts.push(chunk);
		bytes += chunk.length;
	}
	let buffer = Buffer.concat(parts);
	if (buffer.length > PARSABLE_MAX_BYTES) {
		buffer = buffer.subarray(0, PARSABLE_MAX_BYTES);
	}
	const truncated = !streamDone;
	if (truncated) await reader.cancel().catch(() => {});
	return { category, buffer, bytes: buffer.length, truncated };
}

export default function fetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch",
		label: "Fetch URL",
		description:
			"Fetch a URL over HTTP(S). HTML is extracted to Markdown (readability + turndown). Binary content (images, PDFs, archives) is saved untouched to a temp file and only a path is returned. Text/Markdown/JSON over 32KB or 1000 lines is written to a temp file with a 60-line preview; smaller content is returned inline. Parsable downloads are capped at 1MB, binary at 50MB. GitHub issue/PR/repo/actions-run URLs are served via the gh CLI when available (falls back to HTTP otherwise).",
		promptSnippet: "Fetch the contents of a URL",
		promptGuidelines: [
			"Use fetch when the user provides a URL or asks to read web content.",
			"Binary responses return a file path only — pass that path to a tool that can process the bytes; do not expect inline content.",
			"When the body is written to a file, grep it or read with offset/limit. Converted Markdown is grep-able by heading (^#).",
			"Pass raw=true to skip Markdown/JSON conversion and get the decoded body as-is (still subject to the size gate).",
			"GitHub issue/PR/repo/actions-run links are fetched through the gh CLI automatically; pass raw=true to force the rendered HTML page.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL" }),
			method: Type.Optional(
				Type.Union(
					[Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST")],
					{ default: "GET" },
				),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Extra request headers (override defaults like UA)",
				}),
			),
			body: Type.Optional(Type.String({ description: "Request body for POST" })),
			raw: Type.Optional(
				Type.Boolean({ description: "Skip HTML→Markdown and JSON pretty-printing; return the decoded body as-is" }),
			),
			timeoutMs: Type.Optional(Type.Number({ default: DEFAULT_TIMEOUT_MS })),
		}),
		async execute(_toolCallId, params, signal) {
			const url = new URL(params.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error(`Unsupported protocol: ${url.protocol}`);
			}

			const ghResult = await executeGhRouting(params, url, signal ?? undefined);
			if (ghResult) return ghResult;

			const headers = new Headers(params.headers ?? {});
			if (!headers.has("user-agent")) headers.set("user-agent", FIREFOX_UA);
			if (!headers.has("accept")) headers.set("accept", DEFAULT_ACCEPT);
			if (!headers.has("accept-language"))
				headers.set("accept-language", "en-US,en;q=0.5");

			const controller = new AbortController();
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort);
			const timer = setTimeout(
				() => controller.abort(new Error("fetch timeout")),
				params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			);

			try {
				const res = await fetch(url, {
					method: params.method ?? "GET",
					headers,
					body: params.body,
					signal: controller.signal,
					redirect: "follow",
				});

				const ct = res.headers.get("content-type") ?? "";
				const charset = parseCharset(ct);
				const header = [
					`HTTP ${res.status} ${res.statusText}`,
					`Content-Type: ${ct}`,
					`Charset: ${charset}`,
				];

				// HEAD or bodyless response: headers only.
				if (!res.body || (params.method ?? "GET") === "HEAD") {
					return {
						content: [{ type: "text", text: [...header, "Length: 0 (no body)"].join("\n") }],
						details: { url: res.url, status: res.status, contentType: ct, charset, bytes: 0 } as FetchToolDetails,
					};
				}

				const collected = await collectBody(res, ct, params.raw ?? false);
				const baseDetails: FetchToolDetails = {
					url: res.url,
					status: res.status,
					contentType: ct,
					charset,
					bytes: collected.bytes,
					truncated: collected.truncated,
					category: collected.category,
				};

				if (collected.category === "binary") {
					const note = collected.truncated ? " (truncated to 50MB)" : "";
					return {
						content: [{
							type: "text",
							text: [
								...header,
								`Body: ${formatSize(collected.bytes)}${note} binary (${mimeType(ct) || "unknown"}) — saved untouched for processing`,
								`Saved-To: ${collected.file}`,
								"",
								"Binary content is not decoded. Use the appropriate tool to process the file at the path above.",
							].join("\n"),
						}],
						details: { ...baseDetails, spilled: true, file: collected.file },
					};
				}

				const decoded = decodeBuffer(collected.buffer!, charset);
				let body: string;
				let effectiveCategory: "markdown" | "json" | "text" = collected.category;
				if (collected.category === "markdown") {
					const md = htmlToMarkdown(decoded, res.url);
					if (md !== null) {
						body = md;
					} else {
						body = decoded; // raw HTML text fallback
						effectiveCategory = "text";
					}
				} else if (collected.category === "json") {
					body = prettyJson(decoded);
				} else {
					body = decoded;
				}

				baseDetails.category = effectiveCategory;
				const truncNote = collected.truncated ? "\n[Note: source truncated at 1MB — content may be partial]" : "";
				const lengthLine = `Length: ${collected.bytes}${collected.truncated ? " (truncated to 1MB)" : ""}`;
				const { spill, bytes: bodyBytes, lines: lineCount } = applyGate(body);
				baseDetails.lines = lineCount;

				if (!spill) {
					return {
						content: [{ type: "text", text: [...header, lengthLine, "", body + truncNote].join("\n") }],
						details: { ...baseDetails, spilled: false },
					};
				}

				const ext = textExtension(effectiveCategory, ct);
				const file = spillToFile(res.url, body, ext);
				const grepHint = effectiveCategory === "markdown"
					? "Read slices of this file with the read tool (offset/limit) or grep it; do not read the whole file unless you must. Markdown is grep-able by heading (^#)."
					: "Read slices of this file with the read tool (offset/limit) or grep it; do not read the whole file unless you must.";
				return {
					content: [{
						type: "text",
						text: [
							...header,
							lengthLine,
							`Body: ${formatSize(bodyBytes)} across ${lineCount} lines — written to file (too large to inline)`,
							`Saved-To: ${file}`,
							...(collected.truncated ? ["[Note: source truncated at 1MB — content may be partial]"] : []),
							"",
							grepHint,
							"",
							`----- preview (first ${PREVIEW_LINES} lines) -----`,
							buildPreview(body),
						].join("\n"),
					}],
					details: { ...baseDetails, spilled: true, file },
				};
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("fetch "));
			const method = args.method ?? "GET";
			if (method !== "GET") {
				text += theme.fg("warning", `${method} `);
			}
			text += theme.fg("accent", args.url ?? "");
			if (args.raw) {
				text += theme.fg("dim", " (raw)");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const details = result.details as FetchToolDetails | undefined;
			const content = result.content[0];
			const fullText = content?.type === "text" ? content.text : "";

			if (context.isError) {
				const firstLine = fullText.split("\n")[0] || "fetch failed";
				return new Text(theme.fg("error", firstLine), 0, 0);
			}

			const isGh = details?.via === "gh";
			const status = details?.status;
			const statusStyled = isGh
				? theme.fg("success", "gh")
				: status === undefined
					? theme.fg("muted", "HTTP ?")
					: status >= 200 && status < 300
						? theme.fg("success", `HTTP ${status}`)
						: status >= 300 && status < 400
							? theme.fg("warning", `HTTP ${status}`)
							: theme.fg("error", `HTTP ${status}`);

			const sep = theme.fg("dim", " · ");
			const parts: string[] = [statusStyled];
			if (isGh) {
				if (details?.ghCommand) parts.push(theme.fg("muted", details.ghCommand));
			} else if (details?.contentType) {
				parts.push(theme.fg("muted", details.contentType.split(";")[0].trim()));
			}
			if (typeof details?.bytes === "number") {
				let sizeText = formatSize(details.bytes);
				if (details.truncated) sizeText += " (truncated)";
				parts.push(theme.fg("dim", sizeText));
			}
			if (details?.category === "binary") {
				parts.push(theme.fg("warning", "binary → file"));
			} else if (details?.spilled) {
				parts.push(theme.fg("warning", "→ file"));
			}

			let text = parts.join(sep);

			if (!expanded) {
				const lineCount = details?.lines ?? (fullText ? fullText.split("\n").length : 0);
				if (lineCount > 0) {
					text += sep + theme.fg("dim", `${lineCount} lines`);
				}
				text += " " + theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`);
				return new Text(text, 0, 0);
			}

			if (fullText) {
				for (const line of fullText.split("\n")) {
					text += `\n${theme.fg("toolOutput", line)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});
}
