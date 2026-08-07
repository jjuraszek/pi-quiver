/**
 * doc_to_md Extension
 *
 * Registers a `doc_to_md` tool that converts a local PDF, DOCX, or PPTX file
 * to Markdown. Primary engine: pymupdf4llm via ephemeral `uv run --with`
 * (warm-once per process, no repo venv). Fallback: unpdf pure-JS text
 * extraction (degraded, explicitly marked). DOCX/PPTX convert to PDF first
 * via headless soffice, then feed the PDF pipeline. Output over 32 KB or
 * 1000 lines is spilled to a temp .md file with a 60-line preview; smaller
 * content is returned inline.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// --- Types ---

export type InputType = "pdf" | "docx" | "pptx";
export type Engine = "pymupdf4llm" | "unpdf";

export interface DocToMdConfig {
	pymupdfVersion: string;
	warmTimeoutMs: number;
	convertTimeoutMs: number;
	sofficeTimeoutMs: number;
}

export interface DocToMdDetails {
	path: string;
	inputType: InputType;
	engine: Engine;
	degraded: boolean;
	bytes: number;
	lines: number;
	spilled: boolean;
	file?: string;
}

export interface CappedResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	capped: boolean;
}

// --- Constants ---

const DEFAULT_PYMUPDF_VERSION = "1.27.2.3";
const WARM_TIMEOUT_DEFAULT = 120_000;
const CONVERT_TIMEOUT_DEFAULT = 60_000;
const SOFFICE_TIMEOUT_DEFAULT = 120_000;
const STDERR_CAP = 1_000_000;
const INLINE_MAX_BYTES = 32_000;
const INLINE_MAX_LINES = 1_000;
const PREVIEW_LINES = 60;
const PREVIEW_MAX_BYTES = 4_000;
const VERSION_RE = /^\d+(\.\d+)*$/;
const PAGE_SEP = "\n\n---\n\n";
export const OUTPUT_MAX_BYTES = 20_000_000;

export const DEGRADED_MARKER =
	"[Note: degraded extraction via unpdf — structure (tables/headings) not preserved]";

// --- Config ---

export function parseConfig(env: NodeJS.ProcessEnv): DocToMdConfig {
	const version = env.PI_DOC_TO_MD_PYMUPDF_VERSION ?? DEFAULT_PYMUPDF_VERSION;
	if (!VERSION_RE.test(version)) {
		throw new Error(`PI_DOC_TO_MD_PYMUPDF_VERSION must be digits and dots (got "${version}")`);
	}
	const num = (key: string, def: number): number => {
		const raw = env[key];
		if (raw === undefined) return def;
		const n = Number.parseInt(raw, 10);
		if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer (got "${raw}")`);
		return n;
	};
	return {
		pymupdfVersion: version,
		warmTimeoutMs: num("PI_DOC_TO_MD_WARM_TIMEOUT_MS", WARM_TIMEOUT_DEFAULT),
		convertTimeoutMs: num("PI_DOC_TO_MD_CONVERT_TIMEOUT_MS", CONVERT_TIMEOUT_DEFAULT),
		sofficeTimeoutMs: num("PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS", SOFFICE_TIMEOUT_DEFAULT),
	};
}

// --- Input classification ---

const SUPPORTED: Record<string, InputType> = { ".pdf": "pdf", ".docx": "docx", ".pptx": "pptx" };

export function classifyInput(filePath: string): InputType {
	const ext = extname(filePath).toLowerCase();
	const t = SUPPORTED[ext];
	if (!t) throw new Error(`Unsupported file type "${ext || "(none)"}"; supported: .pdf, .docx, .pptx`);
	return t;
}

// --- Size gate ---

export function applyGate(body: string): { spill: boolean; bytes: number; lines: number } {
	const bytes = Buffer.byteLength(body, "utf8");
	const lines = body.length ? body.split("\n").length : 0;
	const spill = body.length > 0 && (bytes > INLINE_MAX_BYTES || lines > INLINE_MAX_LINES);
	return { spill, bytes, lines };
}

// --- Markdown helpers ---

export function withMarker(md: string, degraded: boolean): string {
	return degraded ? `${DEGRADED_MARKER}\n\n${md}` : md;
}

export function pagesToMarkdown(pages: string[]): string {
	return pages.map((p) => p.trim()).filter((p) => p.length > 0).join(PAGE_SEP);
}

// --- Temp file helpers ---

export function tempFilePath(inputPath: string, ext: string): string {
	const dir = join(tmpdir(), "pi-doc-to-md");
	mkdirSync(dir, { recursive: true });
	const base = basename(inputPath).replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
	const hash = createHash("sha1").update(resolve(inputPath)).digest("hex").slice(0, 8);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(dir, `${stamp}-${base}-${hash}.${ext}`);
}

export function spillToFile(inputPath: string, body: string): string {
	const file = tempFilePath(inputPath, "md");
	writeFileSync(file, body, "utf8");
	return file;
}

export function buildPreview(body: string): string {
	let preview = body.split("\n").slice(0, PREVIEW_LINES).join("\n");
	if (preview.length > PREVIEW_MAX_BYTES) {
		preview = `${preview.slice(0, PREVIEW_MAX_BYTES)}\n…[preview truncated]`;
	}
	return preview;
}

// --- Subprocess argv builders ---

export function warmArgs(cfg: DocToMdConfig): string[] {
	return ["run", "--with", `pymupdf4llm==${cfg.pymupdfVersion}`, "--python", "3.14", "python", "-c", "import pymupdf4llm"];
}

export function convertArgs(cfg: DocToMdConfig, scriptPath: string, pdfPath: string): string[] {
	return ["run", "--with", `pymupdf4llm==${cfg.pymupdfVersion}`, "--python", "3.14", "python", scriptPath, pdfPath];
}

export function soffArgs(src: string, profileDir: string, outDir: string): string[] {
	return [
		"--headless", "--invisible", "--nocrashreport", "--nodefault", "--nofirststartwizard",
		"--nolockcheck", "--nologo", "--norestore", "--quickstart=no",
		`-env:UserInstallation=file://${profileDir}`,
		"--convert-to", "pdf", "--outdir", outDir, src,
	];
}

// --- Subprocess runner ---

export async function runCapped(
	cmd: string,
	args: string[],
	opts: { timeoutMs: number; capBytes: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<CappedResult> {
	return new Promise((resolveP) => {
		let settled = false;
		let timedOut = false;
		let capped = false;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;

		const child = spawn(cmd, args, { env: opts.env ?? process.env });

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolveP({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				code,
				timedOut,
				capped,
			});
		};

		const kill = () => child.kill("SIGKILL");

		const onAbort = () => { kill(); };
		if (opts.signal?.aborted) { kill(); }
		else opts.signal?.addEventListener("abort", onAbort);

		const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			if (capped) return;
			const remaining = opts.capBytes - stdoutBytes;
			if (remaining <= 0) { capped = true; kill(); return; }
			if (chunk.length > remaining) {
				stdoutChunks.push(chunk.subarray(0, remaining));
				stdoutBytes += remaining;
				capped = true;
				kill();
			} else {
				stdoutChunks.push(chunk);
				stdoutBytes += chunk.length;
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBytes >= STDERR_CAP) return;
			const remaining = STDERR_CAP - stderrBytes;
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			stderrChunks.push(slice);
			stderrBytes += slice.length;
		});

		child.on("error", (err) => {
			if (stderrBytes < STDERR_CAP) {
				const msg = Buffer.from(err.message);
				const remaining = STDERR_CAP - stderrBytes;
				stderrChunks.push(msg.length > remaining ? msg.subarray(0, remaining) : msg);
			}
			finish(null);
		});

		child.on("close", (code) => finish(code));
	});
}

// --- Engine orchestration ---

let pymupdfState: "unknown" | "warm" | "unavailable" = "unknown";
let warmPromise: Promise<"warm" | "unavailable"> | null = null;
let uvAvailable: boolean | null = null;

function scriptPath(): string {
	return fileURLToPath(new URL("../scripts/pdf_to_md.py", import.meta.url));
}

async function onPath(cmd: string): Promise<boolean> {
	const r = await runCapped("which", [cmd], { timeoutMs: 5000, capBytes: 4000 });
	return r.code === 0;
}

async function warmPymupdf(cfg: DocToMdConfig): Promise<"warm" | "unavailable"> {
	if (pymupdfState !== "unknown") return pymupdfState;
	if (warmPromise === null) {
		warmPromise = (async () => {
			const r = await runCapped("uv", warmArgs(cfg), { timeoutMs: cfg.warmTimeoutMs, capBytes: OUTPUT_MAX_BYTES });
			pymupdfState = (r.code === 0 && !r.timedOut) ? "warm" : "unavailable";
			return pymupdfState;
		})();
	}
	return warmPromise;
}

async function convertViaPymupdf(cfg: DocToMdConfig, pdfPath: string, signal?: AbortSignal): Promise<string> {
	const r = await runCapped("uv", convertArgs(cfg, scriptPath(), pdfPath), {
		timeoutMs: cfg.convertTimeoutMs, capBytes: OUTPUT_MAX_BYTES, signal,
	});
	if (r.timedOut || r.capped || r.code !== 0) {
		throw new Error(`pymupdf4llm convert failed (code=${r.code} timedOut=${r.timedOut} capped=${r.capped}): ${r.stderr.slice(0, 500)}`);
	}
	return r.stdout;
}

async function convertViaUnpdf(pdfPath: string, cfg: DocToMdConfig, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("aborted");
	const buf = readFileSync(pdfPath);
	const work = (async () => {
		const pdf = await getDocumentProxy(new Uint8Array(buf));
		const { text } = await extractText(pdf, { mergePages: false });
		const md = pagesToMarkdown(text);
		if (Buffer.byteLength(md, "utf8") > OUTPUT_MAX_BYTES) throw new Error("unpdf output exceeded cap");
		return md;
	})();
	let timer: NodeJS.Timeout;
	const timeout = new Promise<never>((_, rej) => {
		timer = setTimeout(() => rej(new Error("unpdf conversion timed out")), cfg.convertTimeoutMs);
	});
	try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer!); }
}

async function convertOffice(cfg: DocToMdConfig, src: string): Promise<{ pdfPath: string; cleanup: () => void }> {
	const profileDir = mkdtempSync(join(tmpdir(), "pi-doc-soffice-prof-"));
	const outDir = mkdtempSync(join(tmpdir(), "pi-doc-soffice-out-"));
	const cleanup = () => {
		for (const d of [profileDir, outDir]) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	};
	try {
		const env = { ...process.env, SAL_USE_VCLPLUGIN: "svp", OOO_DISABLE_RECOVERY: "1", SAL_NO_MOUSEGRABS: "1" };
		const r = await runCapped("soffice", soffArgs(src, profileDir, outDir), { timeoutMs: cfg.sofficeTimeoutMs, capBytes: OUTPUT_MAX_BYTES, env });
		if (r.timedOut || r.code !== 0) throw new Error(`soffice failed (code=${r.code} timedOut=${r.timedOut}): ${r.stderr.slice(0, 500)}`);
		const base = basename(src).replace(/\.[^.]+$/, "");
		const pdfPath = join(outDir, `${base}.pdf`);
		const st = statSync(pdfPath, { throwIfNoEntry: false });
		if (!st || !st.isFile() || st.size === 0) throw new Error("soffice produced no usable PDF");
		return { pdfPath, cleanup };
	} catch (e) { cleanup(); throw e; }
}

export async function runPipeline(
	cfg: DocToMdConfig,
	inputPath: string,
	type: InputType,
	signal?: AbortSignal,
): Promise<{ markdown: string; engine: Engine; degraded: boolean; fallbackReason?: string }> {
	let pdfPath = inputPath;
	let cleanup: (() => void) | null = null;
	if (type === "docx" || type === "pptx") {
		const o = await convertOffice(cfg, inputPath);
		pdfPath = o.pdfPath;
		cleanup = o.cleanup;
	}
	try {
		if (uvAvailable === null) uvAvailable = await onPath("uv");
		if (!uvAvailable) {
			return { markdown: await convertViaUnpdf(pdfPath, cfg, signal), engine: "unpdf", degraded: true, fallbackReason: "uv not on PATH" };
		}
		const state = await warmPymupdf(cfg);
		if (state === "warm") {
			try {
				return { markdown: await convertViaPymupdf(cfg, pdfPath, signal), engine: "pymupdf4llm", degraded: false };
			} catch (e) {
				const fallbackReason = e instanceof Error ? e.message : String(e);
				return { markdown: await convertViaUnpdf(pdfPath, cfg, signal), engine: "unpdf", degraded: true, fallbackReason };
			}
		}
		return { markdown: await convertViaUnpdf(pdfPath, cfg, signal), engine: "unpdf", degraded: true, fallbackReason: "pymupdf4llm engine unavailable (warm probe failed)" };
	} finally {
		cleanup?.();
	}
}

// --- Extension entry point ---

export default function docToMdExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "doc_to_md",
		label: "Convert doc to Markdown",
		description:
			"Convert a local PDF/DOCX/PPTX file to Markdown. High-fidelity conversion via pymupdf4llm (run through uv, fetched on first use); falls back to a degraded pure-JS text extractor (unpdf) when uv/Python is unavailable or conversion times out. DOCX/PPTX require LibreOffice (soffice) for the office->PDF step. Output over 32KB or 1000 lines is written to a temp .md file with a preview instead of inlined - grep it or read with offset/limit. A degraded result (marked in the output) means the fallback ran: tables and headings are NOT faithfully preserved, treat structure with suspicion. Input must be a local file path (use fetch first for URLs).",
		promptSnippet: "Convert a local PDF/DOCX/PPTX to Markdown",
		parameters: Type.Object({
			path: Type.String({ description: "Local path to a .pdf, .docx, or .pptx file" }),
		}),

		async execute(_toolCallId, params, signal) {
			const cfg = parseConfig(process.env);
			const inputPath = resolve(params.path);
			const st = statSync(inputPath, { throwIfNoEntry: false });
			if (!st || !st.isFile()) throw new Error(`Not a readable file: ${params.path}`);
			const type = classifyInput(inputPath);
			if (type !== "pdf") {
				if (!(await onPath("soffice"))) {
					throw new Error("LibreOffice (soffice) is required to convert .docx/.pptx but was not found on PATH. Install LibreOffice or convert the file to PDF first.");
				}
			}
			const { markdown, engine, degraded, fallbackReason } = await runPipeline(cfg, inputPath, type, signal);
			const body = withMarker(markdown, degraded);
			const { spill, bytes, lines } = applyGate(body);
			const details: DocToMdDetails = { path: inputPath, inputType: type, engine, degraded, bytes, lines, spilled: spill };

			const header: string[] = [
				`Source: ${inputPath}`,
				`Type: ${type}  Engine: ${engine}${degraded ? " (degraded fallback)" : ""}`,
			];
			if (fallbackReason) header.push(`Fallback-Reason: ${fallbackReason}`);

			if (!spill) {
				return {
					content: [{ type: "text" as const, text: [...header, `Length: ${bytes} bytes, ${lines} lines`, "", body].join("\n") }],
					details: { ...details, spilled: false },
				};
			}

			const file = spillToFile(inputPath, body);
			return {
				content: [{
					type: "text" as const,
					text: [
						...header,
						`Body: ${formatSize(bytes)} across ${lines} lines — written to file (too large to inline)`,
						`Saved-To: ${file}`,
						"",
						"Read slices of this file with the read tool (offset/limit) or grep it; do not read the whole file unless you must. Markdown is grep-able by heading (^#).",
						"",
						"----- preview (first 60 lines) -----",
						buildPreview(body),
					].join("\n"),
				}],
				details: { ...details, spilled: true, file },
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("doc_to_md "));
			text += theme.fg("accent", args.path ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Converting..."), 0, 0);
			}

			const details = result.details as DocToMdDetails | undefined;
			const content = result.content[0];
			const fullText = content?.type === "text" ? content.text : "";

			if (context.isError) {
				const firstLine = fullText.split("\n")[0] || "doc_to_md failed";
				return new Text(theme.fg("error", firstLine), 0, 0);
			}

			const sep = theme.fg("dim", " · ");
			const parts: string[] = [];
			parts.push(theme.fg("muted", details?.inputType ?? "?"));
			parts.push(
				details?.degraded
					? theme.fg("warning", "unpdf (degraded)")
					: theme.fg("muted", "pymupdf4llm"),
			);
			parts.push(theme.fg("dim", formatSize(details?.bytes ?? 0)));
			if (details?.spilled) parts.push(theme.fg("warning", "→ file"));

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
