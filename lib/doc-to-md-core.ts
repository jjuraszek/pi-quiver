/**
 * doc-to-md core (pi-free)
 *
 * Converts local PDF, DOCX, PPTX, XLSX, and XLS documents into disk bundles
 * with concise handles. PDF uses primary pymupdf4llm, PyMuPDF-text fallback,
 * then unpdf when no Python backend exists. DOCX/PPTX convert through
 * headless soffice before entering the PDF pipeline.
 */

import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { type ChildProcess, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Bundle, abortBundle, commitBundle, openBundle, publishSheetImages, publishStaged, rewriteImageLinks, tempBundleRoot, validateImageLinks } from "./doc-to-md-bundle.ts";
import { type Engine, type HandleData, type InfoData, type Tier, formatHandle, formatInfoHandle, scanOutline, type SheetInfo, type TocEntry } from "./doc-to-md-handle.ts";
import { type DocToMdOptions, type InputType, TUNABLE_DEFAULTS, classifyInput, sanitizeStem } from "./doc-to-md-options.ts";

export * from "./doc-to-md-options.ts";
export { compactRanges, formatHandle, formatInfoHandle, formatSize, scanOutline } from "./doc-to-md-handle.ts";
export type { Engine, HandleData, InfoData, OutlineEntry, SheetInfo, Tier, TocEntry } from "./doc-to-md-handle.ts";

// --- Types ---

export const PACKAGE_PINS = { pymupdf4llm: TUNABLE_DEFAULTS.pymupdfVersion, openpyxl: "3.1.5", xlrd: "2.0.2", pillow: "12.3.0" } as const;
export const KILL_GRACE_MS = 2000;
export const VENV_DIR_NAME = "doc-to-md-venv-v2";
export const LEGACY_VENV_DIR_NAME = "pymupdf-venv";
const STDERR_CAP = 1_000_000;
export const OUTPUT_MAX_BYTES = 20_000_000;

export interface BackendConfig { pymupdfVersion: string; warmTimeoutMs: number; }

export interface CappedResult {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	capped: boolean;
}

// --- Subprocess argv builders ---

function withArgs(cfg: BackendConfig): string[] {
	return ["--with", `pymupdf4llm==${cfg.pymupdfVersion}`, "--with", `openpyxl==${PACKAGE_PINS.openpyxl}`, "--with", `xlrd==${PACKAGE_PINS.xlrd}`, "--with", `pillow==${PACKAGE_PINS.pillow}`];
}

export function pipInstallArgs(cfg: BackendConfig): string[] {
	return ["-m", "pip", "install", `pymupdf4llm==${cfg.pymupdfVersion}`, `openpyxl==${PACKAGE_PINS.openpyxl}`, `xlrd==${PACKAGE_PINS.xlrd}`, `pillow==${PACKAGE_PINS.pillow}`];
}

export function warmArgs(cfg: BackendConfig): string[] {
	return ["run", ...withArgs(cfg), "--python", "3.14", "python", "-c", "import pymupdf4llm, openpyxl, xlrd, PIL"];
}

export function uvChildArgs(cfg: BackendConfig, script: string, mode: string): string[] {
	return ["run", ...withArgs(cfg), "--python", "3.14", "python", script, mode];
}

export function pythonChildArgs(script: string, mode: string): string[] { return [script, mode]; }

