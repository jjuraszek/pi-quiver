/**
 * doc-to-md core (pi-free)
 *
 * Converts a local PDF, DOCX, or PPTX file to Markdown. Primary engine:
 * pymupdf4llm via ephemeral `uv run --with` (warm-once per process, no repo
 * venv). Fallback: unpdf pure-JS text extraction (degraded, explicitly
 * marked). DOCX/PPTX convert to PDF first via headless soffice, then feed
 * the PDF pipeline. Output over 32 KB or 1000 lines is spilled to a temp
 * .md file with a 60-line preview; smaller content is returned inline.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";

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
	backend: BackendKind;
	pymupdfVersion?: string;
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
	writeFileSync(file, `${body}\n`, "utf8");
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

export function findPackageRoot(startDir: string): string {
	let dir = startDir;
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`package.json not found walking up from ${startDir}`);
		dir = parent;
	}
}

function scriptPath(): string {
	return join(findPackageRoot(dirname(fileURLToPath(import.meta.url))), "scripts", "pdf_to_md.py");
}

// Deliberate local copy of the host package's formatSize - this core must stay pi-free (see test/layout.test.ts purity check).
function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

async function convertViaUv(cfg: DocToMdConfig, pdfPath: string, signal?: AbortSignal): Promise<string> {
	const r = await runCapped("uv", convertArgs(cfg, scriptPath(), pdfPath), {
		timeoutMs: cfg.convertTimeoutMs, capBytes: OUTPUT_MAX_BYTES, signal,
	});
	if (r.timedOut || r.capped || r.code !== 0) {
		throw new Error(`code=${r.code} timedOut=${r.timedOut} capped=${r.capped}: ${r.stderr.slice(0, 500)}`);
	}
	return r.stdout;
}

async function convertViaPython(cfg: DocToMdConfig, exe: string, pdfPath: string, signal?: AbortSignal): Promise<string> {
	const r = await runCapped(exe, pythonConvertArgs(scriptPath(), pdfPath), {
		timeoutMs: cfg.convertTimeoutMs, capBytes: OUTPUT_MAX_BYTES, signal,
	});
	if (r.timedOut || r.capped || r.code !== 0) {
		throw new Error(`code=${r.code} timedOut=${r.timedOut} capped=${r.capped}: ${r.stderr.slice(0, 500)}`);
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

// --- Backend resolver ---

export const PROBE_PROGRAM = `import sys
print("PY", sys.version_info[0], sys.version_info[1])
try:
    import pymupdf4llm
    print("PKG", pymupdf4llm.__version__)
except Exception:
    print("PKG", "none")
`;
export const PROBE_TIMEOUT_MS = 5000;

export function probeArgs(): string[] {
	return ["-c", PROBE_PROGRAM];
}
export const PYTHON_CANDIDATES = ["python3", "python"] as const;

export type BackendKind = "uv" | "python" | "venv" | "unpdf";
export type Backend =
	| { kind: "uv" }
	| { kind: "python"; exe: string; version: string }
	| { kind: "venv"; exe: string; version: string }
	| { kind: "none"; reason: string };

export interface ProbeResult { major: number; minor: number; pkg: string | null; }

export function parseProbeOutput(stdout: string): ProbeResult | null {
	const m = stdout.match(/^PY (\d+) (\d+)\r?\nPKG (\S+)\s*$/);
	if (!m) return null;
	return { major: Number(m[1]), minor: Number(m[2]), pkg: m[3] === "none" ? null : m[3] };
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

export function pythonConvertArgs(script: string, pdfPath: string): string[] {
	return [script, pdfPath];
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

export async function resolveBackend(cfg: DocToMdConfig, deps: ResolverDeps, signal?: AbortSignal): Promise<Backend> {
	if (signal?.aborted) throw new Error("aborted");
	const warm = await deps.run("uv", warmArgs(cfg), { timeoutMs: cfg.warmTimeoutMs, capBytes: OUTPUT_MAX_BYTES, env: deps.env, signal });
	if (signal?.aborted) throw new Error("aborted");
	if (warm.code === 0 && !warm.timedOut) return { kind: "uv" };
	const uvAbsent = warm.code === null && !warm.timedOut; // spawn error (ENOENT)

	const probe = async (exe: string): Promise<ProbeResult | null> => {
		const r = await deps.run(exe, probeArgs(), { timeoutMs: PROBE_TIMEOUT_MS, capBytes: 4000, env: deps.env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (r.code !== 0 || r.timedOut) return null;
		return parseProbeOutput(r.stdout);
	};

	let eligible: { exe: string; version: string } | null = null;
	for (const exe of PYTHON_CANDIDATES) {
		const p = await probe(exe);
		if (!p || !meetsFloor(p)) continue;
		if (p.pkg) return { kind: "python", exe, version: p.pkg };
		eligible ??= { exe, version: `${p.major}.${p.minor}` };
	}

	const venvDir = join(deps.cacheRoot, "pymupdf-venv");
	const venvExe = venvPython(venvDir, deps.platform);
	const cached = await probe(venvExe);
	if (cached && meetsFloor(cached) && cached.pkg) return { kind: "venv", exe: venvExe, version: cached.pkg };

	if (eligible) {
		const recheck = await probe(venvExe); // a competing process may have published since the first probe
		if (recheck && meetsFloor(recheck) && recheck.pkg) return { kind: "venv", exe: venvExe, version: recheck.pkg };
		// Build in a sibling tmp dir without touching venvDir - a concurrent process can never probe a half-built venv.
		const tmp = `${venvDir}.tmp-${deps.pid}`;
		const deadline = deps.now() + cfg.warmTimeoutMs;
		const left = () => Math.max(1, deadline - deps.now());
		const bootFail = (stderr: string): Backend => {
			deps.rmrf(tmp);
			return { kind: "none", reason: `python ${eligible!.version} found but venv bootstrap failed: ${tail(stderr)} - install python3-venv, or uv` };
		};
		const mk = await deps.run(eligible.exe, ["-m", "venv", tmp], { timeoutMs: left(), capBytes: OUTPUT_MAX_BYTES, env: deps.env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (mk.code !== 0 || mk.timedOut) return bootFail(mk.stderr);
		const pip = await deps.run(venvPython(tmp, deps.platform), ["-m", "pip", "install", `pymupdf4llm==${cfg.pymupdfVersion}`], { timeoutMs: left(), capBytes: OUTPUT_MAX_BYTES, env: deps.env, signal });
		if (signal?.aborted) throw new Error("aborted");
		if (pip.code !== 0 || pip.timedOut) return bootFail(pip.stderr);
		const publish = (): boolean => {
			try { deps.rename(tmp, venvDir); return true; } catch { return false; }
		};
		if (publish()) return { kind: "venv", exe: venvExe, version: cfg.pymupdfVersion };
		// Rename failed - a competing process may have published first, or venvDir holds a stale/broken dir.
		const winner = await probe(venvExe);
		if (winner && meetsFloor(winner) && winner.pkg) {
			deps.rmrf(tmp); // healthy winner - clean up our loser
			return { kind: "venv", exe: venvExe, version: winner.pkg };
		}
		deps.rmrf(venvDir); // unhealthy/absent dest - clear it and retry the rename once
		if (publish()) return { kind: "venv", exe: venvExe, version: cfg.pymupdfVersion };
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

export function getBackend(cfg: DocToMdConfig, deps?: ResolverDeps, signal?: AbortSignal): Promise<Backend> {
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
	cfg: DocToMdConfig,
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
		const r = await run("soffice", soffArgs(src, profileDir, outDir), { timeoutMs: cfg.sofficeTimeoutMs, capBytes: OUTPUT_MAX_BYTES, env, signal });
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

export interface PipelineSeams {
	backend: (cfg: DocToMdConfig) => Promise<Backend>;
	convertPymupdf: (cfg: DocToMdConfig, backend: Backend, pdfPath: string, signal?: AbortSignal) => Promise<string>;
	convertUnpdf: (pdfPath: string, cfg: DocToMdConfig, signal?: AbortSignal) => Promise<string>;
}

export async function runPipeline(
	cfg: DocToMdConfig,
	inputPath: string,
	type: InputType,
	signal?: AbortSignal,
	seams?: Partial<PipelineSeams>,
): Promise<{ markdown: string; engine: Engine; degraded: boolean; fallbackReason?: string; backend: BackendKind; pymupdfVersion?: string }> {
	const s: PipelineSeams = {
		backend: (c) => getBackend(c, undefined, signal),
		convertPymupdf: (c, b, p, sig) => (b.kind === "uv" ? convertViaUv(c, p, sig) : convertViaPython(c, (b as { exe: string }).exe, p, sig)),
		convertUnpdf: convertViaUnpdf,
		...seams,
	};
	let pdfPath = inputPath;
	let cleanup: (() => void) | null = null;
	if (type === "docx" || type === "pptx") {
		const o = await convertOffice(cfg, inputPath, signal);
		pdfPath = o.pdfPath;
		cleanup = o.cleanup;
	}
	try {
		const backend = await s.backend(cfg);
		if (backend.kind === "none") {
			return { markdown: await s.convertUnpdf(pdfPath, cfg, signal), engine: "unpdf", degraded: true, fallbackReason: backend.reason, backend: "unpdf" };
		}
		try {
			const markdown = await s.convertPymupdf(cfg, backend, pdfPath, signal);
			return {
				markdown, engine: "pymupdf4llm", degraded: false, backend: backend.kind,
				...(backend.kind === "python" || backend.kind === "venv" ? { pymupdfVersion: backend.version } : {}),
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				markdown: await s.convertUnpdf(pdfPath, cfg, signal), engine: "unpdf", degraded: true,
				fallbackReason: `pymupdf4llm (${backend.kind}) conversion failed: ${msg} - fell back to unpdf`, backend: "unpdf",
			};
		}
	} finally {
		cleanup?.();
	}
}

// --- Public entry point ---

export interface ConvertOutcome {
	output: string;
	details: DocToMdDetails;
}

export async function convertDocument(
	path: string,
	cfg: DocToMdConfig,
	signal?: AbortSignal,
	seams?: Partial<PipelineSeams>,
): Promise<ConvertOutcome> {
	const inputPath = resolve(path);
	const st = statSync(inputPath, { throwIfNoEntry: false });
	if (!st || !st.isFile()) throw new Error(`Not a readable file: ${path}`);
	const type = classifyInput(inputPath);
	const { markdown, engine, degraded, fallbackReason, backend, pymupdfVersion } = await runPipeline(cfg, inputPath, type, signal, seams);
	// The formatter's output carries no trailing newline (the CLI appends exactly one); engines vary here, so normalize once.
	const body = withMarker(markdown, degraded).replace(/\s+$/, "");
	const { spill, bytes, lines } = applyGate(body);
	const details: DocToMdDetails = { path: inputPath, inputType: type, engine, backend, ...(pymupdfVersion !== undefined ? { pymupdfVersion } : {}), degraded, bytes, lines, spilled: spill };
	const header: string[] = [
		`Source: ${inputPath}`,
		`Type: ${type}  Engine: ${engine}${degraded ? " (degraded fallback)" : ""}`,
	];
	if (fallbackReason) header.push(`Fallback-Reason: ${fallbackReason}`);
	// The formatter's output carries no trailing newline (the CLI appends exactly one); strip once more on the composed string, since an empty body leaves a trailing blank-separator newline.
	const compose = (parts: string[]) => parts.join("\n").replace(/\n+$/, "");
	if (!spill) {
		return { output: compose([...header, `Length: ${bytes} bytes, ${lines} lines`, "", body]), details };
	}
	const file = spillToFile(inputPath, body);
	return {
		output: compose([
			...header,
			`Body: ${formatSize(bytes)} across ${lines} lines — written to file (too large to inline)`,
			`Saved-To: ${file}`,
			"",
			"Read slices of this file with the read tool (offset/limit) or grep it; do not read the whole file unless you must. Markdown is grep-able by heading (^#).",
			"",
			"----- preview (first 60 lines) -----",
			buildPreview(body),
		]),
		details: { ...details, spilled: true, file },
	};
}
