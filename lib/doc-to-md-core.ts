/**
 * doc-to-md core (pi-free)
 *
 * Converts local PDF, DOCX, PPTX, XLSX, and XLS documents into disk bundles
 * with concise handles. PDF uses primary pymupdf4llm, PyMuPDF-text fallback,
 * then unpdf when no Python backend exists. DOCX converts directly in the Python child (mammoth, python-docx fallback)
 * and falls back to headless soffice -> PDF; PPTX always goes through soffice.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type StagedPage, type Bundle, abortBundle, commitBundle, openBundle, publishAttachments, publishSidecars, publishWords, writePageStats, publishPageImages, publishSheetCsvs, publishSheetImages, publishStaged, rewriteLinks, tempBundleRoot, validateImageLinks } from "./doc-to-md-bundle.ts";
import { type NativeImage, type Engine, type HandleData, type InfoData, type OcrInfo, type PageStat, type Tier, formatHandle, formatInfoHandle, scanOutline, type SheetInfo, type TocEntry } from "./doc-to-md-handle.ts";
import { type DocToMdOptions, type InputType, IMAGE_EXTS, TUNABLE_DEFAULTS, UsageError, classifyInput, sanitizeStem } from "./doc-to-md-options.ts";

export * from "./doc-to-md-options.ts";
export { compactRanges, formatHandle, formatInfoHandle, formatSize, scanOutline } from "./doc-to-md-handle.ts";
export type { Engine, HandleData, InfoData, OutlineEntry, SheetInfo, Tier, TocEntry } from "./doc-to-md-handle.ts";

// --- Types ---

export const PACKAGE_PINS = { pymupdf4llm: TUNABLE_DEFAULTS.pymupdfVersion, openpyxl: "3.1.5", xlrd: "2.0.2", pillow: "12.3.0", mammoth: "1.13.0", markdownify: "1.2.3", "python-docx": "1.2.0", "extract-msg": "0.56.1" } as const;
export const KILL_GRACE_MS = 2000;
export const VENV_DIR_NAME = "doc-to-md-venv-v4";
export const LEGACY_VENV_DIR_NAMES = ["pymupdf-venv", "doc-to-md-venv-v2", "doc-to-md-venv-v3"] as const;
const STDERR_CAP = 1_000_000;
export const OUTPUT_MAX_BYTES = 20_000_000;
export const EXCEL_PDF_FILTER = 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}';

export interface BackendConfig { pymupdfVersion: string; warmTimeoutMs: number; }

export interface CappedResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	capped: boolean;
}

// --- Subprocess argv builders ---

const pinSpecs = (cfg: BackendConfig) => [`pymupdf4llm==${cfg.pymupdfVersion}`, `openpyxl==${PACKAGE_PINS.openpyxl}`, `xlrd==${PACKAGE_PINS.xlrd}`, `pillow==${PACKAGE_PINS.pillow}`, `mammoth==${PACKAGE_PINS.mammoth}`, `markdownify==${PACKAGE_PINS.markdownify}`, `python-docx==${PACKAGE_PINS["python-docx"]}`, `extract-msg==${PACKAGE_PINS["extract-msg"]}`];

function withArgs(cfg: BackendConfig): string[] { return pinSpecs(cfg).flatMap((spec) => ["--with", spec]); }

export function pipInstallArgs(cfg: BackendConfig): string[] { return ["-m", "pip", "install", ...pinSpecs(cfg)]; }

export function warmArgs(cfg: BackendConfig): string[] {
	return ["run", ...withArgs(cfg), "--python", "3.14", "python", "-c", "import pymupdf4llm, openpyxl, xlrd, PIL, mammoth, markdownify, docx, extract_msg"];
}

export function uvChildArgs(cfg: BackendConfig, script: string, mode: string): string[] {
	return ["run", ...withArgs(cfg), "--python", "3.14", "python", script, mode];
}

export function pythonChildArgs(script: string, mode: string): string[] { return [script, mode]; }

export function soffArgs(src: string, profileDir: string, outDir: string, filter = "pdf"): string[] {
	return [
		"--headless", "--invisible", "--nocrashreport", "--nodefault", "--nofirststartwizard",
		"--nolockcheck", "--nologo", "--norestore", "--quickstart=no",
		`-env:UserInstallation=${pathToFileURL(profileDir).href}`,
		"--convert-to", filter, "--outdir", outDir, src,
	];
}

// --- Subprocess runner ---

const LIVE = new Set<ChildProcess>();

function killTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform === "win32") spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
		else process.kill(-child.pid, "SIGKILL");
	} catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

process.on("exit", () => { for (const c of LIVE) killTree(c); });

// Children run detached (own process group) so killTree can take out python + raster
// worker + soffice at once; the flip side is that a signal that kills this process never
// reaches them, and the "exit" hook does not run on a signal death. The CLI opts in to
// turning TERM/INT/HUP into a normal exit so the hook fires; pi's own host keeps its handlers.
const SIGNAL_EXIT_CODES = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
export function exitOnSignalKillingChildren(): void {
	if (process.platform === "win32") return;
	for (const [sig, num] of Object.entries(SIGNAL_EXIT_CODES)) process.on(sig as NodeJS.Signals, () => process.exit(128 + num));
}

export async function runCapped(
	cmd: string,
	args: string[],
	opts: { timeoutMs: number; capBytes: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string },
): Promise<CappedResult> {
	return new Promise((resolveP) => {
		let settled = false;
		let timedOut = false;
		let capped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;

		const child = spawn(cmd, args, { env: opts.env ?? process.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
		LIVE.add(child);

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			LIVE.delete(child);
			clearTimeout(timer);
			clearTimeout(graceTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolveP({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				code,
				timedOut,
				capped,
			});
		};

		const kill = () => {
			killTree(child);
			graceTimer ??= setTimeout(() => finish(null), KILL_GRACE_MS);
		};

		const onAbort = () => { kill(); };
		if (opts.signal?.aborted) { kill(); }
		else opts.signal?.addEventListener("abort", onAbort);

		timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);

		child.stdin.on("error", (err: NodeJS.ErrnoException) => { if (err.code !== "EPIPE") throw err; });
		child.stdin.write(opts.stdin ?? "");
		child.stdin.end();

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

export function findPackageRoot(startDir: string): string {
	let dir = startDir;
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`package.json not found walking up from ${startDir}`);
		dir = parent;
	}
}

export function scriptPath(): string {
	return join(findPackageRoot(dirname(fileURLToPath(import.meta.url))), "scripts", "doc_to_md.py");
}

// --- Backend resolver ---

export const PROBE_PROGRAM = `import sys
print("PY", sys.version_info[0], sys.version_info[1])
try:
    # pymupdf4llm.__version__ >= 1.27.0
    import pymupdf, pymupdf4llm
    v = tuple(int(x) for x in pymupdf4llm.__version__.split(".")[:3])
    print("PDF", "yes" if v >= (1, 27, 0) else "no")
except Exception:
    print("PDF", "no")
try:
    import openpyxl, xlrd, PIL
    print("XLSX", "yes")
except Exception:
    print("XLSX", "no")
try:
    import mammoth, markdownify, docx
    print("DOCX", "yes")
except Exception:
    print("DOCX", "no")
try:
    import extract_msg, markdownify
    print("EMAIL", "yes")
except Exception:
    print("EMAIL", "no")
`;
export const PROBE_TIMEOUT_MS = 5000;

export function probeArgs(): string[] {
	return ["-c", PROBE_PROGRAM];
}
export const PYTHON_CANDIDATES = ["python3", "python"] as const;

export type BackendKind = "uv" | "python" | "venv" | "none";
export type Backend =
	| { kind: "uv"; pdf: true; xlsx: true; docx: true; email: true }
	| { kind: "python"; exe: string; pdf: boolean; xlsx: boolean; docx: boolean; email: boolean }
	| { kind: "venv"; exe: string; pdf: true; xlsx: true; docx: true; email: true }
	| { kind: "none"; reason: string };

export interface ProbeResult { major: number; minor: number; pdf: boolean; xlsx: boolean; docx: boolean; email: boolean; }

export function parseProbeOutput(stdout: string): ProbeResult | null {
	const m = stdout.match(/^PY (\d+) (\d+)\r?\nPDF (yes|no)\r?\nXLSX (yes|no)\r?\nDOCX (yes|no)\r?\nEMAIL (yes|no)\s*$/);
	return m ? { major: Number(m[1]), minor: Number(m[2]), pdf: m[3] === "yes", xlsx: m[4] === "yes", docx: m[5] === "yes", email: m[6] === "yes" } : null;
}

export function meetsFloor(p: ProbeResult): boolean {
	return p.major > 3 || (p.major === 3 && p.minor >= 12);
}

export function cacheDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
	if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "pi-quiver");
	if (platform === "darwin") return join(home, "Library", "Caches", "pi-quiver");
	return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "pi-quiver");
}

export function venvPython(venvDir: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

export type RunFn = (cmd: string, args: string[], opts: { timeoutMs: number; capBytes: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<CappedResult>;

export interface ResolverDeps {
	run: RunFn;
	cacheRoot: string;
	platform: NodeJS.Platform;
	pid: number;
	rename: (from: string, to: string) => void;
	rmrf: (path: string) => void;
	now: () => number;
	env?: NodeJS.ProcessEnv;
}

const tail = (s: string) => s.slice(-500).trim();

export async function resolveBackend(cfg: BackendConfig, deps: ResolverDeps, signal?: AbortSignal): Promise<Backend> {
	if (signal?.aborted) throw new Error("aborted");
	const deadline = deps.now() + cfg.warmTimeoutMs;
	const left = () => Math.max(1, deadline - deps.now());
	const expired = (tmp?: string): Extract<Backend, { kind: "none" }> | null => {
		if (deadline - deps.now() > 0) return null;
		if (tmp) deps.rmrf(tmp);
		return { kind: "none", reason: `backend discovery exceeded warmTimeoutMs (${cfg.warmTimeoutMs}ms) - raise warmTimeoutMs, or install uv` };
	};
	const warm = await deps.run("uv", warmArgs(cfg), { timeoutMs: left(), capBytes: OUTPUT_MAX_BYTES, env: deps.env, signal });
	if (signal?.aborted) throw new Error("aborted");
	if (warm.code === 0 && !warm.timedOut) return { kind: "uv", pdf: true, xlsx: true, docx: true, email: true };
	const uvAbsent = warm.code === null && !warm.timedOut; // spawn error (ENOENT)

	type ProbeOutcome = ProbeResult | Extract<Backend, { kind: "none" }> | null;
	const isDeadline = (result: ProbeOutcome): result is Extract<Backend, { kind: "none" }> => result !== null && "kind" in result;
	const probe = async (exe: string, tmp?: string): Promise<ProbeOutcome> => {
		const timeout = expired(tmp);
		if (timeout) return timeout;
		const r = await deps.run(exe, probeArgs(), { timeoutMs: Math.min(PROBE_TIMEOUT_MS, left()), capBytes: 4000, env: deps.env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (r.code !== 0 || r.timedOut) return null;
		return parseProbeOutput(r.stdout);
	};

	let eligible: { exe: string; version: string } | null = null;
	for (const exe of PYTHON_CANDIDATES) {
		const p = await probe(exe);
		if (isDeadline(p)) return p;
		if (!p || !meetsFloor(p)) continue;
		if (p.pdf) return { kind: "python", exe, pdf: true, xlsx: p.xlsx, docx: p.docx, email: p.email };
		eligible ??= { exe, version: `${p.major}.${p.minor}` };
	}

	const healthy = (p: ProbeResult) => meetsFloor(p) && p.pdf && p.xlsx && p.docx && p.email;
	const venvDir = join(deps.cacheRoot, VENV_DIR_NAME);
	const venvExe = venvPython(venvDir, deps.platform);
	const cached = await probe(venvExe);
	if (isDeadline(cached)) return cached;
	if (cached && healthy(cached)) return { kind: "venv", exe: venvExe, pdf: true, xlsx: true, docx: true, email: true };

	if (eligible) {
		const recheck = await probe(venvExe); // a competing process may have published since the first probe
		if (isDeadline(recheck)) return recheck;
		if (recheck && healthy(recheck)) return { kind: "venv", exe: venvExe, pdf: true, xlsx: true, docx: true, email: true };
		// Build in a sibling tmp dir without touching venvDir - a concurrent process can never probe a half-built venv.
		const tmp = `${venvDir}.tmp-${deps.pid}`;
		const bootFail = (stderr: string): Backend => {
			deps.rmrf(tmp);
			return { kind: "none", reason: `python ${eligible!.version} found but venv bootstrap failed: ${tail(stderr)} - install python3-venv, or uv` };
		};
		const mkTimeout = expired(tmp);
		if (mkTimeout) return mkTimeout;
		const mk = await deps.run(eligible.exe, ["-m", "venv", tmp], { timeoutMs: left(), capBytes: OUTPUT_MAX_BYTES, env: deps.env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (mk.code !== 0 || mk.timedOut) return bootFail(mk.stderr);
		const pipTimeout = expired(tmp);
		if (pipTimeout) return pipTimeout;
		const pip = await deps.run(venvPython(tmp, deps.platform), pipInstallArgs(cfg), { timeoutMs: left(), capBytes: OUTPUT_MAX_BYTES, env: deps.env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (pip.code !== 0 || pip.timedOut) return bootFail(pip.stderr);
		const publish = (): boolean => {
			try { deps.rename(tmp, venvDir); return true; } catch { return false; }
		};
		if (publish()) {
			for (const legacy of LEGACY_VENV_DIR_NAMES) deps.rmrf(join(deps.cacheRoot, legacy));
			return { kind: "venv", exe: venvExe, pdf: true, xlsx: true, docx: true, email: true };
		}
		// Rename failed - a competing process may have published first, or venvDir holds a stale/broken dir.
		const winner = await probe(venvExe, tmp);
		if (isDeadline(winner)) return winner;
		if (winner && healthy(winner)) {
			deps.rmrf(tmp); // healthy winner - clean up our loser
			return { kind: "venv", exe: venvExe, pdf: true, xlsx: true, docx: true, email: true };
		}
		deps.rmrf(venvDir); // unhealthy/absent dest - clear it and retry the rename once
		if (publish()) {
			for (const legacy of LEGACY_VENV_DIR_NAMES) deps.rmrf(join(deps.cacheRoot, legacy));
			return { kind: "venv", exe: venvExe, pdf: true, xlsx: true, docx: true, email: true };
		}
		return bootFail("rename after competing bootstrap");
	}

	return uvAbsent
		? { kind: "none", reason: "uv not found; no python >= 3.12 on PATH - install uv, or Python 3.12+" }
		: { kind: "none", reason: `uv warm-up failed: ${tail(warm.stderr)}; no python >= 3.12 on PATH` };
}

let backendPromise: Promise<Backend> | null = null;

function realDeps(): ResolverDeps {
	return {
		run: runCapped,
		cacheRoot: cacheDir(process.platform, process.env, homedir()),
		platform: process.platform,
		pid: process.pid,
		rename: renameSync,
		rmrf: (p) => rmSync(p, { recursive: true, force: true }),
		now: Date.now,
		env: process.env,
	};
}

export function getBackend(cfg: BackendConfig, deps?: ResolverDeps, signal?: AbortSignal): Promise<Backend> {
	if (!backendPromise) {
		const promise = resolveBackend(cfg, deps ?? realDeps(), signal);
		backendPromise = promise;
		// An aborted (or otherwise failed) first resolution must not poison the session for later callers.
		promise.catch(() => { if (backendPromise === promise) backendPromise = null; });
	}
	return backendPromise;
}

export function resetBackendCacheForTests(): void {
	backendPromise = null;
}

export type OfficeResult =
	| { ok: true; pdfPath: string; cleanup: () => void }
	| { ok: false; kind: "missing" | "timeout" | "exit" | "no-pdf"; code: number | null; timedOut: boolean; stderr: string };

export async function tryConvertOffice(sofficeTimeoutMs: number, src: string, signal?: AbortSignal, run: RunFn = runCapped, filter = "pdf"): Promise<OfficeResult> {
	const profileDir = mkdtempSync(join(tmpdir(), "pi-doc-soffice-prof-"));
	const outDir = mkdtempSync(join(tmpdir(), "pi-doc-soffice-out-"));
	const cleanup = () => { for (const d of [profileDir, outDir]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };
	try {
		const env = { ...process.env, SAL_USE_VCLPLUGIN: "svp", OOO_DISABLE_RECOVERY: "1", SAL_NO_MOUSEGRABS: "1" };
		const r = await run("soffice", soffArgs(src, profileDir, outDir, filter), { timeoutMs: sofficeTimeoutMs, capBytes: OUTPUT_MAX_BYTES, env, signal });
		if (signal?.aborted) throw new Error("aborted");
		const fail = (kind: "missing" | "timeout" | "exit" | "no-pdf"): OfficeResult => { cleanup(); return { ok: false, kind, code: r.code, timedOut: r.timedOut, stderr: r.stderr.slice(0, 500) }; };
		if (r.code === null && !r.timedOut) return fail("missing");
		if (r.timedOut) return fail("timeout");
		if (r.code !== 0) return fail("exit");
		const pdfPath = join(outDir, `${basename(src).replace(/\.[^.]+$/, "")}.pdf`);
		const st = statSync(pdfPath, { throwIfNoEntry: false });
		if (!st || !st.isFile() || st.size === 0) return fail("no-pdf");
		return { ok: true, pdfPath, cleanup };
	} catch (e) { cleanup(); throw e; }
}

export function officeFailure(r: Extract<OfficeResult, { ok: false }>): Error {
	if (r.kind === "missing") return new Error("LibreOffice (soffice) is required to convert .docx/.pptx but was not found on PATH. Install LibreOffice or convert the file to PDF first.");
	if (r.kind === "no-pdf") return new Error("LibreOffice (soffice) ran but produced no usable PDF for this file. Ensure LibreOffice can open the document, or convert it to PDF manually first.");
	return new Error(`soffice failed (code=${r.code} timedOut=${r.timedOut}): ${r.stderr}`);
}

// --- Conversion tiers and bundle orchestration ---

export const DEGRADED_TEXT = "PyMuPDF text extraction - layout/tables not preserved";
export const DEGRADED_HTML_TURNDOWN = "Turndown HTML conversion - definition lists and headerless tables not preserved";
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|bmp|tiff);base64,([A-Za-z0-9+/=\s]+)$/i;
const DATA_EXT: Record<string, string> = { png: ".png", jpeg: ".jpg", gif: ".gif", bmp: ".bmp", tiff: ".tif" };
const DATA_SIGNATURES: Record<string, number[][]> = {
	png: [[0x89, 0x50, 0x4e, 0x47]], jpeg: [[0xff, 0xd8, 0xff]], gif: [[0x47, 0x49, 0x46, 0x38]],
	bmp: [[0x42, 0x4d]], tiff: [[0x49, 0x49, 0x2a, 0], [0x4d, 0x4d, 0, 0x2a]],
};

export interface PreparedHtml { html: string; missing: number; }

export async function prepareHtml(inputPath: string, stagingDir: string): Promise<PreparedHtml> {
	const { JSDOM } = await import("jsdom");
	const bytes = readFileSync(inputPath);
	let source: string | Buffer = bytes;
	// JSDOM mis-sniffs meta-less UTF-8 as windows-1252.
	try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* JSDOM sniffs legacy encoding */ }
	const dom = new JSDOM(source);
	const doc = dom.window.document;
	const title = doc.querySelector("title")?.textContent?.trim();
	if (title && !doc.body.querySelector("h1")) { const h1 = doc.createElement("h1"); h1.textContent = title; doc.body.prepend(h1); }
	for (const el of [...doc.querySelectorAll("head, script, style, noscript, template")]) el.remove();
	const dir = join(stagingDir, "p1");
	mkdirSync(dir, { recursive: true });
	let k = 0, missing = 0;
	for (const img of [...doc.querySelectorAll("img")]) {
		const src = (img.getAttribute("src") ?? "").trim();
		const alt = img.getAttribute("alt") ?? "";
		if (/^(?:https?:)?\/\//i.test(src)) { const a = doc.createElement("a"); const url = src.startsWith("//") ? `https:${src}` : src; a.setAttribute("href", url); a.textContent = alt || url; img.replaceWith(a); continue; }
		let target: string | null = null;
		const data = src.match(DATA_IMAGE_RE);
		if (data) {
			const buf = Buffer.from(data[2].replace(/\s+/g, ""), "base64");
			if (DATA_SIGNATURES[data[1].toLowerCase()].some((signature) => signature.every((byte, i) => buf[i] === byte))) { target = `p1/${++k}${DATA_EXT[data[1].toLowerCase()]}`; writeFileSync(join(stagingDir, target), buf); }
		} else if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !isAbsolute(src)) {
			let file: string | null = null;
			try { file = resolve(dirname(inputPath), decodeURIComponent(src.split(/[?#]/)[0])); } catch { /* malformed URL escape */ }
			const ext = file ? extname(file).toLowerCase() : "";
			if (file && IMAGE_EXTS.includes(ext) && statSync(file, { throwIfNoEntry: false })?.isFile()) { target = `p1/${++k}${ext}`; copyFileSync(file, join(stagingDir, target)); }
		}
		if (target) img.setAttribute("src", target);
		else { missing++; img.replaceWith(doc.createTextNode(alt)); }
	}
	writeFileSync(join(dir, ".done"), "");
	return { html: dom.serialize(), missing };
}

export const DEGRADED_UNPDF = "unpdf text extraction - structure not preserved";
export const DEGRADED_DOCX_TEXT = "python-docx text extraction - footnotes, hyperlinks, images not preserved";
export const DEGRADED_DOCX_OFFICE = "LibreOffice PDF route - heading styles and explicit page breaks not preserved; page numbers are LibreOffice pagination";
export const DOCX_PIP = "pip install mammoth markdownify python-docx";
export const DOCX_PAGES_OFFICE = `--pages on a DOCX needs the Python DOCX backend (explicit page-break segments); the LibreOffice route has none. Remedy: install uv, or ${DOCX_PIP}`;
const docxRemedy = `Remedy: install uv, or ${DOCX_PIP} into a Python that already has pymupdf4llm`;
const backendState = (b: Backend, missing: string) => b.kind === "none" ? b.reason : missing;
const lacksDocx = (b: Backend) => b.kind === "none" || !b.docx;
const clearStaging = (b: Pick<Bundle, "stagingDir">) => { for (const f of readdirSync(b.stagingDir)) rmSync(join(b.stagingDir, f), { recursive: true, force: true }); };
export const EXCEL_REMEDY = "Remedy: install uv, or pip install openpyxl xlrd pillow";

export type Mode = "html" | "image" | "info" | "pdf-primary" | "pdf-fallback" | "xlsx" | "pdf-text" | "render-pages" | "docx" | "email" | "ocr-pages";
export interface TierJson { words?: boolean; wordsErrors?: Record<string, string>; pageStats?: PageStat[]; status?: string; written?: number[]; noText?: number[]; ocrFailed?: number[]; ocrErrors?: Record<string, string>; budgetStopped?: number[]; pageImages?: { page: number; file: string; dpi?: number; requestedDpi?: number }[]; nativeImages?: NativeImage[]; ocr?: OcrInfo; markdown?: string; pages?: number[]; pageCount?: number; emptyPages?: number[]; failedPages?: { page: number; error: string }[]; notes?: string[]; images?: { sheetIndex: number; file: string }[]; metadata?: Record<string, string>; toc?: [number, string, number | null][]; explicitBreaks?: number; engine?: string; degraded?: boolean; fallbackReason?: string | null; sheets?: SheetInfo[]; renderPages?: number[]; sheetCount?: number; ok?: boolean; reason?: string; rendered?: { idx: number; file: string; dpi: number }[]; failed?: { idx: number; reason: string }[]; }
export type TierResult = { ok: true; json: TierJson } | { ok: false; reason: string; detail?: string } | { ok: false; userError: string; pageCount?: number };

export interface PipelineSeams {
	backend: (cfg: BackendConfig) => Promise<Backend>;
	runTier: (mode: Mode, childOptions: Record<string, unknown>, bundle: Pick<Bundle, "stagingDir">, signal: AbortSignal | undefined, timeoutMs: number, backend: Backend) => Promise<TierResult>;
	office: typeof tryConvertOffice;
}

export function resolveUnpdfWorker(candidates: string[], exists: (path: string) => boolean): string {
	for (const candidate of candidates) if (exists(candidate)) return candidate;
	throw new Error("unpdf worker not found");
}

function unpdfWorkerPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolveUnpdfWorker([
		join(findPackageRoot(here), "dist", "lib", "unpdf-worker.js"),
		join(here, "unpdf-worker.js"),
		join(here, "unpdf-worker.ts"),
	], existsSync);
}

export async function runTierReal(mode: Mode, childOptions: Record<string, unknown>, _b: Pick<Bundle, "stagingDir">, signal: AbortSignal | undefined, timeoutMs: number, backend: Backend): Promise<TierResult> {
	const cfg = { pymupdfVersion: String(childOptions.pymupdfVersion), warmTimeoutMs: 0 };
	let cmd: string, args: string[];
	if (mode === "pdf-text" || (mode === "info" && backend.kind === "none")) { cmd = process.execPath; args = [unpdfWorkerPath(), mode]; }
	else if (backend.kind === "uv") { cmd = "uv"; args = uvChildArgs(cfg, scriptPath(), mode); }
	else if (backend.kind === "python" || backend.kind === "venv") { cmd = backend.exe; args = pythonChildArgs(scriptPath(), mode); }
	else return { ok: false, reason: backend.reason };
	const r = await runCapped(cmd, args, { timeoutMs, capBytes: Number(childOptions.maxOutputBytes), signal, stdin: JSON.stringify(childOptions) });
	if (signal?.aborted) return { ok: false, reason: "aborted" };
	if (r.timedOut) return { ok: false, reason: `timeout after ${timeoutMs}ms` };
	if (r.capped) return { ok: false, reason: "output exceeded maxOutputBytes" };
	const detail = r.stderr.slice(-300).trim();
	let json: TierJson & { error?: string };
	try { json = JSON.parse(r.stdout); } catch {
		return r.code === 0 ? { ok: false, reason: "invalid-json" } : { ok: false, reason: `exit ${r.code ?? -1}`, ...(detail ? { detail } : {}) };
	}
	if (r.code === 3) return { ok: false, userError: json.error ?? "user error", ...(json.pageCount !== undefined ? { pageCount: json.pageCount } : {}) };
	if (r.code !== 0) return { ok: false, reason: `exit ${r.code ?? -1}`, ...(detail ? { detail } : {}) };
	return { ok: true, json };
}

export interface ConvertOutcome { output: string; details: DocToMdDetails; }
export interface DocToMdDetails extends HandleData {
	path: string;
	backend: BackendKind;
	pymupdfVersion: string;
	inputType: InputType;
	file: string;
	outputDir: string;
}

function detailSuffix(r: Extract<TierResult, { ok: false; reason: string }>): string {
	return r.detail ? ` (${r.detail})` : "";
}

export function reconcileRenderMarkers(md: string, renderPages: number[], fmt: string, sourceMap: Map<string, string>, reason: (idx: number) => string): string {
	for (const idx of renderPages) {
		const file = `s${idx}.${fmt}`;
		const ok = sourceMap.has(file);
		md = md.replace(`<!--rv:${idx}-->`, ok ? `Rendered view: ![Rendered view of sheet ${idx}](${file})` : `Rendered view: unavailable (${reason(idx)})`);
		md = md.replace(`<!--rvs:${idx}-->`, ok ? "yes" : "no");
	}
	if (/<!--rvs?:\d+-->/.test(md)) throw new Error("internal: unresolved render marker");
	return md;
}

export const emptyOcr = (o: Pick<DocToMdOptions, "ocrLanguage" | "ocrMaxPages">): OcrInfo => ({ status: "off", lang: o.ocrLanguage, textless: [], pages: [], noText: [], ocrFailed: [], budgetStopped: [], ceilingStopped: [], ocrMaxPages: o.ocrMaxPages, reason: null, tesseract: null, mode: "textless", sidecars: {}, wordSidecars: {}, ocrErrors: {}, killed: null, notAttempted: [], childError: null });

export interface OcrPagesOutcome { written: number[]; noText: number[]; ocrFailed: number[]; ocrErrors: Record<number, string>; budgetStopped: number[]; killed: number | null; notAttempted: number[]; childError: string | null; }
const emptyOutcome = (): OcrPagesOutcome => ({ written: [], noText: [], ocrFailed: [], ocrErrors: {}, budgetStopped: [], killed: null, notAttempted: [], childError: null });
const ocrPagesTag = (n: number) => `p${String(n).padStart(3, "0")}`;
const SIDE_MARKER_RE = /^--- end of page\.page_number=\d+ ---$/;

function sidecarHasText(dir: string): boolean {
	const file = readdirSync(dir).find((f) => f.endsWith(".md"));
	if (!file) return false;
	return readFileSync(join(dir, file), "utf8").split("\n").slice(1).some((l) => l.trim() && !SIDE_MARKER_RE.test(l));
}

/** Rebuild the outcome from staging markers after the child died or returned garbage. */
export function recoverOcrPages(stagingDir: string, pages: number[], detail: string): OcrPagesOutcome {
	const out = emptyOutcome();
	const activePath = join(stagingDir, "active");
	const active = existsSync(activePath) ? Number(readFileSync(activePath, "utf8").trim()) || null : null;
	let sawPage = false;
	for (const n of pages) {
		const dir = join(stagingDir, ocrPagesTag(n));
		if (existsSync(join(dir, ".done"))) { sawPage = true; (sidecarHasText(dir) ? out.written : out.noText).push(n); }
		else if (existsSync(join(dir, ".failed"))) { sawPage = true; out.ocrFailed.push(n); out.ocrErrors[n] = readFileSync(join(dir, ".failed"), "utf8").trim() || "unknown error"; }
		else if (n === active) out.killed = n;
		else out.notAttempted.push(n);
	}
	if (active === null && !sawPage) out.childError = detail;
	return out;
}

function outcomeFromChild(j: TierJson): OcrPagesOutcome {
	return { ...emptyOutcome(), written: j.written ?? [], noText: j.noText ?? [], ocrFailed: j.ocrFailed ?? [], ocrErrors: j.ocrErrors ?? {}, budgetStopped: j.budgetStopped ?? [] };
}
const OCR_SENTINEL_RE = /\x00OCR ([^\x00]*)\x00/g;

/** Child OCR labels name staged files; the published name exists only after publishStaged. */
export function resolveOcrLabels(md: string, sourceMap: Map<string, string>): string {
	return md.replace(OCR_SENTINEL_RE, (_, key: string) => {
		const dest = sourceMap.get(key);
		return dest ? `> Text recognized in ${dest} (OCR, may contain recognition errors):` : "> Text recognized by OCR (source image missing):";
	});
}

function handleOcr(tier: Tier, type: InputType, o: DocToMdOptions, json: TierJson): OcrInfo | null {
	if (tier === "unpdf") return o.ocr ? { ...emptyOcr(o), status: "unavailable", reason: "no Python backend" } : null;
	const x = json.ocr;
	if (!x || (type !== "image" && !x.textless.length && !x.pages.length && !x.ocrFailed.length)) return null;
	return { ...emptyOcr(o), ...x, ocrMaxPages: o.ocrMaxPages };
}

const nativeFromChild = (b: Bundle, json: TierJson, notes: string[]): NativeImage[] => (json.nativeImages ?? []).flatMap((e) => {
	const file = b.sourceMap.get(`p${e.page}/${e.file}`);
	if (!file) {
		notes.push(`Native image p${e.page}/${e.file} not published`);
		return [];
	}
	return [{ ...e, file: join(b.root, file) }];
});

// A dead primary has no JSON response; retained pages carry their image and clamp facts in .done.
function retainedNative(b: Bundle, kept: Map<number, StagedPage>, notes: string[]): NativeImage[] {
	const out: NativeImage[] = [];
	for (const [page, k] of kept) {
		if (k.meta.native) out.push({ page, ...k.meta.native, file: join(b.imagesDir, k.meta.native.file) });
		if (k.meta.dpi !== undefined && k.meta.requestedDpi !== undefined && k.meta.dpi < k.meta.requestedDpi) notes.push(`Page ${page} rendered at ${k.meta.dpi} dpi (requested ${k.meta.requestedDpi}; 50 Mpx ceiling)`);
	}
	return out;
}

export async function convertDocument(o: DocToMdOptions, signal?: AbortSignal, seams?: Partial<PipelineSeams>): Promise<ConvertOutcome> {
	const s: PipelineSeams = { backend: (c) => getBackend(c, undefined, signal), runTier: runTierReal, office: tryConvertOffice, ...seams };
	const inputPath = resolve(o.path);
	const st = statSync(inputPath, { throwIfNoEntry: false });
	if (!st || !st.isFile()) throw new Error(`Not a readable file: ${o.path}`);
	if (st.size === 0) throw new Error(`empty file: ${o.path}`);
	const type = classifyInput(inputPath);
	const forced = o.ocrMode === "all";
	if (forced) {
		if (!o.ocr) throw new UsageError("--ocr-mode all requires --ocr");
		if (o.pages === null) throw new UsageError('--ocr-mode all requires an explicit --pages selection (e.g. --pages 2,7); omitted pages and --pages "" mean all pages and are refused to keep OCR cost bounded');
		if (type !== "pdf" && type !== "pptx" && type !== "doc") throw new UsageError("--ocr-mode all applies to PDF, PPTX and DOC inputs only (DOCX pages are page-break segments, not PDF pages; convert the DOCX to PDF first)");
	}
	if (o.pages && (type === "html" || type === "image" || type === "email")) throw new Error(`--pages does not apply to ${type === "html" ? "HTML files" : type === "image" ? "images" : "email"}`);
	const isExcel = type === "xlsx" || type === "xlsm" || type === "xls";
	if (isExcel && o.pages) throw new Error("--pages does not apply to spreadsheets: worksheets have no stable page numbering");
	const backend = await s.backend({ pymupdfVersion: o.pymupdfVersion, warmTimeoutMs: o.warmTimeoutMs });
	if (forced && backend.kind === "none") throw new Error(`--ocr-mode all cannot run: no Python backend (${backend.reason})`);
	if (isExcel && (backend.kind === "none" || !backend.xlsx)) throw new Error(`Excel conversion needs a Python backend with openpyxl, xlrd and pillow (${backend.kind === "none" ? backend.reason : `${backend.kind} lacks the Excel packages`}). ${EXCEL_REMEDY}`);
	if (type === "email" && extname(inputPath).toLowerCase() === ".msg" && (backend.kind === "none" || !backend.email)) throw new Error(`MSG conversion needs the extract-msg package. Python backend: ${backendState(backend, "found without extract-msg")}. Remedy: install uv, or pip install extract-msg markdownify into that Python`);
	if (type === "email" && extname(inputPath).toLowerCase() !== ".msg" && lacksDocx(backend)) throw new Error(`EML conversion needs the Python DOCX/HTML packages (mammoth, markdownify, python-docx). Python backend: ${backendState(backend, "found without mammoth/markdownify/python-docx")}. ${docxRemedy}`);
	const stem = sanitizeStem(basename(inputPath, extname(inputPath)));
	const b = openBundle(o.outputDir ? resolve(o.outputDir) : tempBundleRoot(), stem, o.overwrite);
	let office: { pdfPath: string; cleanup: () => void } | null = null;
	try {
		let pdfPath = inputPath;
		const base = { path: inputPath, pages: o.pages, ...(o.words && (type === "pdf" || type === "image") ? { words: true } : {}), stagingDir: b.stagingDir, sheetsStagingDir: b.sheetsStagingDir, pageImages: o.pageImages, pagesStagingDir: b.pagesStagingDir, imageDpi: o.imageDpi, imageFormat: o.imageFormat, maxOutputBytes: o.maxOutputBytes, pymupdfVersion: o.pymupdfVersion, ocr: o.ocr && !forced, ocrLanguage: o.ocrLanguage, ocrBudgetMs: o.primaryTimeoutMs, ocrMaxPages: o.ocrMaxPages, hideAnnotations: o.hideAnnotations };
		let tier: Tier | undefined, engine: Engine | undefined, json: TierJson | undefined, degraded: string | null = null, fallbackReason: string | null = null;
		let explicitBreaks: number | null = null;
		let notes: string[] = [];
		let nativeImages: NativeImage[] = [];
		let officeRoute: string | null = null;
		let copyReason: string | null = null;
		if (type === "html") {
			const prepared = await prepareHtml(inputPath, b.stagingDir);
			if (signal?.aborted) throw new Error("aborted");
			if (prepared.missing) notes.push(`${prepared.missing} image(s) not found; replaced with alt text`);
			if (!lacksDocx(backend)) {
				const r = await s.runTier("html", { ...base, html: prepared.html }, b, signal, o.primaryTimeoutMs, backend);
				if (r.ok) { tier = "html"; engine = "markdownify"; json = r.json; }
				else if ("userError" in r) throw new Error(r.userError);
				else if (signal?.aborted || r.reason === "aborted") throw new Error("aborted");
				else fallbackReason = `html ${r.reason}${detailSuffix(r)}`;
			}
			if (json === undefined) { const { htmlToMarkdownRaw } = await import("./fetch-core.ts"); tier = "html"; engine = "turndown"; degraded = DEGRADED_HTML_TURNDOWN; json = { markdown: `${htmlToMarkdownRaw(prepared.html)}\n`, notes: [] }; }
			publishStaged(b);
		}
		if (type === "image") {
			let reason = "no Python backend";
			if (backend.kind !== "none") {
				const r = await s.runTier("image", { ...base, stem: b.stem }, b, signal, o.primaryTimeoutMs, backend);
				if (r.ok) { publishStaged(b); tier = "image"; engine = "pymupdf4llm"; json = r.json; }
				else if ("userError" in r) throw new Error(r.userError);
				else if (signal?.aborted || r.reason === "aborted") throw new Error("aborted");
				else reason = `OCR child failed: ${r.reason}`;
			}
			if (signal?.aborted) throw new Error("aborted");
			if (json === undefined) {
				copyReason = reason;
				clearStaging(b);
				const file = `original${extname(inputPath).toLowerCase()}`;
				const dir = join(b.stagingDir, "p1");
				mkdirSync(dir, { recursive: true });
				copyFileSync(inputPath, join(dir, file));
				writeFileSync(join(dir, ".done"), "");
				publishStaged(b);
				tier = "image"; engine = "copy";
				json = { markdown: `![${b.stem}](p1/${file})\n`, pageCount: 1, notes: [], ocr: { ...emptyOcr(o), status: "unavailable", reason } };
			}
		}
		if (type === "docx" && !lacksDocx(backend)) {
			const d = await s.runTier("docx", base, b, signal, o.primaryTimeoutMs, backend);
			if (d.ok) {
				publishStaged(b);
				tier = "docx"; engine = d.json.engine === "python-docx" ? "python-docx" : "mammoth"; json = d.json; explicitBreaks = d.json.explicitBreaks ?? 0;
				if (d.json.degraded) { degraded = DEGRADED_DOCX_TEXT; fallbackReason = d.json.fallbackReason ?? null; }
			} else if ("userError" in d) throw new Error(d.userError);
			else if (d.reason === "exit 1") { officeRoute = `docx ${d.reason}${detailSuffix(d)}`; clearStaging(b); }
			else throw new Error(`Conversion failed: docx ${d.reason}${detailSuffix(d)}`);
		} else if (type === "docx") officeRoute = backend.kind === "none" ? backend.reason : "python backend lacks DOCX packages";
		if (type === "docx" && officeRoute !== null) {
			if (o.pages) throw new Error(officeRoute.startsWith("docx exit") ? `${DOCX_PAGES_OFFICE} (${officeRoute})` : DOCX_PAGES_OFFICE);
			const r = await s.office(o.sofficeTimeoutMs, inputPath, signal);
			if (!r.ok && r.kind === "missing") {
				if (officeRoute.startsWith("docx exit")) throw new Error(`Conversion failed: ${officeRoute}; LibreOffice (soffice) not found on PATH`);
				throw new Error(`DOCX conversion needs the Python DOCX packages or LibreOffice. Python backend: ${backendState(backend, "found without mammoth/markdownify/python-docx")}. ${docxRemedy}, or install LibreOffice (soffice)`);
			}
			if (!r.ok) throw officeRoute.startsWith("docx exit") ? new Error(`Conversion failed: ${officeRoute}; ${officeFailure(r).message}`) : officeFailure(r);
			office = r; pdfPath = r.pdfPath;
		}
		if (type === "doc" || type === "pptx") {
			const r = await s.office(o.sofficeTimeoutMs, inputPath, signal);
			if (!r.ok && r.kind === "missing") throw new Error(`${type.toUpperCase()} conversion needs LibreOffice (soffice); direct conversion is not available. Python backend: ${backendState(backend, "available")}. Remedy: install LibreOffice`);
			if (!r.ok) throw officeFailure(r);
			office = r; pdfPath = r.pdfPath;
		}
		if (type === "email") {
			const isMsg = extname(inputPath).toLowerCase() === ".msg";
			const r = await s.runTier("email", { ...base, stem: b.stem, attachmentsStagingDir: b.attachmentsStagingDir }, b, signal, o.primaryTimeoutMs, backend);
			if (!r.ok) throw new Error("userError" in r ? r.userError : `Conversion failed: email ${r.reason}${detailSuffix(r)}`);
			publishStaged(b); publishAttachments(b);
			tier = "email"; engine = isMsg ? "extract-msg" : "email"; json = r.json;
		}
		const pdfBase = { ...base, path: pdfPath };
		if (json === undefined) {
			if (isExcel) {
				const r = await s.runTier("xlsx", base, b, signal, o.excelTimeoutMs, backend);
				if (!r.ok) {
					if ("userError" in r) throw new Error(r.userError);
					const remedy = r.reason.startsWith("timeout after") || r.reason === "output exceeded maxOutputBytes" ? ". Remedy: raise excelTimeoutMs" : "";
					throw new Error(`Excel conversion failed: ${r.reason}${detailSuffix(r)}${remedy}`);
				}
				publishSheetImages(b); publishSheetCsvs(b);
				tier = "excel"; engine = type === "xls" ? "xlrd" : "openpyxl"; json = r.json; notes = (json.notes ?? []).map((n) => n.replace(/sheets\/[^\s,;]+/g, (m) => b.sourceMap.get(m) ?? m));
				const renderPages = json.renderPages ?? [];
				let skip: string | null = null;
				const perSheet = new Map<number, string>();
				if (renderPages.length) {
					const off = await s.office(o.sofficeTimeoutMs, inputPath, signal, runCapped, EXCEL_PDF_FILTER);
					if (!off.ok) skip = off.kind === "missing" ? "LibreOffice not found" : off.kind === "timeout" ? `soffice failed: timeout after ${o.sofficeTimeoutMs}ms` : off.kind === "exit" ? `soffice failed: exit ${off.code}` : "soffice produced no PDF";
					else {
						try {
							const rp = await s.runTier("render-pages", { path: off.pdfPath, sheetIndices: renderPages, expectedPages: json.sheetCount, imageDpi: o.imageDpi, imageFormat: o.imageFormat, stagingDir: b.stagingDir, maxOutputBytes: o.maxOutputBytes, pymupdfVersion: o.pymupdfVersion }, b, signal, o.fallbackTimeoutMs, backend);
							if (!rp.ok) skip = `render failed: ${"userError" in rp ? rp.userError : rp.reason}`;
							else if (rp.json.ok === false) skip = rp.json.reason ?? "render failed";
							else {
								publishSheetImages(b);
								for (const f of rp.json.failed ?? []) perSheet.set(f.idx, f.reason);
								for (const d of rp.json.rendered ?? []) if (d.dpi < o.imageDpi) notes.push(`Rendered view s${d.idx}: rendered at ${d.dpi} dpi`);
							}
						} finally { off.cleanup(); }
					}
					if (skip) notes.push(`Rendered views skipped: ${skip}`);
					else if (perSheet.size) notes.push(`Rendered views: ${perSheet.size} of ${renderPages.length} unavailable`);
				}
				json = { ...json, markdown: reconcileRenderMarkers(json.markdown ?? "", renderPages, o.imageFormat, b.sourceMap, (idx) => perSheet.get(idx) ?? skip ?? "render failed") };
			} else if (backend.kind === "none") {
				const r = await s.runTier("pdf-text", pdfBase, b, signal, o.primaryTimeoutMs, backend);
				if (!r.ok) throw new Error("userError" in r ? r.userError : `Conversion failed: unpdf ${r.reason}${detailSuffix(r)}`);
				tier = "unpdf"; engine = "unpdf"; json = r.json; degraded = DEGRADED_UNPDF;
			} else {
				const p = await s.runTier("pdf-primary", pdfBase, b, signal, o.primaryTimeoutMs, backend);
				const kept = publishStaged(b);
				if (p.ok) { tier = "primary"; engine = "pymupdf4llm"; json = p.json; nativeImages = nativeFromChild(b, json, notes); if (json.pageImages?.length) publishPageImages(b, json.pageCount ?? 0); }
				else if ("userError" in p) throw new Error(p.userError);
				else {
					if (signal?.aborted) throw new Error("aborted");
					const keepPages = Object.fromEntries([...kept.entries()].map(([k, v]) => [String(k), v.files]));
					rmSync(b.pagesStagingDir, { recursive: true, force: true });
					const f = await s.runTier("pdf-fallback", { ...pdfBase, keepPages }, b, signal, o.fallbackTimeoutMs, backend);
					publishStaged(b);
					if (f.ok && f.json.pageImages?.length) publishPageImages(b, f.json.pageCount ?? 0);
					if (!f.ok) throw new Error("userError" in f ? f.userError : `Conversion failed: primary ${p.reason}; fallback ${f.reason}${detailSuffix(f)}`);
					tier = "fallback"; engine = "pymupdf-text"; json = f.json; degraded = DEGRADED_TEXT; fallbackReason = `primary ${p.reason}`;
					nativeImages = [...retainedNative(b, kept, notes), ...nativeFromChild(b, json, notes)].sort((x, y) => x.page - y.page);
				}
			}
		}
		if (type === "doc" || officeRoute !== null) degraded = DEGRADED_DOCX_OFFICE;
		if (officeRoute !== null) fallbackReason = fallbackReason ? `${officeRoute}; ${fallbackReason}` : officeRoute;
		if (tier === undefined || engine === undefined || json === undefined) throw new Error("internal: no tier produced output");
		const pageStats = json.pageStats ?? null;
		if (pageStats) writePageStats(b, pageStats);
		let wordsPath: string | null = null, wordsReason: string | null = null;
		const wordsErrors: Record<number, string> = {};
		const takeWordsErrors = (j: TierJson | undefined) => {
			for (const [k, v] of Object.entries(j?.wordsErrors ?? {})) {
				const page = Number(k);
				if (Number.isFinite(page)) wordsErrors[page] = v;
			}
		};
		if (o.words) {
			if (type !== "pdf" && type !== "image") wordsReason = `none - word positions apply to PDF and image inputs only (${type})`;
			else if (tier === "unpdf") wordsReason = "none - unpdf tier has no page geometry";
			else if (engine === "copy") wordsReason = `none - image copied without conversion (${copyReason})`;
			else if (json?.words === true) { wordsReason = publishWords(b); if (wordsReason === null) wordsPath = b.wordsPath; }
			else wordsReason = `write failed - ${json?.wordsErrors?.file ?? "child reported no words document"}`;
			takeWordsErrors(json);
		}
		let ocr = handleOcr(tier, type, o, json);
		if (forced) {
			const r = await s.runTier("ocr-pages", { path: pdfPath, pages: o.pages, ...(o.words && type === "pdf" ? { words: true } : {}), stem: b.stem, ocrLanguage: o.ocrLanguage, ocrBudgetMs: o.primaryTimeoutMs, stagingDir: b.ocrStagingDir, dpi: o.imageDpi, maxOutputBytes: o.maxOutputBytes, pymupdfVersion: o.pymupdfVersion }, b, signal, o.primaryTimeoutMs, backend);
			if (signal?.aborted || (!r.ok && "reason" in r && r.reason === "aborted")) throw new Error("aborted");
			if (r.ok && r.json.status === "unavailable") throw new Error(`OCR unavailable: ${r.json.reason} (install Tesseract; see doc/doc-to-md.md)`);
			const outcome = r.ok && r.json.status === "ran" ? outcomeFromChild(r.json)
				: recoverOcrPages(b.ocrStagingDir, o.pages!, !r.ok ? ("userError" in r ? r.userError : `${r.reason}${detailSuffix(r)}`) : "malformed child output");
			const { sidecars, wordSidecars } = publishSidecars(b);
			ocr = { ...emptyOcr(o), ...json.ocr, ocrMaxPages: o.ocrMaxPages, status: "ran", reason: null, mode: "all", pages: outcome.written, noText: outcome.noText, ocrFailed: outcome.ocrFailed, ocrErrors: outcome.ocrErrors, budgetStopped: outcome.budgetStopped, killed: outcome.killed, notAttempted: outcome.notAttempted, childError: outcome.childError, sidecars: Object.fromEntries(sidecars), wordSidecars: Object.fromEntries(wordSidecars) };
			if (o.words && r.ok) takeWordsErrors(r.json);
		}
		if (!isExcel) notes = [...notes, ...(json.notes ?? [])];
		if (b.renamedFrom) notes.splice(notes[0]?.startsWith("preview truncated:") ? 1 : 0, 0, `renamed to ${b.stem} (${b.renameReason})`);
		const pageImagesReason = !o.pageImages || b.pageManifest.size || tier === "primary" || tier === "fallback" ? null
			: tier === "unpdf" ? "page images need the Python backend" : `${type} has no page geometry`;
		const body = resolveOcrLabels(rewriteLinks(json.markdown ?? "", b.sourceMap), b.sourceMap);
		validateImageLinks(body, b.manifest, b.csvManifest, type === "html" || type === "email", b.pageManifest, b.attachmentManifest);
		const head: string[] = [];
		if (degraded) head.push(`Degraded: ${degraded}`);
		if (fallbackReason) head.push(`Fallback-Reason: ${fallbackReason}`);
		if (json.failedPages?.length) head.push(`Failed pages: ${json.failedPages.map((f) => `${f.page} (${f.error})`).join("; ")}`);
		if (json.emptyPages?.length) head.push(`Empty pages: ${json.emptyPages.join(", ")}`);
		for (const n of notes) head.push(`Notes: ${n}`);
		const markdown = (head.length ? `${head.join("\n")}\n\n` : "") + body;
		commitBundle(b, markdown);
		const outline = scanOutline(markdown, o.outlineMaxEntries);
		const details: DocToMdDetails = { path: inputPath, backend: backend.kind, pymupdfVersion: o.pymupdfVersion, inputType: type, file: b.mdPath, outputDir: b.root, savedTo: b.mdPath, imagesDir: b.imagesDir, sheetsDir: b.csvManifest.size ? b.sheetsDir : null, pagesDir: b.pageManifest.size ? b.pagesDir : null, pageImageCount: b.pageManifest.size, pageImagesReason, type, engine, tier, pageCount: json.pageCount ?? null, pages: o.pages, explicitBreaks, imageCount: b.manifest.size, bytes: Buffer.byteLength(markdown, "utf8"), lines: markdown.split("\n").length, degraded, fallbackReason, failedPages: (json.failedPages ?? []).map((f) => f.page), emptyPages: json.emptyPages ?? [], notes, outline: outline.entries, outlineTotal: outline.total, ocr, pageStats, pageStatsPath: pageStats ? b.pageStatsPath : null, ocrDir: b.ocrManifest.size ? b.ocrDir : null, nativeImages, wordsPath, wordsReason, wordsErrors };
		return { output: formatHandle(details), details };
	} catch (e) { abortBundle(b); throw e; }
	finally { office?.cleanup(); }
}

export async function inspectDocument(o: DocToMdOptions, signal?: AbortSignal, seams?: Partial<PipelineSeams>): Promise<{ output: string; details: InfoData }> {
	const s: PipelineSeams = { backend: (c) => getBackend(c, undefined, signal), runTier: runTierReal, office: tryConvertOffice, ...seams };
	const inputPath = resolve(o.path);
	const st = statSync(inputPath, { throwIfNoEntry: false });
	if (!st || !st.isFile()) throw new Error(`Not a readable file: ${o.path}`);
	if (st.size === 0) throw new Error(`empty file: ${o.path}`);
	const type = classifyInput(inputPath);
	if (type === "html" || type === "image" || type === "email") throw new Error(`info does not apply to ${type === "html" ? "HTML files" : type === "image" ? "images" : "email"}; convert directly`);
	const isExcel = type === "xlsx" || type === "xlsm" || type === "xls";
	const backend = await s.backend({ pymupdfVersion: o.pymupdfVersion, warmTimeoutMs: o.warmTimeoutMs });
	if (isExcel && (backend.kind === "none" || !backend.xlsx)) throw new Error(`Excel inspection needs a Python backend with openpyxl, xlrd and pillow. ${EXCEL_REMEDY}`);
	let office: { pdfPath: string; cleanup: () => void } | null = null;
	try {
		let path = inputPath;
		if (type === "docx") {
			if (lacksDocx(backend)) throw new Error(`DOCX inspection needs the Python DOCX packages. Python backend: ${backendState(backend, "found without mammoth/markdownify/python-docx")}. ${docxRemedy}`);
		} else if (type === "pptx" || type === "doc") {
			const r = await s.office(o.sofficeTimeoutMs, inputPath, signal);
			if (!r.ok) throw officeFailure(r);
			office = r; path = r.pdfPath;
		}
		const r = await s.runTier("info", { path, maxOutputBytes: o.maxOutputBytes, pymupdfVersion: o.pymupdfVersion }, { stagingDir: "" }, signal, isExcel ? o.excelTimeoutMs : o.fallbackTimeoutMs, backend);
		if (!r.ok) {
			if ("userError" in r) throw new Error(r.userError);
			if (isExcel && (r.reason.startsWith("timeout after") || r.reason === "output exceeded maxOutputBytes")) throw new Error(`Excel inspection failed: ${r.reason}. Remedy: raise excelTimeoutMs${detailSuffix(r)}`);
			throw new Error(`Inspection failed: ${r.reason}${detailSuffix(r)}`);
		}
		const toc: TocEntry[] = (r.json.toc ?? []).map(([level, title, page]) => ({ level, title, page }));
		const details: InfoData = { type, backend: backend.kind, pageCount: r.json.pageCount ?? null, metadata: r.json.metadata ?? {}, toc: toc.slice(0, o.outlineMaxEntries), tocTotal: toc.length, sheets: r.json.sheets ? r.json.sheets.slice(0, o.outlineMaxEntries) : null, sheetsTotal: r.json.sheets?.length ?? 0 };
		return { output: formatInfoHandle(details, o.outlineMaxEntries), details };
	} finally { office?.cleanup(); }
}