export function soffArgs(src: string, profileDir: string, outDir: string): string[] {
	return [
		"--headless", "--invisible", "--nocrashreport", "--nodefault", "--nofirststartwizard",
		"--nolockcheck", "--nologo", "--norestore", "--quickstart=no",
		`-env:UserInstallation=${pathToFileURL(profileDir).href}`,
		"--convert-to", "pdf", "--outdir", outDir, src,
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
`;
export const PROBE_TIMEOUT_MS = 5000;

export function probeArgs(): string[] {
	return ["-c", PROBE_PROGRAM];
}
export const PYTHON_CANDIDATES = ["python3", "python"] as const;

export type BackendKind = "uv" | "python" | "venv" | "none";
export type Backend =
	| { kind: "uv"; pdf: true; xlsx: true }
	| { kind: "python"; exe: string; pdf: boolean; xlsx: boolean }
	| { kind: "venv"; exe: string; pdf: true; xlsx: true }
	| { kind: "none"; reason: string };

export interface ProbeResult { major: number; minor: number; pdf: boolean; xlsx: boolean; }

export function parseProbeOutput(stdout: string): ProbeResult | null {
	const m = stdout.match(/^PY (\d+) (\d+)\r?\nPDF (yes|no)\r?\nXLSX (yes|no)\s*$/);
	return m ? { major: Number(m[1]), minor: Number(m[2]), pdf: m[3] === "yes", xlsx: m[4] === "yes" } : null;
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
	if (warm.code === 0 && !warm.timedOut) return { kind: "uv", pdf: true, xlsx: true };
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
		if (p.pdf) return { kind: "python", exe, pdf: true, xlsx: p.xlsx };
		eligible ??= { exe, version: `${p.major}.${p.minor}` };
	}

	const venvDir = join(deps.cacheRoot, VENV_DIR_NAME);
	const venvExe = venvPython(venvDir, deps.platform);
	const cached = await probe(venvExe);
	if (isDeadline(cached)) return cached;
	if (cached && meetsFloor(cached) && cached.pdf && cached.xlsx) return { kind: "venv", exe: venvExe, pdf: true, xlsx: true };

	if (eligible) {
		const recheck = await probe(venvExe); // a competing process may have published since the first probe
		if (isDeadline(recheck)) return recheck;
		if (recheck && meetsFloor(recheck) && recheck.pdf && recheck.xlsx) return { kind: "venv", exe: venvExe, pdf: true, xlsx: true };
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
			deps.rmrf(join(deps.cacheRoot, LEGACY_VENV_DIR_NAME));
			return { kind: "venv", exe: venvExe, pdf: true, xlsx: true };
		}
		// Rename failed - a competing process may have published first, or venvDir holds a stale/broken dir.
		const winner = await probe(venvExe, tmp);
		if (isDeadline(winner)) return winner;
		if (winner && meetsFloor(winner) && winner.pdf && winner.xlsx) {
			deps.rmrf(tmp); // healthy winner - clean up our loser
			return { kind: "venv", exe: venvExe, pdf: true, xlsx: true };
		}
		deps.rmrf(venvDir); // unhealthy/absent dest - clear it and retry the rename once
		if (publish()) {
			deps.rmrf(join(deps.cacheRoot, LEGACY_VENV_DIR_NAME));
			return { kind: "venv", exe: venvExe, pdf: true, xlsx: true };
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

export async function convertOffice(
	sofficeTimeoutMs: number,
	src: string,
	signal?: AbortSignal,
	run: RunFn = runCapped,
): Promise<{ pdfPath: string; cleanup: () => void }> {
	const profileDir = mkdtempSync(join(tmpdir(), "pi-doc-soffice-prof-"));
	const outDir = mkdtempSync(join(tmpdir(), "pi-doc-soffice-out-"));
	const cleanup = () => {
		for (const d of [profileDir, outDir]) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	};
	try {
		const env = { ...process.env, SAL_USE_VCLPLUGIN: "svp", OOO_DISABLE_RECOVERY: "1", SAL_NO_MOUSEGRABS: "1" };
		const r = await run("soffice", soffArgs(src, profileDir, outDir), { timeoutMs: sofficeTimeoutMs, capBytes: OUTPUT_MAX_BYTES, env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (r.code === null && !r.timedOut) {
			throw new Error("LibreOffice (soffice) is required to convert .docx/.pptx but was not found on PATH. Install LibreOffice or convert the file to PDF first.");
		}
		if (r.timedOut || r.code !== 0) throw new Error(`soffice failed (code=${r.code} timedOut=${r.timedOut}): ${r.stderr.slice(0, 500)}`);
		const base = basename(src).replace(/\.[^.]+$/, "");
		const pdfPath = join(outDir, `${base}.pdf`);
		const st = statSync(pdfPath, { throwIfNoEntry: false });
		if (!st || !st.isFile() || st.size === 0) {
			throw new Error("LibreOffice (soffice) ran but produced no usable PDF for this file. Ensure LibreOffice can open the document, or convert it to PDF manually first.");
		}
		return { pdfPath, cleanup };
	} catch (e) { cleanup(); throw e; }
}


// --- Conversion tiers and bundle orchestration ---

export const DEGRADED_TEXT = "PyMuPDF text extraction - layout/tables not preserved";
export const DEGRADED_UNPDF = "unpdf text extraction - structure not preserved";
export const EXCEL_REMEDY = "Remedy: install uv, or pip install openpyxl xlrd pillow";

export type Mode = "info" | "pdf-primary" | "pdf-fallback" | "xlsx" | "pdf-text";
export interface TierJson { markdown?: string; pages?: number[]; pageCount?: number; emptyPages?: number[]; failedPages?: { page: number; error: string }[]; notes?: string[]; images?: { sheetIndex: number; file: string }[]; metadata?: Record<string, string>; toc?: [number, string, number][]; sheets?: SheetInfo[]; }
export type TierResult = { ok: true; json: TierJson } | { ok: false; reason: string; detail?: string } | { ok: false; userError: string; pageCount?: number };

export interface PipelineSeams {
	backend: (cfg: BackendConfig) => Promise<Backend>;
	runTier: (mode: Mode, childOptions: Record<string, unknown>, bundle: Pick<Bundle, "stagingDir">, signal: AbortSignal | undefined, timeoutMs: number, backend: Backend) => Promise<TierResult>;
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

async function runTierReal(mode: Mode, childOptions: Record<string, unknown>, _b: Pick<Bundle, "stagingDir">, signal: AbortSignal | undefined, timeoutMs: number, backend: Backend): Promise<TierResult> {
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

export async function convertDocument(o: DocToMdOptions, signal?: AbortSignal, seams?: Partial<PipelineSeams>): Promise<ConvertOutcome> {
	const s: PipelineSeams = { backend: (c) => getBackend(c, undefined, signal), runTier: runTierReal, ...seams };
	const inputPath = resolve(o.path);
	const st = statSync(inputPath, { throwIfNoEntry: false });
	if (!st || !st.isFile()) throw new Error(`Not a readable file: ${o.path}`);
	const type = classifyInput(inputPath);
	const isExcel = type === "xlsx" || type === "xls";
	if (isExcel && o.pages) throw new Error("--pages does not apply to spreadsheets: worksheets have no stable page numbering");
	const backend = await s.backend({ pymupdfVersion: o.pymupdfVersion, warmTimeoutMs: o.warmTimeoutMs });
	if (isExcel && (backend.kind === "none" || !backend.xlsx)) throw new Error(`Excel conversion needs a Python backend with openpyxl, xlrd and pillow (${backend.kind === "none" ? backend.reason : `${backend.kind} lacks the Excel packages`}). ${EXCEL_REMEDY}`);
	const stem = sanitizeStem(basename(inputPath, extname(inputPath)));
	const b = openBundle(o.outputDir ? resolve(o.outputDir) : tempBundleRoot(), stem, o.overwrite);
	let office: { pdfPath: string; cleanup: () => void } | null = null;
	try {
		let pdfPath = inputPath;
		if (type === "docx" || type === "pptx") { office = await convertOffice(o.sofficeTimeoutMs, inputPath, signal); pdfPath = office.pdfPath; }
		const base = { path: pdfPath, pages: o.pages, stagingDir: b.stagingDir, imageDpi: o.imageDpi, imageFormat: o.imageFormat, maxCellsPerSheet: o.maxCellsPerSheet, maxOutputBytes: o.maxOutputBytes, pymupdfVersion: o.pymupdfVersion };
		let tier: Tier, engine: Engine, json: TierJson, degraded: string | null = null, fallbackReason: string | null = null;
		if (isExcel) {
			const r = await s.runTier("xlsx", base, b, signal, o.excelTimeoutMs, backend);
			if (!r.ok) {
				if ("userError" in r) throw new Error(r.userError);
				const remedy = r.reason.startsWith("timeout after") || r.reason === "output exceeded maxOutputBytes" ? ". Remedy: raise excelTimeoutMs or lower maxCellsPerSheet" : "";
				throw new Error(`Excel conversion failed: ${r.reason}${detailSuffix(r)}${remedy}`);
			}
			publishSheetImages(b);
			tier = "excel"; engine = type === "xls" ? "xlrd" : "openpyxl"; json = r.json;
		} else if (backend.kind === "none") {
			const r = await s.runTier("pdf-text", base, b, signal, o.primaryTimeoutMs, backend);
			if (!r.ok) throw new Error("userError" in r ? r.userError : `Conversion failed: unpdf ${r.reason}${detailSuffix(r)}`);
			tier = "unpdf"; engine = "unpdf"; json = r.json; degraded = DEGRADED_UNPDF;
		} else {
			const p = await s.runTier("pdf-primary", base, b, signal, o.primaryTimeoutMs, backend);
			const kept = publishStaged(b);
			if (p.ok) { tier = "primary"; engine = "pymupdf4llm"; json = p.json; }
			else if ("userError" in p) throw new Error(p.userError);
			else {
				if (signal?.aborted) throw new Error("aborted");
				const keepPages = Object.fromEntries([...kept.entries()].map(([k, v]) => [String(k), v]));
				const f = await s.runTier("pdf-fallback", { ...base, keepPages }, b, signal, o.fallbackTimeoutMs, backend);
				publishStaged(b);
				if (!f.ok) throw new Error("userError" in f ? f.userError : `Conversion failed: primary ${p.reason}; fallback ${f.reason}${detailSuffix(f)}`);
				tier = "fallback"; engine = "pymupdf-text"; json = f.json; degraded = DEGRADED_TEXT; fallbackReason = `primary ${p.reason}`;
			}
		}
		let body = rewriteImageLinks(json.markdown ?? "", b.sourceMap);
		validateImageLinks(body, b.manifest);
		const head: string[] = [];
		if (degraded) head.push(`Degraded: ${degraded}`);
		if (fallbackReason) head.push(`Fallback-Reason: ${fallbackReason}`);
		if (json.failedPages?.length) head.push(`Failed pages: ${json.failedPages.map((f) => `${f.page} (${f.error})`).join("; ")}`);
		if (json.emptyPages?.length) head.push(`Empty pages: ${json.emptyPages.join(", ")}`);
		for (const n of json.notes ?? []) head.push(`Notes: ${n}`);
		const markdown = (head.length ? `${head.join("\n")}\n\n` : "") + body;
		commitBundle(b, markdown);
		const outline = scanOutline(markdown, o.outlineMaxEntries);
		const details: DocToMdDetails = { path: inputPath, backend: backend.kind, pymupdfVersion: o.pymupdfVersion, inputType: type, file: b.mdPath, outputDir: b.root, savedTo: b.mdPath, imagesDir: b.imagesDir, type, engine, tier, pageCount: json.pageCount ?? null, pages: o.pages, imageCount: b.manifest.size, bytes: Buffer.byteLength(markdown, "utf8"), lines: markdown.split("\n").length, degraded, fallbackReason, failedPages: (json.failedPages ?? []).map((f) => f.page), emptyPages: json.emptyPages ?? [], notes: json.notes ?? [], outline: outline.entries, outlineTotal: outline.total };
		return { output: formatHandle(details), details };
	} catch (e) { abortBundle(b); throw e; }
	finally { office?.cleanup(); }
}

export async function inspectDocument(o: DocToMdOptions, signal?: AbortSignal, seams?: Partial<PipelineSeams>): Promise<{ output: string; details: InfoData }> {
	const s: PipelineSeams = { backend: (c) => getBackend(c, undefined, signal), runTier: runTierReal, ...seams };
	const inputPath = resolve(o.path);
	const st = statSync(inputPath, { throwIfNoEntry: false });
	if (!st || !st.isFile()) throw new Error(`Not a readable file: ${o.path}`);
	const type = classifyInput(inputPath);
	const isExcel = type === "xlsx" || type === "xls";
	const backend = await s.backend({ pymupdfVersion: o.pymupdfVersion, warmTimeoutMs: o.warmTimeoutMs });
	if (isExcel && (backend.kind === "none" || !backend.xlsx)) throw new Error(`Excel inspection needs a Python backend with openpyxl, xlrd and pillow. ${EXCEL_REMEDY}`);
	let office: { pdfPath: string; cleanup: () => void } | null = null;
	try {
		let path = inputPath;
		if (type === "docx" || type === "pptx") { office = await convertOffice(o.sofficeTimeoutMs, inputPath, signal); path = office.pdfPath; }
		const r = await s.runTier("info", { path, maxOutputBytes: o.maxOutputBytes, pymupdfVersion: o.pymupdfVersion }, { stagingDir: "" }, signal, isExcel ? o.excelTimeoutMs : o.fallbackTimeoutMs, backend);
		if (!r.ok) {
			if ("userError" in r) throw new Error(r.userError);
			if (isExcel && (r.reason.startsWith("timeout after") || r.reason === "output exceeded maxOutputBytes")) throw new Error(`Excel inspection failed: ${r.reason}. Remedy: raise excelTimeoutMs or lower maxCellsPerSheet${detailSuffix(r)}`);
			throw new Error(`Inspection failed: ${r.reason}${detailSuffix(r)}`);
		}
		const toc: TocEntry[] = (r.json.toc ?? []).map(([level, title, page]) => ({ level, title, page }));
		const details: InfoData = { type, backend: backend.kind, pageCount: r.json.pageCount ?? null, metadata: r.json.metadata ?? {}, toc: toc.slice(0, o.outlineMaxEntries), tocTotal: toc.length, sheets: r.json.sheets ? r.json.sheets.slice(0, o.outlineMaxEntries) : null, sheetsTotal: r.json.sheets?.length ?? 0 };
		return { output: formatInfoHandle(details, o.outlineMaxEntries), details };
	} finally { office?.cleanup(); }
}
