import { test } from "node:test";
import * as core from "../lib/doc-to-md-core.ts";
import assert from "node:assert/strict";
import { dirname, join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveOptions, TUNABLE_DEFAULTS } from "../lib/doc-to-md-options.ts";
import { classifyInput, soffArgs, warmArgs, uvChildArgs, pythonChildArgs, scriptPath, runCapped, KILL_GRACE_MS, VENV_DIR_NAME, LEGACY_VENV_DIR_NAMES, findPackageRoot, parseProbeOutput, meetsFloor, cacheDir, venvPython, resolveBackend, getBackend, resetBackendCacheForTests, probeArgs, PROBE_PROGRAM, officeFailure, tryConvertOffice, reconcileRenderMarkers, EXCEL_PDF_FILTER, pipInstallArgs, convertDocument, inspectDocument, prepareHtml, DEGRADED_HTML_TURNDOWN, resolveOcrLabels, resolveUnpdfWorker, type PipelineSeams, type TierResult, type Backend } from "../lib/doc-to-md-core.ts";
import type { CappedResult as CR, ResolverDeps } from "../lib/doc-to-md-core.ts";
import type { OcrInfo } from "../lib/doc-to-md-handle.ts";
import docToMdExtension from "../extensions/doc_to_md.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("tool description names supported formats and bundle locations", () => {
	let description = "";
	docToMdExtension({ registerTool: (tool: { description: string }) => { description = tool.description; } } as unknown as ExtensionAPI);
	for (const term of ["DOC", "XLSM", ".msg", ".eml", "pageImages", "pages/", "attachments/", "Two-pass OCR", "ocrMode", "Page-Stats"]) assert.ok(description.includes(term), term);
	assert.doesNotMatch(description, /Pages without a text layer and image inputs always keep their picture in images\//);
	assert.ok(!description.includes("\n"));
});

const FAKE_TIER = fileURLToPath(new URL("../test/fixtures/fake-tier.mjs", import.meta.url));

test("forced OCR uses office PDF through fallback, reports all child outcomes and holds lock", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-office-ocr-"));
	try {
		const modes: string[] = [];
		const r = await convertDocument(opts({ path: PPTX, outputDir: out, ocr: true, ocrMode: "all", pages: "1,2,3" }), undefined, {
			...seamsWith(async (mode, co) => {
				modes.push(mode); assert.equal(co.path, MULTIPAGE);
				if (mode === "pdf-primary") return { ok: false, reason: "timeout" };
				if (mode === "pdf-fallback") { assert.equal(co.ocr, false); return { ok: true, json: { markdown: "original\n", ocr: { ...OCR0, status: "unavailable", reason: "fallback tier", textless: [1] } } }; }
				await assert.rejects(convertDocument(opts({ path: PPTX, outputDir: out, overwrite: true, ocr: true, ocrMode: "all", pages: "1" }), undefined, seamsWith(async () => { throw Error("tier called"); })), /Another conversion owns/);
				return { ok: true, json: { status: "ran", written: [], noText: [1], ocrFailed: [2], ocrErrors: { "2": "bomb" }, budgetStopped: [3] } };
			}), office: fakeOffice({ ok: true, pdfPath: MULTIPAGE, cleanup: () => {} }),
		});
		assert.deepEqual(modes, ["pdf-primary", "pdf-fallback", "ocr-pages"]);
		assert.deepEqual(r.details.ocr, { ...OCR0, status: "ran", mode: "all", textless: [1], noText: [1], ocrFailed: [2], ocrErrors: { 2: "bomb" }, budgetStopped: [3] });
		assert.match(r.output, /OCR: forced \(eng\) - no text on page 1; failed on page 2 \(bomb\); budget-stopped page 3/);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("sidecar publish I/O failure aborts the bundle", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-publish-fail-"));
	try {
		mkdirSync(join(out, "ocr", "multipage-p002.md"), { recursive: true });
		await assert.rejects(convertDocument(opts({ outputDir: out, ocr: true, ocrMode: "all", pages: "2" }), undefined, seamsWith(async (mode, co) => {
			if (mode === "pdf-primary") return { ok: true, json: { markdown: "original", pageStats: [] } };
			stageSidecar(String(co.stagingDir), String(co.stem), 2, ".done");
			return { ok: true, json: { status: "ran", written: [2] } };
		})), /EISDIR|EPERM|EACCES/);
		for (const file of ["multipage.md", "multipage.md.lock", "multipage.pages.json"]) assert.ok(!existsSync(join(out, file)));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("textless stats are published without changing OCR, unpdf has no stats", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-textless-stats-"));
	try {
		const stats = [{ page: 1, chars: 300, images: 0, imageCoverage: 0 }];
		const r = await convertDocument(opts({ outputDir: out }), undefined, seamsWith(async () => ({ ok: true, json: { markdown: "text\n", pageStats: stats, ocr: OCR0 } })));
		assert.equal(r.details.ocr, null); assert.equal(r.details.ocrDir, null);
		assert.equal(parseHandle(r.output)["Page-Stats"], join(out, "multipage.pages.json"));
		const u = await convertDocument(opts({ outputDir: join(out, "u") }), undefined, seamsWith(async () => okTier("text\n", [1]), { kind: "none", reason: "missing" }));
		assert.deepEqual([u.details.pageStats, u.details.pageStatsPath], [null, null]); assert.ok(!u.output.includes("Page-Stats:"));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

function stageSidecar(stagingDir: string, stem: string, page: number, marker: ".done" | ".failed" | null, body = "recognized") {
	const tag = `p${String(page).padStart(3, "0")}`;
	const dir = join(stagingDir, tag); mkdirSync(dir, { recursive: true });
	if (marker !== ".failed") writeFileSync(join(dir, `${stem}-${tag}.md`), `<!-- OCR of page ${page} -->\n\n${body}\n\n--- end of page.page_number=${page} ---\n`);
	if (marker) writeFileSync(join(dir, marker), marker === ".failed" ? "RuntimeError: bomb" : "");
}

test("ocrMode all guards precede backend work", async () => {
	const noWork = { backend: async () => { throw Error("backend called"); } };
	await assert.rejects(convertDocument(opts({ ocrMode: "all", pages: "2" }), undefined, noWork), new core.UsageError("--ocr-mode all requires --ocr"));
	for (const pages of [undefined, ""]) await assert.rejects(convertDocument(opts({ ocr: true, ocrMode: "all", pages }), undefined, noWork), new core.UsageError('--ocr-mode all requires an explicit --pages selection (e.g. --pages 2,7); omitted pages and --pages "" mean all pages and are refused to keep OCR cost bounded'));
	for (const path of [DOCX, HTML_PAGE, OCR_PNG]) await assert.rejects(convertDocument(opts({ path, ocr: true, ocrMode: "all", pages: "1" }), undefined, noWork), new core.UsageError("--ocr-mode all applies to PDF, PPTX and DOC inputs only (DOCX pages are page-break segments, not PDF pages; convert the DOCX to PDF first)"));
	await assert.rejects(convertDocument(opts({ ocr: true, ocrMode: "all", pages: "1-100" }), undefined, seamsWith(async () => { throw Error("tier called"); }, { kind: "none", reason: "missing" })), /no Python backend/);
});

test("recoverOcrPages rebuilds markers, active checkpoint, empty and missing staging", () => {
	const root = mkdtempSync(join(tmpdir(), "quiver-recovery-"));
	try {
		stageSidecar(root, "s", 1, ".failed"); stageSidecar(root, "s", 2, ".done"); writeFileSync(join(root, "active"), "3");
		assert.deepEqual(core.recoverOcrPages(root, [1, 2, 3, 4], "timeout"), { written: [2], noText: [], ocrFailed: [1], ocrErrors: { 1: "RuntimeError: bomb" }, budgetStopped: [], killed: 3, notAttempted: [4], childError: null });
		stageSidecar(root, "s", 2, ".done", "");
		assert.deepEqual(core.recoverOcrPages(root, [2, 3], "crash").noText, [2]);
		assert.deepEqual(core.recoverOcrPages(join(root, "missing"), [5], "exit 1"), { written: [], noText: [], ocrFailed: [], ocrErrors: {}, budgetStopped: [], killed: null, notAttempted: [5], childError: "exit 1" });
		const empty = join(root, "empty"); mkdirSync(empty);
		assert.equal(core.recoverOcrPages(empty, [1], "stderr").childError, "stderr");
		writeFileSync(join(empty, "active"), ""); stageSidecar(empty, "s", 1, ".failed");
		writeFileSync(join(empty, "p001", ".failed"), "");
		const recovered = core.recoverOcrPages(empty, [1], "stderr");
		assert.equal(recovered.killed, null);
		assert.equal(recovered.ocrErrors[1], "unknown error");
		assert.equal(recovered.childError, null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("forced OCR second pass publishes stats and sidecars and reports child failures", async () => {
	const root = mkdtempSync(join(tmpdir(), "quiver-forced-"));
	const stats = [{ page: 2, chars: 1, images: 1, imageCoverage: 0.94 }];
	try {
		for (const failure of ["success", "timeout", "garbage", "early"]) {
			const out = join(root, failure); const modes: string[] = [];
			const r = await convertDocument(opts({ outputDir: out, ocr: true, ocrMode: "all", pages: "2,5", primaryTimeoutMs: 4321 }), undefined, seamsWith(async (mode, co, _b, _sig, timeout) => {
				modes.push(mode);
				if (mode === "pdf-primary") { assert.equal(co.ocr, false); return { ok: true, json: { markdown: "original\n", pageStats: stats, ocr: { ...OCR0, textless: [2] } } }; }
				assert.equal(mode, "ocr-pages"); assert.equal(timeout, 4321); assert.ok(!("words" in co));
				assert.deepEqual([co.path, co.pages, co.stem, co.ocrLanguage, co.ocrBudgetMs, co.dpi, co.maxOutputBytes, co.pymupdfVersion], [MULTIPAGE, [2, 5], "multipage", "eng", 4321, 150, TUNABLE_DEFAULTS.maxOutputBytes, TUNABLE_DEFAULTS.pymupdfVersion]);
				if (failure === "early") return { ok: false, reason: "exit 1", detail: "boom" };
				stageSidecar(String(co.stagingDir), String(co.stem), 2, ".done");
				if (failure !== "success") { writeFileSync(join(String(co.stagingDir), "active"), "5"); return failure === "garbage" ? { ok: true, json: {} } : { ok: false, reason: "timeout" }; }
				stageSidecar(String(co.stagingDir), String(co.stem), 5, ".done", "");
				return { ok: true, json: { status: "ran", written: [2], noText: [5], ocrFailed: [], ocrErrors: {}, budgetStopped: [] } };
			}));
			assert.deepEqual(modes, ["pdf-primary", "ocr-pages"]);
			assert.equal(readFileSync(r.details.savedTo, "utf8"), "original\n");
			assert.deepEqual(r.details.pageStats, stats); assert.deepEqual(JSON.parse(readFileSync(r.details.pageStatsPath!, "utf8")), stats);
			assert.equal(parseHandle(r.output)["Page-Stats"], r.details.pageStatsPath);
			assert.equal(r.details.ocr!.mode, "all"); assert.deepEqual(r.details.ocr!.textless, [2]);
			assert.ok(!existsSync(`${r.details.savedTo}.lock`));
			if (failure === "early") { assert.equal(r.details.ocr!.childError, "exit 1 (boom)"); assert.deepEqual(r.details.ocr!.notAttempted, [2, 5]); assert.equal(r.details.ocrDir, null); }
			else { assert.ok(existsSync(r.details.ocr!.sidecars[2])); assert.equal(parseHandle(r.output)["OCR-Dir"], join(out, "ocr")); assert.equal(r.details.ocr!.killed, failure === "success" ? null : 5); }
			if (failure === "success") assert.equal(parseHandle(r.output)["OCR"], "forced (eng) - sidecars for page 2; no text on page 5");
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("forced OCR unavailability and abort remove bundle artifacts", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-forced-abort-"));
	try {
		for (const abort of [false, true]) {
			const ac = new AbortController();
			await assert.rejects(convertDocument(opts({ outputDir: out, ocr: true, ocrMode: "all", pages: "2" }), ac.signal, seamsWith(async (mode, co) => {
				if (mode === "pdf-primary") return { ok: true, json: { markdown: "original", pageStats: [] } };
				if (!abort) return { ok: true, json: { status: "unavailable", reason: "language data for eng not installed" } };
				stageSidecar(String(co.stagingDir), String(co.stem), 2, ".done"); ac.abort(); return { ok: false, reason: "aborted" };
			})), abort ? /aborted/ : /OCR unavailable: language data for eng not installed/);
			for (const file of ["multipage.md", "multipage.md.lock", "multipage.pages.json", "ocr/multipage-p002.md"]) assert.ok(!existsSync(join(out, file)));
		}
	} finally { rmSync(out, { recursive: true, force: true }); }
});


test("classifyInput: routes by extension, case-insensitive", () => {
	assert.equal(classifyInput("/a/b.pdf"), "pdf");
	assert.equal(classifyInput("/a/b.PDF"), "pdf");
	assert.equal(classifyInput("report.docx"), "docx");
	assert.equal(classifyInput("deck.pptx"), "pptx");
});

test("classifyInput: rejects unsupported", () => {
	assert.equal(classifyInput("data.xlsx"), "xlsx");
	assert.throws(() => classifyInput("notes.txt"), /unsupported/i);
});

test("soffArgs: headless flags + isolated profile + convert-to pdf", () => {
	const a = soffArgs("/in/deck.pptx", "/tmp/prof", "/tmp/out");
	assert.ok(a.includes("--headless") && a.includes("--convert-to") && a.includes("pdf"));
	assert.ok(a.includes(`-env:UserInstallation=${pathToFileURL("/tmp/prof").href}`));
	assert.equal(a[a.length - 1], "/in/deck.pptx");
	const oi = a.indexOf("--outdir");
	assert.equal(a[oi + 1], "/tmp/out");
});

test("soffArgs: profile dir with a space is percent-encoded into a valid file URI", () => {
	const profileDir = join(tmpdir(), "pro f");
	const a = soffArgs(join(tmpdir(), "deck.pptx"), profileDir, tmpdir());
	assert.ok(a.includes(`-env:UserInstallation=${pathToFileURL(profileDir).href}`));
});

test("soffArgs: windows drive-path profile dir yields a valid file URI (win32 only)", { skip: process.platform !== "win32" }, () => {
	const a = soffArgs("C:\\in\\deck.pptx", "C:\\Users\\x\\prof", "C:\\Users\\x\\out");
	assert.ok(a.includes("-env:UserInstallation=file:///C:/Users/x/prof"));
});

test("runCapped: captures stdout + exit code", async () => {
	const r = await runCapped("printf", ["hello"], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.stdout, "hello");
	assert.equal(r.code, 0);
	assert.equal(r.timedOut, false);
	assert.equal(r.capped, false);
});

test("runCapped: non-zero exit captured", async () => {
	const r = await runCapped("sh", ["-c", "echo oops 1>&2; exit 3"], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.code, 3);
	assert.match(r.stderr, /oops/);
});

test("runCapped: timeout kills the child", async () => {
	const r = await runCapped("sh", ["-c", "sleep 5"], { timeoutMs: 200, capBytes: 1000 });
	assert.equal(r.timedOut, true);
});

test("runCapped: killed child close clears the kill-grace timer", async () => {
	const core = new URL("../lib/doc-to-md-core.ts", import.meta.url).href;
	const program = `import { runCapped } from ${JSON.stringify(core)}; await runCapped(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 150, capBytes: 1000 }); console.log("settled");`;
	const t0 = Date.now();
	const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", program]);
	assert.equal(stdout.trim(), "settled");
	assert.ok(Date.now() - t0 < 1_150, "stale kill-grace timer delayed subprocess exit");
});

test("runCapped: output cap trips and kills the child", async () => {
	const r = await runCapped("sh", ["-c", "yes x | head -c 100000"], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.capped, true);
	assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 1000 + 64);
});

test("runCapped: spawn error (ENOENT) resolves with code null, does not reject", async () => {
	const r = await runCapped("this_binary_does_not_exist_xyz", [], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.code, null);
	assert.equal(r.timedOut, false);
	assert.equal(r.capped, false);
	assert.match(r.stderr, /ENOENT/);
});

import { existsSync as existsSyncS, mkdirSync as mkdirS, mkdtempSync as mkdtempS, writeFileSync as writeS } from "node:fs";
import { tmpdir as tmpdirOs } from "node:os";
import { dirname as dirnameP, join as joinP } from "node:path";

const UNPDF_WORKERS = ["/package/dist/lib/unpdf-worker.js", "/package/lib/unpdf-worker.js", "/package/lib/unpdf-worker.ts"];

test("resolveUnpdfWorker: bundled worker wins over TypeScript source", () => {
	assert.equal(resolveUnpdfWorker(UNPDF_WORKERS, (path) => path === UNPDF_WORKERS[0] || path === UNPDF_WORKERS[2]), UNPDF_WORKERS[0]);
});

test("resolveUnpdfWorker: uses TypeScript source when no bundle exists", () => {
	assert.equal(resolveUnpdfWorker(UNPDF_WORKERS, (path) => path === UNPDF_WORKERS[2]), UNPDF_WORKERS[2]);
});

test("resolveUnpdfWorker: errors when no worker exists", () => {
	assert.throws(() => resolveUnpdfWorker(UNPDF_WORKERS, () => false), /unpdf worker not found/);
});

test("findPackageRoot: resolves from lib/, dist/bin/, and package root itself", () => {
	const root = mkdtempS(joinP(tmpdirOs(), "quiver-root-"));
	writeS(joinP(root, "package.json"), "{}");
	for (const sub of ["lib", joinP("dist", "bin")]) {
		mkdirS(joinP(root, sub), { recursive: true });
		assert.equal(findPackageRoot(joinP(root, sub)), root);
	}
	assert.equal(findPackageRoot(root), root);
});

test("findPackageRoot: installed-tarball layout — nearest package.json wins, not an outer root", () => {
	const root = mkdtempS(joinP(tmpdirOs(), "quiver-outer-"));
	writeS(joinP(root, "package.json"), "{}");
	const pkgRoot = joinP(root, "node_modules", "pi-quiver");
	mkdirS(joinP(pkgRoot, "lib"), { recursive: true });
	writeS(joinP(pkgRoot, "package.json"), "{}");
	assert.equal(findPackageRoot(joinP(pkgRoot, "lib")), pkgRoot);
});

test("findPackageRoot: throws when no package.json exists upward", () => {
	// tmpdir ancestors may legitimately contain a package.json (env-dependent) - check first, assert accordingly
	const bare = mkdtempS(joinP(tmpdirOs(), "quiver-bare-"));
	let ancestorWithPkg: string | null = null;
	let dir = bare;
	for (;;) {
		if (existsSyncS(joinP(dir, "package.json"))) { ancestorWithPkg = dir; break; }
		const parent = dirnameP(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (ancestorWithPkg === null) {
		assert.throws(() => findPackageRoot(bare), /package\.json not found/);
	} else {
		assert.equal(findPackageRoot(bare), ancestorWithPkg);
	}
});

test("parseProbeOutput: PY/PDF/XLSX/DOCX grammar", () => {
	assert.deepEqual(parseProbeOutput("PY 3 12\nPDF yes\nXLSX no\nDOCX no\nEMAIL no\n"), { major: 3, minor: 12, pdf: true, xlsx: false, docx: false, email: false });
	assert.deepEqual(parseProbeOutput("PY 3 14\r\nPDF yes\r\nXLSX yes\r\nDOCX yes\r\nEMAIL yes\r\n"), { major: 3, minor: 14, pdf: true, xlsx: true, docx: true, email: true });
	assert.equal(parseProbeOutput("PY 3 12\nPDF yes\nXLSX yes\n"), null);
});

test("meetsFloor: >= 3.12 only", () => {
	assert.equal(meetsFloor({ major: 3, minor: 12, pdf: false, xlsx: false, docx: false, email: false }), true);
	assert.equal(meetsFloor({ major: 4, minor: 0, pdf: false, xlsx: false, docx: false, email: false }), true);
	assert.equal(meetsFloor({ major: 3, minor: 11, pdf: false, xlsx: false, docx: false, email: false }), false);
	assert.equal(meetsFloor({ major: 2, minor: 7, pdf: false, xlsx: false, docx: false, email: false }), false);
});

test("cacheDir: per-platform, env-driven", () => {
	assert.equal(cacheDir("win32", { LOCALAPPDATA: "C:\\LAD" }, "C:\\Users\\u"), join("C:\\LAD", "pi-quiver"));
	assert.equal(cacheDir("win32", {}, "C:\\Users\\u"), join("C:\\Users\\u", "AppData", "Local", "pi-quiver"));
	assert.equal(cacheDir("darwin", {}, "/Users/u"), join("/Users/u", "Library", "Caches", "pi-quiver"));
	assert.equal(cacheDir("linux", { XDG_CACHE_HOME: "/xdg" }, "/home/u"), join("/xdg", "pi-quiver"));
	assert.equal(cacheDir("linux", {}, "/home/u"), join("/home/u", ".cache", "pi-quiver"));
});

test("venvPython: Scripts on win32, bin elsewhere", () => {
	assert.equal(venvPython("/c/venv", "win32"), join("/c/venv", "Scripts", "python.exe"));
	assert.equal(venvPython("/c/venv", "linux"), join("/c/venv", "bin", "python"));
});

const ok = (stdout: string): CR => ({ stdout, stderr: "", code: 0, timedOut: false, capped: false });
const fail = (stderr = "boom", code: number | null = 1): CR => ({ stdout: "", stderr, code, timedOut: false, capped: false });
const enoent = (): CR => ({ stdout: "", stderr: "spawn ENOENT", code: null, timedOut: false, capped: false });

function fakeDeps(script: Record<string, CR | CR[]>, over: Partial<ResolverDeps> = {}): ResolverDeps & { calls: string[]; renames: [string, string][]; rms: string[] } {
	const calls: string[] = [];
	const renames: [string, string][] = [];
	const rms: string[] = [];
	return {
		run: async (cmd) => {
			calls.push(cmd);
			const hit = script[cmd];
			if (hit === undefined) return enoent();
			if (Array.isArray(hit)) return hit.length > 1 ? hit.shift()! : hit[0];
			return hit;
		},
		cacheRoot: FAKE_CACHE_ROOT, platform: process.platform, pid: 42,
		rename: (a, b) => { renames.push([a, b]); }, rmrf: (p) => { rms.push(p); }, now: () => 0,
		calls, renames, rms, ...over,
	};
}
const CFG = { pymupdfVersion: TUNABLE_DEFAULTS.pymupdfVersion, warmTimeoutMs: TUNABLE_DEFAULTS.warmTimeoutMs };
const FAKE_CACHE_ROOT = join(tmpdir(), "pi-quiver-test-cache");
const FAKE_VENV_DIR = join(FAKE_CACHE_ROOT, VENV_DIR_NAME);
const FAKE_VENV_EXE = venvPython(FAKE_VENV_DIR, process.platform);
const FAKE_VENV_TMP_DIR = join(FAKE_CACHE_ROOT, `${VENV_DIR_NAME}.tmp-42`);
const FAKE_VENV_TMP_EXE = venvPython(FAKE_VENV_TMP_DIR, process.platform);

test("resolver: injected env is threaded into the run seam", async () => {
	const seenEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n") });
	const injectedEnv = { FOO: "bar" };
	const wrapped: ResolverDeps = {
		...d,
		env: injectedEnv,
		run: async (cmd, args, opts) => { seenEnvs.push(opts.env); return d.run(cmd, args, opts); },
	};
	await resolveBackend(CFG, wrapped);
	assert.ok(seenEnvs.length > 0 && seenEnvs.every((e) => e === injectedEnv));
});

test("resolver: uv warm success -> uv backend", async () => {
	const d = fakeDeps({ uv: ok("") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "uv", pdf: true, xlsx: true, docx: true, email: true });
});

test("resolver: uv absent, python3 importable -> python backend, python not probed", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", pdf: true, xlsx: true, docx: true, email: true });
	assert.ok(!d.calls.includes("python"));
});

test("resolver: uv warm FAILURE (present) still continues to python", async () => {
	const d = fakeDeps({ uv: fail("warm exploded"), python3: ok("PY 3 13\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", pdf: true, xlsx: true, docx: true, email: true });
});

test("resolver: python3 too old is skipped entirely; python picks up", async () => {
	const d = fakeDeps({ python3: ok("PY 3 11\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n"), python: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python", pdf: true, xlsx: true, docx: true, email: true });
});

test("resolver: all candidates package-less -> bootstrap from first eligible; venv backend at pin", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		python: ok("PY 3 13\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_EXE]: enoent(),
		[FAKE_VENV_TMP_EXE]: ok(""), // pip install
	});
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	assert.deepEqual(d.renames, [[FAKE_VENV_TMP_DIR, FAKE_VENV_DIR]]);
	// python (second candidate) still probed before bootstrap chose python3
	assert.ok(d.calls.includes("python"));
});

test("resolver: cached venv without DOCX packages is rebuilt", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"), [FAKE_VENV_EXE]: ok("PY 3 14\nPDF yes\nXLSX yes\nDOCX no\nEMAIL no\n"), [FAKE_VENV_TMP_EXE]: ok("") });
	const b = await resolveBackend(CFG, d);
	assert.deepEqual(b, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	assert.ok(d.renames.length === 1);
});

test("resolver: cached venv wins over bootstrap, loses to importable system python", async () => {
	const cachedOnly = fakeDeps({ python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"), [FAKE_VENV_EXE]: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n") });
	assert.deepEqual(await resolveBackend(CFG, cachedOnly), { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	const sysWins = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n"), [FAKE_VENV_EXE]: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n") });
	assert.deepEqual(await resolveBackend(CFG, sysWins), { kind: "python", exe: "python3", pdf: true, xlsx: true, docx: true, email: true });
});

test("resolver: broken cached venv is removed and re-bootstrapped", async () => {
	// First rename attempt fails because the stale broken venvDir is still present; the winner probe finds it still
	// broken, so venvDir is rmrf'd and the rename is retried.
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_EXE]: fail("dyld: missing"),
		[FAKE_VENV_TMP_EXE]: ok(""),
	}, { rename: (() => { let n = 0; return () => { n++; if (n === 1) throw new Error("EEXIST"); }; })() });
	const r = await resolveBackend(CFG, d);
	assert.equal(r.kind, "venv");
	assert.ok(d.rms.includes(FAKE_VENV_DIR));
});

test("resolver: winner publishes after our build starts — first rename fails, healthy winner adopted, never rmrf'd", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		// cached probe + recheck: absent (no winner yet); post-rename-failure probe: winner has published
		[FAKE_VENV_EXE]: [enoent(), enoent(), ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n")],
		[FAKE_VENV_TMP_EXE]: ok(""),
	}, { rename: () => { throw new Error("EEXIST"); } });
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	assert.deepEqual(d.rms, [FAKE_VENV_TMP_DIR]); // only our tmp cleaned up, winner's venvDir untouched
});

test("resolver: bootstrap pip failure -> none with closed-list reason", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_TMP_EXE]: fail("No matching distribution"),
	});
	const r = await resolveBackend(CFG, d);
	assert.equal(r.kind, "none");
	assert.ok(r.kind === "none" && /python 3\.12 found but venv bootstrap failed: .*No matching distribution.* - install python3-venv, or uv/.test(r.reason));
	assert.ok(d.rms.includes(FAKE_VENV_TMP_DIR));
});

test("resolver: nothing available -> none with install hint", async () => {
	const d = fakeDeps({});
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "none", reason: "uv not found; no python >= 3.12 on PATH - install uv, or Python 3.12+" });
});

test("resolver: uv present-but-failed and no python -> uv warm-up reason", async () => {
	const d = fakeDeps({ uv: fail("uv panic") });
	const r = await resolveBackend(CFG, d);
	assert.ok(r.kind === "none" && /^uv warm-up failed: .*uv panic.*; no python >= 3\.12 on PATH$/.test(r.reason));
});

test("resolver: rename race — competing publish wins, winner probed", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_EXE]: [enoent(), enoent(), ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n")], // first probe: absent; pre-rmrf recheck: absent; post-race probe: winner
		[FAKE_VENV_TMP_EXE]: ok(""),
	}, { rename: () => { throw new Error("EEXIST"); } });
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
});

test("resolver: competing venv published between probe and bootstrap is adopted, not deleted", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_EXE]: [enoent(), ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n")], // first probe: absent; recheck: winner appeared
	});
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	assert.deepEqual(d.rms, []); // never deleted the winner
	assert.deepEqual(d.renames, []); // never bootstrapped
});

test("getBackend: shared promise — concurrent first calls resolve once", async () => {
	resetBackendCacheForTests();
	let resolves = 0;
	const d = fakeDeps({ uv: ok("") });
	const counted: ResolverDeps = { ...d, run: async (...a) => { if (a[0] === "uv") resolves++; return d.run(...a); } };
	const [a, b] = await Promise.all([getBackend(CFG, counted), getBackend(CFG, counted)]);
	assert.deepEqual(a, b);
	assert.equal(resolves, 1);
	resetBackendCacheForTests();
});

test("getBackend: sticky none — a none resolution is cached for the session", async () => {
	resetBackendCacheForTests();
	const d = fakeDeps({});
	const first = await getBackend(CFG, d);
	const callsAfterFirst = d.calls.length;
	const second = await getBackend(CFG);
	assert.equal(d.calls.length, callsAfterFirst);
	const expected = { kind: "none", reason: "uv not found; no python >= 3.12 on PATH - install uv, or Python 3.12+" };
	assert.deepEqual(first, expected);
	assert.deepEqual(second, expected);
	resetBackendCacheForTests();
});

test("getBackend: concurrent first calls bootstrap the venv once", async () => {
	resetBackendCacheForTests();
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_EXE]: enoent(),
		[FAKE_VENV_TMP_EXE]: ok(""),
	});
	const [a, b] = await Promise.all([getBackend(CFG, d), getBackend(CFG, d)]);
	const expected = { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true };
	assert.deepEqual(a, expected);
	assert.deepEqual(b, expected);
	assert.equal(d.renames.length, 1);
	resetBackendCacheForTests();
});

test("probeArgs: -c + probe program", () => {
	assert.deepEqual(probeArgs(), ["-c", PROBE_PROGRAM]);
});

test("resolveBackend: an already-aborted signal rejects before any run completes", async () => {
	const ac = new AbortController();
	ac.abort();
	const d = fakeDeps({ uv: ok("") });
	await assert.rejects(resolveBackend(CFG, d, ac.signal), /aborted/);
});

test("getBackend: an aborted first resolution does not poison the session for later callers", async () => {
	resetBackendCacheForTests();
	const ac = new AbortController();
	ac.abort();
	const badDeps = fakeDeps({ uv: ok("") });
	await assert.rejects(getBackend(CFG, badDeps, ac.signal), /aborted/);
	const goodDeps = fakeDeps({ uv: ok("") });
	assert.deepEqual(await getBackend(CFG, goodDeps), { kind: "uv", pdf: true, xlsx: true, docx: true, email: true });
	resetBackendCacheForTests();
});

test("getBackend: a non-creator's abort signal is ignored — creator-only binding", async () => {
	resetBackendCacheForTests();
	const d = fakeDeps({ uv: ok("") });
	const ac = new AbortController();
	ac.abort();
	const first = await getBackend(CFG, d); // creates backendPromise, no signal
	const second = await getBackend(CFG, undefined, ac.signal); // finds existing promise, aborted signal must be ignored
	assert.deepEqual(first, { kind: "uv", pdf: true, xlsx: true, docx: true, email: true });
	assert.deepEqual(second, { kind: "uv", pdf: true, xlsx: true, docx: true, email: true });
	resetBackendCacheForTests();
});

test("tryConvertOffice: soffice ran (code 0) but produced no PDF - failure names LibreOffice", async () => {
	const run = async (): Promise<CR> => ({ stdout: "", stderr: "", code: 0, timedOut: false, capped: false });
	const result = await tryConvertOffice(120_000, join(process.cwd(), "test/fixtures/sample.docx"), undefined, run);
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(officeFailure(result).message, /LibreOffice/);
});



test("warmArgs: pins the full package set + python 3.14 + import probe", () => {
	assert.deepEqual(warmArgs(CFG), ["run", "--with", "pymupdf4llm==1.27.2.3", "--with", "openpyxl==3.1.5", "--with", "xlrd==2.0.2", "--with", "pillow==12.3.0", "--with", "mammoth==1.13.0", "--with", "markdownify==1.2.3", "--with", "python-docx==1.2.0", "--with", "extract-msg==0.56.1", "--python", "3.14", "python", "-c", "import pymupdf4llm, openpyxl, xlrd, PIL, mammoth, markdownify, docx, extract_msg"]);
});

test("uvChildArgs / pythonChildArgs: mode only on argv, script resolved from package root", () => {
	assert.deepEqual(uvChildArgs(CFG, "/pkg/scripts/doc_to_md.py", "pdf-primary").slice(-3), ["python", "/pkg/scripts/doc_to_md.py", "pdf-primary"]);
	assert.deepEqual(pythonChildArgs("/pkg/scripts/doc_to_md.py", "xlsx"), ["/pkg/scripts/doc_to_md.py", "xlsx"]);
	assert.ok(scriptPath().endsWith(join("scripts", "doc_to_md.py")));
});

test("PROBE_PROGRAM gates PDF, XLSX, and DOCX on their imports", () => {
	assert.match(PROBE_PROGRAM, /import pymupdf\b/);
	assert.match(PROBE_PROGRAM, /1\.27\.0/);
	assert.match(PROBE_PROGRAM, /import openpyxl, xlrd, PIL/);
	assert.match(PROBE_PROGRAM, /import mammoth, markdownify, docx\n\s+print\("DOCX", "yes"\)/);
	assert.match(PROBE_PROGRAM, /import extract_msg, markdownify\n\s+print\("EMAIL", "yes"\)/);
});

test("runCapped: stdin is delivered to the child", async () => {
	const r = await runCapped(process.execPath, [FAKE_TIER, "x"], { timeoutMs: 10_000, capBytes: 1_000_000, stdin: JSON.stringify({ script: { stdout: "echo-ok" } }) });
	assert.equal(r.code, 0); assert.equal(r.stdout, "echo-ok");
});

test("runCapped: stdin over 40K chars is accepted", async () => {
	const big = JSON.stringify({ script: { stdout: "ok" }, pad: "p".repeat(45_000) });
	const r = await runCapped(process.execPath, [FAKE_TIER, "x"], { timeoutMs: 10_000, capBytes: 1_000_000, stdin: big });
	assert.equal(r.stdout, "ok");
});

test("runCapped: timeout kills the child AND its grandchild; settles within timeout + KILL_GRACE_MS", { timeout: 20_000 }, async () => {
	const t0 = Date.now();
	const r = await runCapped(process.execPath, [FAKE_TIER, "x"], { timeoutMs: 500, capBytes: 1_000_000, stdin: JSON.stringify({ script: { spawnGrandchild: true, sleepMs: 60_000 } }) });
	assert.ok(r.timedOut);
	assert.ok(Date.now() - t0 < 500 + KILL_GRACE_MS + 1500);
	const gc = Number(r.stderr.match(/grandchild=(\d+)/)?.[1]);
	assert.ok(gc > 0, r.stderr);
	await new Promise((res) => setTimeout(res, 300));
	const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
	if (process.platform === "win32") {
		const { execSync } = await import("node:child_process");
		assert.ok(!String(execSync(`tasklist /FI "PID eq ${gc}"`)).includes(String(gc)));
	} else {
		assert.ok(!alive(gc), `grandchild ${gc} still alive`);
	}
});

test("resolver: absolute deadline stops discovery after the warm call exhausts it", async () => {
	let t = 0;
	const seen: number[] = [];
	const d = fakeDeps({ uv: fail("warm failed"), python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n") }, { now: () => t });
	const wrapped: ResolverDeps = { ...d, run: async (cmd, args, opts) => { seen.push(opts.timeoutMs); t += 3000; return d.run(cmd, args, opts); } };
	const backend = await resolveBackend({ ...CFG, warmTimeoutMs: 5000 }, wrapped);
	assert.deepEqual(seen, [5000, 2000]);
	assert.equal(backend.kind, "none");
	if (backend.kind === "none") assert.match(backend.reason, /exceeded warmTimeoutMs/);
});

test("resolver: uv elapsed time bounds discovery before fake bootstrap stages can run", async () => {
	let t = 0;
	const timeouts: number[] = [];
	const d = fakeDeps({ uv: fail("warm failed"), python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n") }, { now: () => t });
	const wrapped: ResolverDeps = {
		...d,
		run: async (cmd, args, runOpts) => {
			timeouts.push(runOpts.timeoutMs);
			// The warm command consumes 4 seconds; probes and either bootstrap stage
			// would take 2 seconds, so the deadline prevents bootstrap after the probe.
			t += cmd === "uv" || args.includes("-c") ? (cmd === "uv" ? 4000 : 2000) : 2000;
			return d.run(cmd, args, runOpts);
		},
	};
	const backend = await resolveBackend({ ...CFG, warmTimeoutMs: 5000 }, wrapped);
	assert.deepEqual(timeouts, [5000, 1000]);
	assert.ok(timeouts.reduce((sum, timeout) => sum + timeout, 0) <= 5000 + KILL_GRACE_MS);
	assert.equal(backend.kind, "none");
	if (backend.kind === "none") assert.match(backend.reason, /exceeded warmTimeoutMs/);
});

test("resolver: bootstrap stays within its absolute simulated deadline", async () => {
	let t = 0;
	const timeouts: { left: number; timeout: number }[] = [];
	const d = fakeDeps({
		uv: fail("warm failed"),
		python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"),
		[FAKE_VENV_EXE]: [enoent(), enoent()],
		[FAKE_VENV_TMP_EXE]: ok("PY 3 12\nPDF yes\nXLSX yes\nDOCX yes\nEMAIL yes\n"),
	}, { now: () => t });
	const wrapped: ResolverDeps = {
		...d,
		run: async (cmd, args, opts) => {
			const left = 5000 - t;
			timeouts.push({ left, timeout: opts.timeoutMs });
			if (cmd === "uv") t += 1000;
			else if (cmd === "python3" && args.includes("-c")) t += 500;
			else if (cmd === "python3" && args.join(" ").includes("-m venv")) t += 1500;
			else if (cmd === FAKE_VENV_TMP_EXE) t += 1500;
			return d.run(cmd, args, opts);
		},
	};
	const t0 = t;
	const backend = await resolveBackend({ ...CFG, warmTimeoutMs: 5000 }, wrapped);
	assert.deepEqual(backend, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	assert.ok(t - t0 <= 5000 + KILL_GRACE_MS, `simulated elapsed ${t - t0}ms`);
	assert.ok(timeouts.every(({ left, timeout }) => timeout <= left), JSON.stringify(timeouts));
});

test("resolver: python with PDF but not XLSX is a valid python backend with xlsx=false", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX no\nDOCX no\nEMAIL no\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", pdf: true, xlsx: false, docx: false, email: false });
});

test("resolver: bootstrap installs the full package set into doc-to-md-venv-v4 and removes both legacy venvs", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF no\nXLSX no\nDOCX no\nEMAIL no\n"), [FAKE_VENV_TMP_EXE]: ok("") });
	const seenArgs: string[][] = [];
	const wrapped: ResolverDeps = { ...d, run: async (cmd, args, opts) => { seenArgs.push(args); return d.run(cmd, args, opts); } };
	const b = await resolveBackend(CFG, wrapped);
	assert.deepEqual(b, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true, docx: true, email: true });
	assert.ok(seenArgs.some((a) => a.join(" ") === "-m pip install pymupdf4llm==1.27.2.3 openpyxl==3.1.5 xlrd==2.0.2 pillow==12.3.0 mammoth==1.13.0 markdownify==1.2.3 python-docx==1.2.0 extract-msg==0.56.1"));
	assert.deepEqual(d.renames, [[FAKE_VENV_TMP_DIR, FAKE_VENV_DIR]]);
	assert.equal(VENV_DIR_NAME, "doc-to-md-venv-v4");
	for (const legacy of ["pymupdf-venv", "doc-to-md-venv-v2", "doc-to-md-venv-v3"]) assert.ok(d.rms.includes(join(FAKE_CACHE_ROOT, legacy)), legacy);
	assert.deepEqual(LEGACY_VENV_DIR_NAMES, ["pymupdf-venv", "doc-to-md-venv-v2", "doc-to-md-venv-v3"]);
});

const MULTIPAGE = fileURLToPath(new URL("../test/fixtures/multipage.pdf", import.meta.url));
const opts = (extra: Record<string, unknown> = {}) => resolveOptions({ path: MULTIPAGE, ...extra } as never, {}, {});
const okTier = (markdown: string, pages: number[]): TierResult => ({ ok: true, json: { markdown, pages, pageCount: 6, emptyPages: [], failedPages: [], notes: [] } });
const seamsWith = (runTier: PipelineSeams["runTier"], backend: Backend = { kind: "uv", pdf: true, xlsx: true, docx: true, email: true }): Partial<PipelineSeams> => ({ backend: async () => backend, runTier });

const HTML_PAGE = fileURLToPath(new URL("../test/fixtures/html/page.html", import.meta.url));
const OCR_PNG = fileURLToPath(new URL("../test/fixtures/ocr.png", import.meta.url));
const imageOpts = (extra: Record<string, unknown> = {}) => resolveOptions({ path: OCR_PNG, ...extra } as never, {}, {});
const OCR0: OcrInfo = { status: "off", lang: "eng", textless: [], pages: [], noText: [], ocrFailed: [], budgetStopped: [], reason: null, tesseract: null, mode: "textless", sidecars: {}, wordSidecars: {}, ocrErrors: {}, killed: null, notAttempted: [], childError: null };

test("words publication, child options, errors and nonfatal reasons", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-words-"));
	try {
		const r = await convertDocument(opts({ outputDir: out, words: true }), undefined, seamsWith(async (_m, co) => {
			assert.equal(co.words, true);
			writeFileSync(join(String(co.stagingDir), "words.json"), '{"unit":"pt","pages":[]}');
			return { ok: true, json: { markdown: "text\n", words: true, wordsErrors: { "3": "RuntimeError: x", file: "write error" } } };
		}));
		assert.equal(r.details.wordsPath, join(out, "multipage.words.json"));
		assert.equal(r.details.wordsReason, null);
		assert.deepEqual(r.details.wordsErrors, { 3: "RuntimeError: x" });
		assert.deepEqual(JSON.parse(readFileSync(r.details.wordsPath!, "utf8")), { unit: "pt", pages: [] });
		assert.equal(parseHandle(r.output)["Words"], `${r.details.wordsPath} (extraction failed for pages 3: RuntimeError: x)`);
		const plain = await convertDocument(opts({ outputDir: join(out, "plain") }), undefined, seamsWith(async (_m, co) => { assert.ok(!("words" in co)); return okTier("text\n", [1]); }));
		assert.deepEqual([plain.details.wordsPath, plain.details.wordsReason], [null, null]);
		assert.ok(!plain.output.includes("Words:"));
		const wf = await convertDocument(opts({ outputDir: join(out, "wf"), words: true }), undefined, seamsWith(async () => ({ ok: true, json: { markdown: "text\n", words: true } })));
		assert.deepEqual([wf.details.wordsPath, wf.details.wordsReason], [null, "write failed - child staged no words.json"]);
		assert.ok(existsSync(wf.details.savedTo));
		const childWriteFailure = await convertDocument(opts({ outputDir: join(out, "child-write-failure"), words: true }), undefined, seamsWith(async () => ({ ok: true, json: { markdown: "text\n", words: false, wordsErrors: { file: "OSError: disk full" } } })));
		assert.equal(childWriteFailure.details.wordsReason, "write failed - OSError: disk full");
		assert.equal(childWriteFailure.details.wordsPath, null);
		assert.equal(readFileSync(childWriteFailure.details.savedTo, "utf8"), "text\n");
		assert.ok(!existsSync(join(out, "child-write-failure", "multipage.words.json")));
		assert.deepEqual(childWriteFailure.details.wordsErrors, {});
		const u = await convertDocument(opts({ outputDir: join(out, "u"), words: true }), undefined, seamsWith(async () => okTier("text\n", [1]), { kind: "none", reason: "missing" }));
		assert.equal(u.details.wordsReason, "none - unpdf tier has no page geometry");
		const d = await convertDocument(docxOpts({ outputDir: join(out, "d"), words: true }), undefined, seamsWith(async (_m, co) => { assert.ok(!("words" in co)); return { ok: true, json: { markdown: "x\n", pageCount: 1, engine: "mammoth" } }; }));
		assert.equal(d.details.wordsReason, "none - word positions apply to PDF and image inputs only (docx)");
		const c = await convertDocument(imageOpts({ outputDir: join(out, "c"), words: true }), undefined, seamsWith(async (_m, co) => { assert.equal(co.words, true); return { ok: false, reason: "boom" }; }));
		assert.equal(c.details.engine, "copy");
		assert.equal(c.details.wordsReason, "none - image copied without conversion (OCR child failed: boom)");
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("words forced OCR publishes word sidecars, merges errors and abort cleans publication", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-words-all-"));
	try {
		const r = await convertDocument(opts({ outputDir: out, ocr: true, ocrMode: "all", pages: "2,3", words: true }), undefined, seamsWith(async (mode, co): Promise<TierResult> => {
			if (mode === "pdf-primary") {
				writeFileSync(join(String(co.stagingDir), "words.json"), '{"unit":"pt","pages":[]}');
				return { ok: true, json: { markdown: "text\n", words: true, wordsErrors: { "1": "RuntimeError: x" } } };
			}
			assert.equal(co.words, true);
			assert.ok(existsSync(join(out, "multipage.words.json")));
			stageSidecar(String(co.stagingDir), String(co.stem), 2, ".done");
			writeFileSync(join(String(co.stagingDir), "p002", "multipage-p002.words.json"), '{}');
			stageSidecar(String(co.stagingDir), String(co.stem), 3, ".done");
			return { ok: true, json: { status: "ran", written: [2, 3], wordsErrors: { "3": "RuntimeError: y" } } };
		}));
		assert.deepEqual(r.details.ocr!.wordSidecars, { 2: join(out, "ocr", "multipage-p002.words.json") });
		assert.deepEqual(r.details.wordsErrors, { 1: "RuntimeError: x", 3: "RuntimeError: y" });
		assert.ok(existsSync(join(out, "ocr", "multipage-p002.words.json")));
		await assert.rejects(convertDocument(opts({ outputDir: join(out, "abort"), words: true }), undefined, seamsWith(async (_m, co) => {
			writeFileSync(join(String(co.stagingDir), "words.json"), "{}");
			return { ok: true, json: { markdown: "![x](p1/missing.png)\n", words: true } };
		})));
		assert.ok(!existsSync(join(out, "abort", "multipage.words.json")));
	} finally { rmSync(out, { recursive: true, force: true }); }
});
function stagePage(b: { stagingDir: string }, page: number, file: string) {
 const d = join(b.stagingDir, `p${page}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, file), "x"); writeFileSync(join(d, ".done"), "");
}

test("convertDocument image: child result published, stem passed, OCR line", async () => {
 let stem: unknown;
 const r = await convertDocument(imageOpts(), undefined, seamsWith(async (mode, co, b) => {
  assert.equal(mode, "image"); stem = co.stem; stagePage(b, 1, "original.png");
  return { ok: true, json: { markdown: "![ocr](p1/original.png)\n", pageCount: 1, emptyPages: [], failedPages: [], notes: [], ocr: { ...OCR0, tesseract: true } } };
 }));
 assert.equal(stem, "ocr");
 assert.match(r.output, /^Type: image   Engine: pymupdf4llm   Tier: image$/m);
 assert.match(r.output, /^OCR: off; rerun with ocr=true$/m);
 assert.ok(readFileSync(r.details.savedTo, "utf8").includes("![ocr](images/ocr-p1-1.png)"));
 rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
});

test("convertDocument image: child failure and no Python backend both write the image-only bundle", async () => {
 const failed = await convertDocument(imageOpts(), undefined, seamsWith(async () => ({ ok: false, reason: "exit 1" })));
 const none = await convertDocument(imageOpts(), undefined, seamsWith(async () => { throw new Error("no child"); }, { kind: "none", reason: "uv not found" }));
 for (const [r, line] of [[failed, "OCR: unavailable - OCR child failed: exit 1"], [none, "OCR: unavailable - no Python backend"]] as const) {
  assert.match(r.output, /^Type: image   Engine: copy   Tier: image$/m);
  assert.ok(r.output.split("\n").includes(line), r.output);
  const md = readFileSync(r.details.savedTo, "utf8");
  assert.ok(md.includes("![ocr](images/ocr-p1-1.png)"), md);
  assert.ok(readFileSync(join(dirname(r.details.savedTo), "images", "ocr-p1-1.png")).equals(readFileSync(OCR_PNG)));
  rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
 }
});

test("convertDocument image: cancellation aborts the bundle", async () => {
 const out = mkdtempSync(join(tmpdir(), "quiver-img-out-"));
 const ac = new AbortController();
 await assert.rejects(convertDocument(imageOpts({ outputDir: out }), ac.signal, seamsWith(async () => { ac.abort(); return { ok: false, reason: "aborted" }; })), /aborted/);
 assert.ok(!existsSync(join(out, "ocr.md")) && !existsSync(join(out, "ocr.md.lock")));
 rmSync(out, { recursive: true, force: true });
});

test("pages and info reject HTML and images before backend resolution", async () => {
 const noBackend = { backend: async () => { throw Error("backend must not be probed"); } };
 for (const [path, label] of [[HTML_PAGE, "HTML files"], [OCR_PNG, "images"]]) {
  await assert.rejects(convertDocument(resolveOptions({ path, pages: "1" }, {}, {}), undefined, noBackend), new RegExp(`--pages does not apply to ${label}`));
  await assert.rejects(inspectDocument(resolveOptions({ path, info: true }, {}, {}), undefined, noBackend), new RegExp(`info does not apply to ${label}; convert directly`));
 }
});

test("OCR options, published labels, missing source, and details", async () => {
 let seen: Record<string, unknown> = {};
 const ocr: OcrInfo = { ...OCR0, status: "ran", textless: [1], pages: [1] };
 const r = await convertDocument(opts({ ocr: true, ocrLanguage: "deu+eng", primaryTimeoutMs: 12345 }), undefined, seamsWith(async (_mode, co, b) => {
  seen = co; stagePage(b, 1, "page.png");
  return { ok: true, json: { markdown: "![page 1](p1/page.png)\n\n\x00OCR p1/page.png\x00\n>\n> Hello\n\n\x00OCR -\x00\n>\n> Lost\n", pages: [1], pageCount: 6, ocr } };
 }));
 assert.deepEqual([seen.ocr, seen.ocrLanguage, seen.ocrBudgetMs], [true, "deu+eng", 12345]);
 const md = readFileSync(r.details.savedTo, "utf8");
 assert.ok(md.includes("![page 1](images/multipage-p1-1.png)\n\n> Text recognized in images/multipage-p1-1.png (OCR, may contain recognition errors):\n>\n> Hello"), md);
 assert.ok(md.includes("> Text recognized by OCR (source image missing):"));
 assert.ok(!md.includes("\x00"));
 assert.deepEqual(r.details.ocr, ocr);
 assert.match(r.output, /^OCR: 1 page\(s\) \(eng\)$/m);
 rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
});

test("resolveOcrLabels replaces missing and published sources", () => {
 assert.equal(resolveOcrLabels("\x00OCR p2/a.png\x00\n\x00OCR -\x00", new Map([["p2/a.png", "images/a.png"]])), "> Text recognized in images/a.png (OCR, may contain recognition errors):\n> Text recognized by OCR (source image missing):");
});

test("OCR status rows, ranges, empty status and unpdf backend", async () => {
 const cases: [OcrInfo, string | null][] = [
  [{ ...OCR0, textless: [2], tesseract: true }, "OCR: off - 1 page(s) without a text layer; rerun with ocr=true"],
  [{ ...OCR0, textless: [2], tesseract: false }, "OCR: off - 1 page(s) without a text layer; install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true"],
  [{ ...OCR0, status: "unavailable", textless: [2], reason: "Tesseract language data not found" }, "OCR: unavailable - Tesseract language data not found (install Tesseract; see doc/doc-to-md.md)"],
  [{ ...OCR0, status: "ran", textless: [3, 4, 5], budgetStopped: [3, 4, 5] }, "OCR: 0 page(s) (eng); time budget reached for pages=3-5; rerun with pages=3-5 or raise primaryTimeoutMs"],
  [{ ...OCR0, status: "ran", textless: [2], noText: [2], ocrFailed: [4] }, "OCR: 0 page(s) (eng); no text on pages 2; 1 failed and were converted without OCR"],
  [{ ...OCR0, status: "ran" }, null],
 ];
 for (const [ocr, line] of cases) {
  const r = await convertDocument(opts(), undefined, seamsWith(async () => ({ ok: true, json: { markdown: "x\n", pages: [1], pageCount: 6, ocr } })));
  if (line === null) { assert.equal(r.details.ocr, null); assert.ok(!r.output.includes("OCR:")); }
  else { assert.ok(r.output.split("\n").includes(line), r.output); assert.deepEqual(r.details.ocr, ocr); }
  rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
 }
 const none: Backend = { kind: "none", reason: "uv not found" };
 for (const enabled of [true, false]) {
  const r = await convertDocument(opts({ ocr: enabled }), undefined, seamsWith(async () => okTier("text\n", [1]), none));
  assert.equal(r.details.ocr?.reason ?? null, enabled ? "no Python backend" : null);
  assert.equal(r.output.includes("OCR: unavailable - no Python backend"), enabled);
  rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
 }
});

function parseHandle(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) { const m = line.match(/^([A-Za-z-]+): (.*)$/); if (m) out[m[1]] = m[2]; }
	return out;
}

test("convertDocument: primary success -> bundle on disk, handle, separators kept, temp-dir Saved-To", async () => {
	const calls: string[] = [];
	const r = await convertDocument(opts({ pages: "2,5" }), undefined, seamsWith(async (mode) => { calls.push(mode); return okTier("# H\n\ntext\n\n--- end of page.page_number=2 ---\n\nmore\n\n--- end of page.page_number=5 ---\n", [2, 5]); }));
	assert.deepStrictEqual(calls, ["pdf-primary"]);
	const h = parseHandle(r.output);
	assert.ok(h["Saved-To"].includes("pi-quiver-doc-to-md-") && h["Saved-To"].endsWith(`${sep}multipage.md`));
	assert.match(r.output, /^Type: pdf   Engine: pymupdf4llm   Tier: primary$/m);
	assert.match(r.output, /^Page-Count: 6   Pages: 2, 5   Images: 0/m);
	assert.ok(r.output.includes("Outline:\n  L1   p2  # H"), r.output);
	assert.ok(readFileSync(h["Saved-To"], "utf8").includes("--- end of page.page_number=5 ---"));
	assert.ok(!existsSync(`${h["Saved-To"]}.lock`));
	assert.equal(r.details.inputType, "pdf");
	assert.equal(r.details.file, h["Saved-To"]);
	assert.equal(r.details.outputDir, dirname(h["Saved-To"]));
	rmSync(dirname(h["Saved-To"]), { recursive: true, force: true });
});

test("convertDocument: real runCapped fake tier timeout preserves only completed pages for fallback", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		const seenKeep: unknown[] = [];
		const scripts = {
			"pdf-primary": { stageImages: [{ page: 1, files: ["a.png"], done: true }, { page: 2, files: ["b.png"], done: false }], sleepMs: 60_000 },
			"pdf-fallback": { stdout: { markdown: "![](images/multipage-p1-1.png)\\n", pages: [1], pageCount: 6, emptyPages: [], failedPages: [], notes: [] } },
		};
		const r = await convertDocument(opts({ outputDir: out, primaryTimeoutMs: 1500 }), undefined, seamsWith(async (mode, childOptions, _bundle, signal, timeoutMs) => {
			if (mode === "pdf-fallback") seenKeep.push(childOptions.keepPages);
			const capped = await runCapped(process.execPath, [FAKE_TIER, mode], { timeoutMs, capBytes: Number(childOptions.maxOutputBytes), signal, stdin: JSON.stringify({ ...childOptions, script: scripts[mode as keyof typeof scripts] }) });
			if (capped.timedOut) return { ok: false, reason: `timeout after ${timeoutMs}ms` };
			if (capped.capped) return { ok: false, reason: "output exceeded maxOutputBytes" };
			if (capped.code !== 0) return { ok: false, reason: `exit ${capped.code ?? -1}` };
			return { ok: true, json: JSON.parse(capped.stdout) };
		}));
		assert.deepEqual(seenKeep, [{ "1": ["multipage-p1-1.png"] }]);
		assert.ok(existsSync(join(out, "images", "multipage-p1-1.png")));
		assert.ok(!existsSync(join(out, "images", "multipage-p2-1.png")));
		assert.equal(parseHandle(r.output)["Fallback-Reason"], "primary timeout after 1500ms");
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: primary timeout -> fallback with keepPages from .done pages only; degraded header in file and handle", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		const seenKeep: unknown[] = [];
		const r = await convertDocument(opts({ outputDir: out }), undefined, seamsWith(async (mode, o, b) => {
			if (mode === "pdf-primary") {
				mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "a.png"), "1"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
				mkdirSync(join(b.stagingDir, "p2")); writeFileSync(join(b.stagingDir, "p2", "b.png"), "1");
				return { ok: false, reason: "timeout after 1ms" };
			}
			seenKeep.push((o as { keepPages: unknown }).keepPages);
			return okTier("![](images/multipage-p1-1.png)\n\n--- end of page.page_number=1 ---\n", [1, 2, 3, 4, 5, 6]);
		}));
		assert.deepStrictEqual(seenKeep, [{ "1": ["multipage-p1-1.png"] }]);
		assert.ok(existsSync(join(out, "images", "multipage-p1-1.png")) && !existsSync(join(out, "images", "multipage-p2-1.png")));
		const h = parseHandle(r.output);
		assert.strictEqual(h["Fallback-Reason"], "primary timeout after 1ms");
		assert.strictEqual(h["Degraded"], "PyMuPDF text extraction - layout/tables not preserved");
		assert.match(r.output, /Engine: pymupdf-text   Tier: fallback/);
		assert.ok(readFileSync(join(out, "multipage.md"), "utf8").startsWith("Degraded: PyMuPDF text extraction - layout/tables not preserved\nFallback-Reason: primary timeout after 1ms\n"));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: exit 3 -> no fallback, error verbatim", async () => {
	const calls: string[] = [];
	await assert.rejects(convertDocument(opts({ pages: "9" }), undefined, seamsWith(async (mode) => { calls.push(mode); return { ok: false, userError: "pages out of range: 9 (document has 6 pages)", pageCount: 6 }; })), /pages out of range: 9 \(document has 6 pages\)/);
	assert.deepStrictEqual(calls, ["pdf-primary"]);
});

test("convertDocument: capped primary falls back with reason; capped fallback is a hard error with both reasons and cleanup", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		const r = await convertDocument(opts({ outputDir: out }), undefined, seamsWith(async (mode) => mode === "pdf-primary" ? { ok: false, reason: "output exceeded maxOutputBytes" } : okTier("t\n\n--- end of page.page_number=1 ---\n", [1])));
		assert.strictEqual(parseHandle(r.output)["Fallback-Reason"], "primary output exceeded maxOutputBytes");
		rmSync(join(out, "multipage.md"));
		await assert.rejects(convertDocument(opts({ outputDir: out }), undefined, seamsWith(async () => ({ ok: false, reason: "timeout after 5ms" }))), /Conversion failed: primary timeout after 5ms; fallback timeout after 5ms/);
		assert.ok(!existsSync(join(out, "multipage.md.lock")) && !existsSync(join(out, "multipage.md")));
		assert.deepStrictEqual(readdirSync(join(out, "images")), []);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: capped fallback is a hard error with both reasons and releases the lock", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		await assert.rejects(
			convertDocument(opts({ outputDir: out }), undefined, seamsWith(async (mode) => mode === "pdf-primary" ? { ok: false, reason: "exit 1" } : { ok: false, reason: "output exceeded maxOutputBytes" })),
			/Conversion failed: primary exit 1; fallback output exceeded maxOutputBytes/,
		);
		assert.ok(!existsSync(join(out, "multipage.md.lock")));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: exit failures keep diagnostics out of Fallback-Reason and in hard errors", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		const failed = { ok: false as const, reason: "exit 1", detail: "boom" };
		const recovered = await convertDocument(opts({ outputDir: out }), undefined, seamsWith(async (mode) => mode === "pdf-primary" ? failed : okTier("text", [1])));
		assert.equal(parseHandle(recovered.output)["Fallback-Reason"], "primary exit 1");
		rmSync(join(out, "multipage.md"));
		await assert.rejects(convertDocument(opts({ outputDir: out }), undefined, seamsWith(async () => failed)), /Conversion failed: primary exit 1; fallback exit 1 \(boom\)/);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: missing Python executable maps spawn failures to exit -1 and releases the bundle lock", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		await assert.rejects(
			convertDocument(opts({ outputDir: out, primaryTimeoutMs: 5000, fallbackTimeoutMs: 5000 }), undefined, {
				backend: async () => ({ kind: "python", exe: "/nonexistent/python-binary", pdf: true, xlsx: true, docx: true, email: true }),
			}),
			/Conversion failed: primary exit -1; fallback exit -1/,
		);
		assert.ok(!existsSync(join(out, "multipage.md.lock")));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: abort signal -> tree killed, cleanup, lock released", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		const ac = new AbortController();
		const p = convertDocument(opts({ outputDir: out }), ac.signal, seamsWith(async (_m, _o, _b, signal) => new Promise((res) => signal?.addEventListener("abort", () => res({ ok: false, reason: "aborted" })))));
		setTimeout(() => ac.abort(), 50);
		await assert.rejects(p, /aborted/);
		assert.ok(!existsSync(join(out, "multipage.md.lock")));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: no Python backend -> unpdf worker, pages honoured, notes, Degraded line", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-conv-"));
	try {
		const r = await convertDocument(opts({ outputDir: out, pages: "2,5" }), undefined, { backend: async () => ({ kind: "none", reason: "uv not found" }) });
		const md = readFileSync(join(out, "multipage.md"), "utf8");
		assert.ok(md.includes("PAGE-2") && md.includes("PAGE-5") && !md.includes("PAGE-3"));
		assert.ok(md.includes("--- end of page.page_number=2 ---") && md.includes("--- end of page.page_number=5 ---"));
		const h = parseHandle(r.output);
		assert.strictEqual(h["Notes"], "No images: unpdf backend");
		assert.strictEqual(h["Degraded"], "unpdf text extraction - structure not preserved");
		assert.match(r.output, /Engine: unpdf   Tier: unpdf/);
		assert.match(r.output, /Page-Count: 6   Pages: 2, 5/);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument: unpdf out of range -> page-count error; pages on xlsx rejected in Node", async () => {
	await assert.rejects(convertDocument(opts({ pages: "99" }), undefined, { backend: async () => ({ kind: "none", reason: "x" }) }), /pages out of range: 99 \(document has 6 pages\)/);
	const xl = fileURLToPath(new URL("../test/fixtures/workbook.xlsx", import.meta.url));
	await assert.rejects(convertDocument(resolveOptions({ path: xl, pages: "1" }, {}, {}), undefined, seamsWith(async () => okTier("", []))), /worksheets have no stable page numbering/);
});

test("convertDocument: xlsx tier only gives timeout/output-cap remedy for those failures", async () => {
	const xl = fileURLToPath(new URL("../test/fixtures/workbook.xlsx", import.meta.url));
	const nonzero = convertDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => ({ ok: false, reason: "exit 1", detail: "boom" })));
	await assert.rejects(nonzero, (error: Error) => {
		assert.match(error.message, /^Excel conversion failed: exit 1 \(boom\)$/);
		assert.ok(!error.message.includes("Remedy: raise excelTimeoutMs"));
		return true;
	});
	await assert.rejects(convertDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => ({ ok: false, reason: "timeout after 1ms" }))), /Excel conversion failed: timeout after 1ms\. Remedy: raise excelTimeoutMs/);
});

test("convertDocument: xlsx with python backend lacking XLSX -> remedy; no backend -> remedy", async () => {
	const xl = fileURLToPath(new URL("../test/fixtures/workbook.xlsx", import.meta.url));
	await assert.rejects(convertDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => okTier("", []), { kind: "python", exe: "python3", pdf: true, xlsx: false, docx: false, email: false })), /Remedy: install uv, or pip install openpyxl xlrd pillow/);
	await assert.rejects(convertDocument(resolveOptions({ path: xl }, {}, {}), undefined, { backend: async () => ({ kind: "none", reason: "x" }) }), /Remedy: install uv, or pip install openpyxl xlrd pillow/);
});

test("inspectDocument: no backend -> unpdf info handle", async () => {
	const r = await inspectDocument(opts({ info: true }), undefined, { backend: async () => ({ kind: "none", reason: "x" }) });
	assert.match(r.output, /^Type: pdf   Page-Count: 6   Backend: none$/m);
	assert.match(r.output, /Title: Multipage Fixture/);
});

test("inspectDocument: hard errors include tier diagnostic detail", async () => {
	await assert.rejects(inspectDocument(opts({ info: true }), undefined, seamsWith(async () => ({ ok: false, reason: "exit 1", detail: "boom" }))), /Inspection failed: exit 1 \(boom\)/);
});

test("inspectDocument: xlsx tier only gives timeout/output-cap remedy for those failures", async () => {
	const xl = fileURLToPath(new URL("../test/fixtures/workbook.xlsx", import.meta.url));
	for (const reason of ["timeout after 1ms", "output exceeded maxOutputBytes"]) {
		await assert.rejects(
			inspectDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => ({ ok: false, reason }))),
			new RegExp(`Excel inspection failed: ${reason}\\. Remedy: raise excelTimeoutMs`),
		);
	}
	const nonzero = inspectDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => ({ ok: false, reason: "exit 1" })));
	await assert.rejects(nonzero, (error: Error) => {
		assert.match(error.message, /^Inspection failed: exit 1$/);
		assert.ok(!error.message.includes("Remedy: raise excelTimeoutMs"));
		return true;
	});
});

test("inspectDocument: python info via seam -> TOC rendered", async () => {
	const r = await inspectDocument(opts({ info: true }), undefined, seamsWith(async () => ({ ok: true, json: { pageCount: 6, metadata: { title: "T" }, toc: [[1, "Chapter 1", 1]] } })));
	assert.ok(r.output.includes("TOC:\n  L1 Chapter 1 (p1)"));
});

test("soffArgs: default pdf filter and explicit Calc filter", () => {
	assert.ok(soffArgs("/in/a.docx", "/prof", "/out").includes("pdf"));
	const a = soffArgs("/in/a.xlsx", "/prof", "/out", EXCEL_PDF_FILTER);
	assert.equal(a[a.indexOf("--convert-to") + 1], EXCEL_PDF_FILTER);
});

test("tryConvertOffice: failures are results with officeFailure messages", async () => {
	const docx = join(process.cwd(), "test/fixtures/sample.docx");
	const mk = (r: Partial<{ code: number | null; timedOut: boolean }>) => async () => ({ code: 0, timedOut: false, capped: false, stdout: "", stderr: "boom", ...r });
	assert.deepStrictEqual(await tryConvertOffice(1000, docx, undefined, mk({ code: null })), { ok: false, kind: "missing", code: null, timedOut: false, stderr: "boom" });
	assert.equal((await tryConvertOffice(1000, docx, undefined, mk({ timedOut: true, code: null })) as { kind: string }).kind, "timeout");
	assert.equal((await tryConvertOffice(1000, docx, undefined, mk({ code: 7 })) as { kind: string }).kind, "exit");
	assert.equal((await tryConvertOffice(1000, docx, undefined, mk({})) as { kind: string }).kind, "no-pdf");
	for (const [input, expected] of [[{ code: null }, /was not found on PATH/], [{ code: 7 }, /soffice failed \(code=7 timedOut=false\): boom/], [{}, /produced no usable PDF/]] as const) {
		const result = await tryConvertOffice(1000, docx, undefined, mk(input));
		if (!result.ok) assert.match(officeFailure(result).message, expected);
		else assert.fail("expected office failure");
	}
});

test("reconcileRenderMarkers: resolves by index and rejects leftovers", () => {
	const md = "| <!--rvs:0--> | <!--rvs:3--> |\n<!--rv:0-->\n<!--rv:3-->\n";
	const out = reconcileRenderMarkers(md, [0, 3], "png", new Map([["s0.png", "images/b-s0.png"]]), (idx) => idx === 3 ? "degenerate" : "n/a");
	assert.equal(out, "| yes | no |\nRendered view: ![Rendered view of sheet 0](s0.png)\nRendered view: unavailable (degenerate)\n");
	assert.throws(() => reconcileRenderMarkers("<!--rv:1-->", [0], "png", new Map(), () => "x"), /internal: unresolved render marker/);
});

const XL = fileURLToPath(new URL("../test/fixtures/workbook.xlsx", import.meta.url));
const xlMd = "# workbook\n\n## Sheets\n| # | name | kind | size | hidden | charts | images | rendered | data |\n|---|---|---|---|---|---|---|---|---|\n| 0 | Data | worksheet | 2 x 1 | no | 0 | 1 | <!--rvs:0--> | [sheets/s0-data.csv](sheets/s0-data.csv) |\n| 1 | T | chartsheet | - | no | 1 | 0 | <!--rvs:1--> | - |\n\n## Data\n![image](s0-1.png)\n<!--rv:0-->\n\n## T (chartsheet)\n<!--rv:1-->\n";
const xlJson = (): TierResult => ({ ok: true, json: { markdown: xlMd, notes: [], renderPages: [0, 1], sheetCount: 2 } });
function stageXl(bundle: { stagingDir: string }, childOptions: Record<string, unknown>) {
	writeFileSync(join(bundle.stagingDir, "s0-1.png"), "i");
	mkdirSync(String(childOptions.sheetsStagingDir), { recursive: true });
	writeFileSync(join(String(childOptions.sheetsStagingDir), "s0-data.csv"), "a\r\nb\r\n");
}
const fakeOffice = (result: Awaited<ReturnType<typeof tryConvertOffice>>): PipelineSeams["office"] => async () => result;
const DOCX = fileURLToPath(new URL("../test/fixtures/multipage.docx", import.meta.url));
const PPTX = fileURLToPath(new URL("../test/fixtures/multislide.pptx", import.meta.url));
const docxOpts = (extra: Record<string, unknown> = {}) => resolveOptions({ path: DOCX, ...extra } as never, {}, {});
const UV: Backend = { kind: "uv", pdf: true, xlsx: true, docx: true, email: true };
const PY_NO_DOCX: Backend = { kind: "python", exe: "python3", pdf: true, xlsx: true, docx: false, email: false };
const htmlFx = (n: string) => fileURLToPath(new URL(`../test/fixtures/html/${n}`, import.meta.url));
const htmlOpts = (n: string, extra: Record<string, unknown> = {}) => resolveOptions({ path: htmlFx(n), ...extra } as never, {}, {});

test("prepareHtml stages images and decodes legacy and UTF-8 input", async () => {
 const s = mkdtempSync(join(tmpdir(), "quiver-html-"));
 try {
  const p = await prepareHtml(HTML_PAGE, join(s, "page"));
  assert.equal(p.missing, 1);
  assert.match(p.html, /src="p1\/1.png"/);
  assert.match(p.html, /src="p1\/2.png"/);
  assert.match(p.html, /<a href="https:\/\/example.com\/remote.png">remote figure<\/a>/);
  assert.ok(p.html.includes("missing figure") && !p.html.includes("missing.png"));
  assert.ok(!/<script|<style|<head|<title/i.test(p.html));
  assert.deepEqual(readdirSync(join(s, "page", "p1")).sort(), [".done", "1.png", "2.png"]);
  assert.ok(readFileSync(join(s, "page", "p1", "1.png")).equals(readFileSync(htmlFx("page_files/fig.png"))));
  assert.match((await prepareHtml(htmlFx("title-only.html"), join(s, "title"))).html, /<body><h1>Only a title<\/h1>/);
  assert.equal((p.html.match(/<h1>/g) ?? []).length, 1);
  assert.ok((await prepareHtml(htmlFx("cp1250.html"), join(s, "legacy"))).html.includes("Zażółć gęślą jaźń"));
  assert.ok(p.html.includes("Żółw"));
  const extra = join(s, "extra.html");
  writeFileSync(extra, '<img src="data:image/png;base64,AAAA" alt="bad image"><img src="//cdn.example.com/x.png" alt="remote image">');
  const prepared = await prepareHtml(extra, join(s, "extra"));
  assert.equal(prepared.missing, 1);
  assert.match(prepared.html, /bad image/);
  assert.match(prepared.html, /<a href="https:\/\/cdn.example.com\/x.png">remote image<\/a>/);
  assert.deepEqual(readdirSync(join(s, "extra", "p1")), [".done"]);
 } finally { rmSync(s, { recursive: true, force: true }); }
});

test("HTML markdownify publishes images and keeps missing-image note", async () => {
 let got = "";
 const r = await convertDocument(htmlOpts("page.html"), undefined, seamsWith(async (mode, co) => {
  assert.equal(mode, "html"); got = String(co.html);
  return { ok: true, json: { markdown: "# Garden notes\n\n![local figure](p1/1.png) ![inline figure](p1/2.png)\n", engine: "markdownify", notes: [] } };
 }));
 try {
  assert.ok(got.includes('src="p1/1.png"'));
  assert.match(r.output, /Engine: markdownify   Tier: html/);
  assert.doesNotMatch(r.output, /Degraded:|Fallback-Reason:/);
  assert.match(r.output, /1 image\(s\) not found; replaced with alt text/);
  const md = readFileSync(r.details.savedTo, "utf8");
  assert.ok(md.includes("![local figure](images/page-p1-1.png)") && md.includes("![inline figure](images/page-p1-2.png)"), md);
 } finally { rmSync(dirname(r.details.savedTo), { recursive: true, force: true }); }
});

test("HTML Turndown fallback retains nav and footer without Readability", async () => {
 const r = await convertDocument(htmlOpts("page.html"), undefined, seamsWith(async (mode) => { throw Error(`unexpected ${mode}`); }, PY_NO_DOCX));
 try {
  assert.match(r.output, /Engine: turndown   Tier: html/);
  assert.ok(r.output.includes(`Degraded: ${DEGRADED_HTML_TURNDOWN}`));
  assert.ok(!r.output.includes("Fallback-Reason:"));
  const md = readFileSync(r.details.savedTo, "utf8");
  assert.ok(md.includes("NAV-TEXT") && md.includes("FOOTER-TEXT") && md.includes("![local figure](images/page-p1-1.png)"), md);
 } finally { rmSync(dirname(r.details.savedTo), { recursive: true, force: true }); }
});

test("HTML child timeout falls back but cancellation aborts", async () => {
 const r = await convertDocument(htmlOpts("page.html"), undefined, seamsWith(async () => ({ ok: false, reason: "timeout after 60000ms" })));
 assert.match(r.output, /^Fallback-Reason: html timeout after 60000ms$/m);
 assert.match(r.output, /Engine: turndown   Tier: html/);
 assert.ok(r.output.includes(`Degraded: ${DEGRADED_HTML_TURNDOWN}`));
 rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
 const out = mkdtempSync(join(tmpdir(), "quiver-html-out-"));
 try {
  const ac = new AbortController();
  await assert.rejects(convertDocument(htmlOpts("page.html", { outputDir: out }), ac.signal, seamsWith(async () => { ac.abort(); return { ok: false, reason: "aborted" }; })), /aborted/);
  assert.ok(!existsSync(join(out, "page.md")) && !existsSync(join(out, "page.md.lock")));
 } finally { rmSync(out, { recursive: true, force: true }); }
});
test("HTML abort after preparation releases the bundle before running a tier", async () => {
 const out = mkdtempSync(join(tmpdir(), "quiver-html-abort-"));
 try {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(convertDocument(htmlOpts("page.html", { outputDir: out }), ac.signal,
   seamsWith(async () => { throw Error("runTier must not be called"); })), /aborted/);
  assert.ok(!existsSync(join(out, "page.md")) && !existsSync(join(out, "page.md.lock")));
 } finally { rmSync(out, { recursive: true, force: true }); }
});
test("HTML keeps image syntax in page text with either engine", async () => {
 const dir = mkdtempSync(join(tmpdir(), "quiver-html-text-"));
 const path = join(dir, "literal.html");
 writeFileSync(path, '<pre><code>&lt;img src="images/logo.png"&gt; and ![](images/logo.png)</code></pre>');
 try {
  for (const backend of [UV, PY_NO_DOCX]) {
   const r = await convertDocument(resolveOptions({ path, outputDir: join(dir, backend.docx ? "markdownify" : "turndown") } as never, {}, {}), undefined,
    seamsWith(async () => ({ ok: true, json: { markdown: '<img src="images/logo.png"> and ![](images/logo.png)\n' } }), backend));
   const md = readFileSync(r.details.savedTo, "utf8");
   assert.match(md, /!\[\]\(images\/logo.png\)/);
   assert.match(md, /<img src="images\/logo.png">|&lt;img src="images\/logo.png"&gt;/);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTML rejects unstaged ./p1 image references", async () => {
 const out = mkdtempSync(join(tmpdir(), "quiver-html-invalid-"));
 try {
  await assert.rejects(convertDocument(htmlOpts("page.html", { outputDir: out }), undefined,
   seamsWith(async () => ({ ok: true, json: { markdown: "![x](./p1/9.png)" } }))), /unexpected image reference in output/);
 } finally { rmSync(out, { recursive: true, force: true }); }
});

test("non-HTML conversion still rejects unexpected image references", async () => {
 await assert.rejects(convertDocument(resolveOptions({ path: MULTIPAGE } as never, {}, {}), undefined,
  seamsWith(async () => ({ ok: true, json: { markdown: "![logo](x.png)" } }))), /unexpected image reference in output: x.png/);
});

const MISSING = { ok: false as const, kind: "missing" as const, code: null, timedOut: false, stderr: "" };
const okDocx = (markdown: string, extra: Record<string, unknown> = {}): TierResult => ({ ok: true, json: { markdown, pages: [1, 2], pageCount: 2, explicitBreaks: 1, engine: "mammoth", degraded: false, fallbackReason: null, ...extra } });

test("DOCX direct conversion publishes images and reports child fallback", async () => {
 const out = mkdtempSync(join(tmpdir(), "quiver-docx-"));
 try {
  const modes: string[] = [];
  const r = await convertDocument(docxOpts({ outputDir: out }), undefined, { backend: async () => UV, office: async () => { throw Error("office called"); }, runTier: async (mode, _o, b) => {
   modes.push(mode); mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "img.png"), "1"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
   return okDocx("# A\n\n![](p1/img.png)\n\n--- end of page.page_number=1 ---\n", { engine: "python-docx", degraded: true, fallbackReason: "mammoth boom" });
  } });
  assert.deepEqual(modes, ["docx"]); assert.equal(r.details.explicitBreaks, 1);
  assert.match(r.output, /Engine: python-docx   Tier: docx/); assert.match(r.output, /Page-Count: 2 \(explicit page breaks, not printed pages\)/);
  assert.equal(parseHandle(r.output)["Fallback-Reason"], "mammoth boom");
  assert.equal(parseHandle(r.output)["Degraded"], "python-docx text extraction - footnotes, hyperlinks, images not preserved");
  assert.ok(existsSync(join(out, "images", "multipage-p1-1.png")));
 } finally { rmSync(out, { recursive: true, force: true }); }
});

test("DOCX exit 1 clears staging and uses office; user errors and timeouts never retry", async () => {
 const out = mkdtempSync(join(tmpdir(), "quiver-docx-"));
 try {
  let staging = ""; let officeCalls = 0; const modes: string[] = [];
  const r = await convertDocument(docxOpts({ outputDir: out }), undefined, { backend: async () => UV, office: async () => { officeCalls++; assert.deepEqual(readdirSync(staging), []); return { ok: true, pdfPath: MULTIPAGE, cleanup: () => {} }; }, runTier: async (mode, _o, b) => { modes.push(mode); staging = b.stagingDir; if (mode === "docx") { writeFileSync(join(staging, "partial"), "x"); return { ok: false, reason: "exit 1", detail: "both failed" }; } return okTier("text", [1]); } });
  assert.deepEqual(modes, ["docx", "pdf-primary"]); assert.equal(officeCalls, 1);
  assert.equal(parseHandle(r.output)["Fallback-Reason"], "docx exit 1 (both failed)");
  assert.equal(parseHandle(r.output)["Degraded"], "LibreOffice PDF route - heading styles and explicit page breaks not preserved; page numbers are LibreOffice pagination");
  assert.match(r.output, /^Page-Count: 6 \(LibreOffice pagination\)/m);
  for (const fail of [{ ok: false as const, userError: "bad pages" }, { ok: false as const, reason: "timeout after 5ms" }]) {
   await assert.rejects(convertDocument(docxOpts(), undefined, { backend: async () => UV, office: async () => { officeCalls++; return { ok: true, pdfPath: MULTIPAGE, cleanup: () => {} }; }, runTier: async () => fail }), fail && "userError" in fail ? /bad pages/ : /Conversion failed: docx timeout after 5ms/);
  }
  assert.equal(officeCalls, 1);
 } finally { rmSync(out, { recursive: true, force: true }); }
});

test("DOCX missing backend uses office, but missing office or failed child gives targeted errors", async () => {
 const out = mkdtempSync(join(tmpdir(), "quiver-docx-"));
 try {
  const modes: string[] = [];
  const r = await convertDocument(docxOpts({ outputDir: out }), undefined, { backend: async () => PY_NO_DOCX, office: fakeOffice({ ok: true, pdfPath: MULTIPAGE, cleanup: () => {} }), runTier: async (mode) => { modes.push(mode); return okTier("text", [1]); } });
  assert.deepEqual(modes, ["pdf-primary"]); assert.equal(parseHandle(r.output)["Fallback-Reason"], "python backend lacks DOCX packages");
  assert.equal(parseHandle(r.output)["Degraded"], "LibreOffice PDF route - heading styles and explicit page breaks not preserved; page numbers are LibreOffice pagination");
  await assert.rejects(convertDocument(docxOpts(), undefined, { backend: async () => UV, office: fakeOffice(MISSING), runTier: async () => ({ ok: false, reason: "exit 1", detail: "mammoth failed; python-docx failed" }) }), /Conversion failed: docx exit 1 \(mammoth failed; python-docx failed\); LibreOffice \(soffice\) not found on PATH/);
  await assert.rejects(convertDocument(docxOpts(), undefined, { backend: async () => UV, office: async () => { throw Error("office called"); }, runTier: async () => ({ ok: false, reason: "invalid-json" }) }), /Conversion failed: docx invalid-json/);
 } finally { rmSync(out, { recursive: true, force: true }); }
});

test("DOCX child exit retains its reason when pages or office PDF production fails", async () => {
	const child = async (): Promise<TierResult> => ({ ok: false, reason: "exit 1", detail: "mammoth failed; python-docx failed" });
	await assert.rejects(convertDocument(docxOpts({ pages: "1" }), undefined, { backend: async () => UV, office: async () => { throw Error("office called"); }, runTier: child }), /docx exit 1 \(mammoth failed; python-docx failed\)/);
	await assert.rejects(convertDocument(docxOpts(), undefined, { backend: async () => UV, office: fakeOffice({ ok: false, kind: "no-pdf", code: 0, timedOut: false, stderr: "" }), runTier: child }), (error: Error) => {
		assert.match(error.message, /docx exit 1 \(mammoth failed; python-docx failed\)/);
		assert.match(error.message, /LibreOffice \(soffice\) ran but produced no usable PDF/);
		return true;
	});
});

test("DOCX and PPTX prerequisite errors and DOCX info stay on seams", async () => {
 await assert.rejects(convertDocument(docxOpts(), undefined, { backend: async () => PY_NO_DOCX, office: fakeOffice(MISSING) }), /DOCX conversion needs the Python DOCX packages or LibreOffice.*found without mammoth\/markdownify\/python-docx/);
 let officeCalls = 0;
 await assert.rejects(convertDocument(docxOpts({ pages: "2" }), undefined, { backend: async () => PY_NO_DOCX, office: async () => { officeCalls++; return MISSING; } }), /--pages on a DOCX needs the Python DOCX backend/);
 assert.equal(officeCalls, 0);
 await assert.rejects(convertDocument(resolveOptions({ path: PPTX } as never, {}, {}), undefined, { backend: async () => UV, office: fakeOffice(MISSING) }), /PPTX conversion needs LibreOffice.*Python backend: available/);
 const r = await inspectDocument(docxOpts({ info: true }), undefined, { backend: async () => UV, office: async () => { throw Error("office called"); }, runTier: async (mode) => { assert.equal(mode, "info"); return { ok: true, json: { pageCount: 1, metadata: { title: "T" }, toc: [[1, "Intro", null]] } }; } });
 assert.match(r.output, /L1 Intro \(p\?\)/);
 let inspectOfficeCalls = 0;
 await assert.rejects(inspectDocument(docxOpts({ info: true }), undefined, { backend: async () => PY_NO_DOCX, office: async () => { inspectOfficeCalls++; return MISSING; } }), /DOCX inspection needs the Python DOCX packages/);
 assert.equal(inspectOfficeCalls, 0);
});

test("convertDocument xlsx: rendered views and CSV are published into manifests and handle", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-xl-"));
	try {
		const pdf = join(out, "fake.pdf"); writeFileSync(pdf, "%PDF");
		const modes: string[] = [];
		const r = await convertDocument(resolveOptions({ path: XL, outputDir: out }, {}, {}), undefined, {
			...seamsWith(async (mode, childOptions, bundle) => {
				modes.push(mode);
				if (mode === "xlsx") { stageXl(bundle, childOptions); return xlJson(); }
				assert.equal(childOptions.path, pdf);
				assert.deepStrictEqual(childOptions.sheetIndices, [0, 1]);
				assert.equal(childOptions.expectedPages, 2);
				writeFileSync(join(bundle.stagingDir, "s0.png"), "r0");
				writeFileSync(join(bundle.stagingDir, "s1.png"), "r1");
				return { ok: true, json: { ok: true, rendered: [{ idx: 0, file: "s0.png", dpi: 120 }, { idx: 1, file: "s1.png", dpi: 120 }], failed: [] } };
			}),
			office: fakeOffice({ ok: true, pdfPath: pdf, cleanup: () => {} }),
		});
		assert.deepStrictEqual(modes, ["xlsx", "render-pages"]);
		const md = readFileSync(join(out, "workbook.md"), "utf8");
		assert.ok(md.includes("| 0 | Data | worksheet | 2 x 1 | no | 0 | 1 | yes | [sheets/workbook-s0-data.csv](sheets/workbook-s0-data.csv) |"));
		assert.ok(md.includes("| 1 | T | chartsheet | - | no | 1 | 0 | yes | - |"));
		assert.ok(md.includes("Rendered view: ![Rendered view of sheet 0](images/workbook-s0.png)"));
		assert.ok(md.includes("Rendered view: ![Rendered view of sheet 1](images/workbook-s1.png)"));
		assert.ok(existsSync(join(out, "images", "workbook-s0.png")));
		assert.ok(existsSync(join(out, "images", "workbook-s1.png")));
		assert.ok(existsSync(join(out, "sheets", "workbook-s0-data.csv")));
		assert.match(r.output, /^Sheets-Dir: .*sheets$/m);
		assert.match(r.output, /^Images-Dir: .*images$/m);
		assert.match(r.output, /\bImages: 3\b/);
		assert.equal(r.details.sheetsDir, join(out, "sheets"));
		assert.equal(r.details.imagesDir, join(out, "images"));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument xlsx: partial render failure publishes one view and degrades one", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-xl-"));
	try {
		const pdf = join(out, "fake.pdf"); writeFileSync(pdf, "%PDF");
		const r = await convertDocument(resolveOptions({ path: XL, outputDir: out }, {}, {}), undefined, {
			...seamsWith(async (mode, childOptions, bundle) => {
				if (mode === "xlsx") { stageXl(bundle, childOptions); return xlJson(); }
				writeFileSync(join(bundle.stagingDir, "s0.png"), "r");
				return { ok: true, json: { ok: true, rendered: [{ idx: 0, file: "s0.png", dpi: 120 }], failed: [{ idx: 1, reason: "rendered view degenerate (page 1 x 1 pt)" }] } };
			}),
			office: fakeOffice({ ok: true, pdfPath: pdf, cleanup: () => {} }),
		});
		const md = readFileSync(join(out, "workbook.md"), "utf8");
		assert.ok(md.includes("| 0 | Data | worksheet | 2 x 1 | no | 0 | 1 | yes |"));
		assert.ok(md.includes("| 1 | T | chartsheet | - | no | 1 | 0 | no |"));
		assert.ok(md.includes("Rendered view: ![Rendered view of sheet 0](images/workbook-s0.png)"));
		assert.ok(md.includes("Rendered view: unavailable (rendered view degenerate (page 1 x 1 pt))"));
		assert.ok(r.output.includes("Rendered views: 1 of 2 unavailable"));
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("convertDocument xlsx: missing or timed-out soffice degrades and releases lock", async () => {
	const cases: Array<{ office: Awaited<ReturnType<typeof tryConvertOffice>>; reason: string }> = [
		{ office: { ok: false, kind: "missing", code: null, timedOut: false, stderr: "" }, reason: "LibreOffice not found" },
		{ office: { ok: false, kind: "timeout", code: null, timedOut: true, stderr: "" }, reason: "soffice failed: timeout after 120000ms" },
	];
	for (const c of cases) {
		const out = mkdtempSync(join(tmpdir(), "quiver-xl-"));
		try {
			const r = await convertDocument(resolveOptions({ path: XL, outputDir: out }, {}, {}), undefined, {
				...seamsWith(async (mode, childOptions, bundle) => {
					assert.equal(mode, "xlsx");
					stageXl(bundle, childOptions);
					return xlJson();
				}),
				office: fakeOffice(c.office),
			});
			const md = readFileSync(join(out, "workbook.md"), "utf8");
			assert.equal((md.match(new RegExp(`Rendered view: unavailable \\(${c.reason.replace(/[()]/g, "\\$&")}\\)`, "g")) ?? []).length, 2, c.reason);
			assert.ok(md.includes("| 0 | Data | worksheet | 2 x 1 | no | 0 | 1 | no |"), c.reason);
			assert.ok(md.includes("| 1 | T | chartsheet | - | no | 1 | 0 | no |"), c.reason);
			assert.ok(r.output.includes(`Rendered views skipped: ${c.reason}`), c.reason);
			assert.ok(!existsSync(join(out, "workbook.md.lock")), c.reason);
		} finally { rmSync(out, { recursive: true, force: true }); }
	}
});

test("convertDocument xlsx: page-count mismatch and render child failure degrade without failing", async () => {
	const cases: TierResult[] = [
		{ ok: true, json: { ok: false, reason: "page-count mismatch (5 vs 2)" } },
		{ ok: false, reason: "timeout after 30000ms" },
	];
	for (const render of cases) {
		const reason = render.ok ? "page-count mismatch (5 vs 2)" : "render failed: timeout after 30000ms";
		const out = mkdtempSync(join(tmpdir(), "quiver-xl-"));
		try {
			const r = await convertDocument(resolveOptions({ path: XL, outputDir: out }, {}, {}), undefined, {
				...seamsWith(async (mode, childOptions, bundle) => {
					if (mode === "xlsx") { stageXl(bundle, childOptions); return xlJson(); }
					writeFileSync(join(bundle.stagingDir, "s0.png"), "partial");
					return render;
				}),
				office: fakeOffice({ ok: true, pdfPath: "/nonexistent.pdf", cleanup: () => {} }),
			});
			const md = readFileSync(join(out, "workbook.md"), "utf8");
			assert.equal((md.match(new RegExp(`Rendered view: unavailable \\(${reason.replace(/[()]/g, "\\$&")}\\)`, "g")) ?? []).length, 2);
			assert.ok(md.includes("| 0 | Data | worksheet | 2 x 1 | no | 0 | 1 | no |"));
			assert.ok(md.includes("| 1 | T | chartsheet | - | no | 1 | 0 | no |"));
			assert.equal(existsSync(join(out, "images/workbook-s0.png")), false);
			assert.ok(r.output.includes(`Rendered views skipped: ${reason}`));
		} finally { rmSync(out, { recursive: true, force: true }); }
	}
});

test("empty file: convert and info fail before backend resolution, for every type", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-empty-"));
	try {
		let backendCalls = 0;
		const seams: Partial<PipelineSeams> = { backend: async () => { backendCalls++; return UV; }, runTier: async () => { throw Error("must not run"); } };
		for (const ext of ["pdf", "docx", "doc", "pptx", "xlsx", "xlsm", "xls", "msg", "eml", "html", "png"]) {
			const p = join(dir, `empty.${ext}`); writeFileSync(p, "");
			await assert.rejects(convertDocument(resolveOptions({ path: p } as never, {}, {}), undefined, seams), new RegExp(`^Error: empty file: .*empty\\.${ext}$`));
		}
		await assert.rejects(inspectDocument(resolveOptions({ path: join(dir, "empty.pdf"), info: true } as never, {}, {}), undefined, seams), /^Error: empty file: /);
		assert.equal(backendCalls, 0);
		assert.ok(!existsSync(join(dir, "empty.md")) && !existsSync(join(dir, "images")));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("xlsm routes through Excel tier; published CSV and macro note", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-xlsm-"));
	try {
		const path = fileURLToPath(new URL("../test/fixtures/macros.xlsm", import.meta.url));
		const r = await convertDocument(resolveOptions({ path, outputDir: out } as never, {}, {}), undefined, seamsWith(async (mode, co) => {
			assert.equal(mode, "xlsx"); mkdirSync(String(co.sheetsStagingDir), { recursive: true }); writeFileSync(join(String(co.sheetsStagingDir), "s0-tall.csv"), "x\n");
			return { ok: true, json: { markdown: "[data](sheets/s0-tall.csv)\n", notes: ["macros ignored (VBA project not converted)"] } };
		}));
		assert.match(r.output, /Type: xlsm   Engine: openpyxl/);
		assert.match(r.output, /Notes: macros ignored \(VBA project not converted\)/);
		assert.match(readFileSync(r.details.savedTo, "utf8"), /sheets\/macros-s0-tall.csv/);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("Excel truncated-preview note uses published CSV name", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-tall-"));
	try {
		const path = fileURLToPath(new URL("../test/fixtures/tall.xlsx", import.meta.url));
		const r = await convertDocument(resolveOptions({ path, outputDir: out } as never, {}, {}), undefined, seamsWith(async (_mode, co) => {
			mkdirSync(String(co.sheetsStagingDir), { recursive: true }); writeFileSync(join(String(co.sheetsStagingDir), "s0-tall.csv"), "x\n");
			return { ok: true, json: { markdown: "# Tall\n", notes: ["preview truncated: Tall (100 of 150 rows); full data: sheets/s0-tall.csv"] } };
		}));
		assert.match(r.output, /Notes: preview truncated: Tall \(100 of 150 rows\); full data: sheets\/tall-s0-tall.csv/);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("renamed Excel bundle keeps truncated preview note first", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-tall-collision-"));
	try {
		const path = fileURLToPath(new URL("../test/fixtures/tall.xlsx", import.meta.url));
		const options = resolveOptions({ path, outputDir: out } as never, {}, {});
		const seams = seamsWith(async (_mode, co) => {
			mkdirSync(String(co.sheetsStagingDir), { recursive: true }); writeFileSync(join(String(co.sheetsStagingDir), "s0-tall.csv"), "x\n");
			return { ok: true, json: { markdown: "# Tall\n", notes: ["preview truncated: Tall (100 of 150 rows); full data: sheets/s0-tall.csv"] } };
		});
		await convertDocument(options, undefined, seams);
		const renamed = await convertDocument(options, undefined, seams);
		assert.equal(renamed.details.notes[0], "preview truncated: Tall (100 of 150 rows); full data: sheets/tall-2-s0-tall.csv");
		assert.equal(renamed.details.notes[1], "renamed to tall-2 (tall.md exists)");
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("doc uses soffice PDF ladder and info; missing office gives targeted error", async () => {
	const path = fileURLToPath(new URL("../test/fixtures/sample.doc", import.meta.url));
	const options = resolveOptions({ path, pages: "1-2" } as never, {}, {});
	const modes: string[] = [];
	const seams: Partial<PipelineSeams> = { ...seamsWith(async (mode, co) => { modes.push(mode); assert.equal(co.path, MULTIPAGE); assert.deepEqual(co.pages, [1, 2]); return okTier("# doc\n", [1, 2]); }), office: fakeOffice({ ok: true, pdfPath: MULTIPAGE, cleanup: () => {} }) };
	const r = await convertDocument(options, undefined, seams);
	assert.deepEqual(modes, ["pdf-primary"]); assert.match(r.output, /Degraded: LibreOffice PDF route/);
	rmSync(dirname(r.details.savedTo), { recursive: true, force: true });
	await assert.rejects(convertDocument(options, undefined, { ...seams, office: fakeOffice({ ok: false, kind: "missing", code: null, timedOut: false, stderr: "" }) }), /DOC conversion needs LibreOffice \(soffice\); direct conversion is not available/);
	await inspectDocument(resolveOptions({ path, info: true } as never, {}, {}), undefined, { ...seams, runTier: async (mode, co) => { assert.equal(mode, "info"); assert.equal(co.path, MULTIPAGE); return { ok: true, json: {} }; } });
});

test("email backend gates and publishes images and attachments", async () => {
	const eml = fileURLToPath(new URL("../test/fixtures/sample.eml", import.meta.url));
	const msg = fileURLToPath(new URL("../test/fixtures/sample.msg", import.meta.url));
	const noEmail: Backend = { kind: "python", exe: "python3", pdf: true, xlsx: true, docx: true, email: false };
	const gateOut = mkdtempSync(join(tmpdir(), "quiver-email-gate-"));
	try {
		await assert.rejects(convertDocument(resolveOptions({ path: msg, outputDir: gateOut } as never, {}, {}), undefined, seamsWith(async () => { throw Error("must not run"); }, noEmail)), /MSG conversion needs the extract-msg package/);
		assert.deepEqual(readdirSync(gateOut), []);
		await assert.rejects(convertDocument(resolveOptions({ path: eml, outputDir: gateOut } as never, {}, {}), undefined, seamsWith(async () => { throw Error("must not run"); }, PY_NO_DOCX)), /EML conversion needs the Python DOCX\/HTML packages/);
		assert.deepEqual(readdirSync(gateOut), []);
	} finally { rmSync(gateOut, { recursive: true, force: true }); }
	for (const path of [eml, msg]) {
		const out = mkdtempSync(join(tmpdir(), "quiver-email-"));
		try {
			const r = await convertDocument(resolveOptions({ path, outputDir: out } as never, {}, {}), undefined, seamsWith(async (mode, co, b) => {
				assert.equal(mode, "email"); stagePage(b, 1, "img1.png"); mkdirSync(String(co.attachmentsStagingDir), { recursive: true }); writeFileSync(join(String(co.attachmentsStagingDir), "notes.txt"), "hello world");
				return { ok: true, json: { markdown: "# Subj\n\n![figure](p1/img1.png)\n\n![remote](https://example.com/logo.png)\n\n![missing](cid:unknown)\n\n## Attachments\n\n- [`notes.txt`](attachments/notes.txt) (11B, text/plain)\n" } };
			}));
			assert.match(r.output, new RegExp(`Engine: ${path === msg ? "extract-msg" : "email"}   Tier: email`));
			assert.match(readFileSync(r.details.savedTo, "utf8"), /images\/sample-p1-1.png/);
			assert.match(readFileSync(r.details.savedTo, "utf8"), /attachments\/sample-notes.txt/);
			assert.match(readFileSync(r.details.savedTo, "utf8"), /!\[remote\]\(https:\/\/example.com\/logo.png\)/);
			assert.match(readFileSync(r.details.savedTo, "utf8"), /!\[missing\]\(cid:unknown\)/);
		} finally { rmSync(out, { recursive: true, force: true }); }
	}
	for (const path of [eml, msg]) await assert.rejects(inspectDocument(resolveOptions({ path, info: true } as never, {}, {}), undefined, seamsWith(async () => { throw Error("must not run"); })), /info does not apply to email; convert directly/);
	await assert.rejects(convertDocument(resolveOptions({ path: eml } as never, {}, {}), undefined, seamsWith(async () => ({ ok: false, reason: "exit 1", detail: "email parse failed: boom" }))), /Conversion failed: email exit 1 \(email parse failed: boom\)/);
});

test("failed primary page renders are not published by fallback", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-stale-pages-"));
	try {
		const r = await convertDocument(opts({ outputDir: out, pageImages: true }), undefined, seamsWith(async (mode, co) => {
			if (mode === "pdf-primary") {
				mkdirSync(String(co.pagesStagingDir), { recursive: true });
				writeFileSync(join(String(co.pagesStagingDir), "p1.png"), "stale");
				return { ok: false, reason: "timeout" };
			}
			return { ok: true, json: { markdown: "fallback\n", pageCount: 1, pageImages: [{ page: 1, file: "p1.png" }] } };
		}));
		assert.equal(r.details.pageImageCount, 0);
		assert.equal(existsSync(join(out, "pages", "multipage-p1.png")), false);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("email dependency failure does not reserve a bundle name", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-email-gate-"));
	try {
		const path = fileURLToPath(new URL("../test/fixtures/sample.msg", import.meta.url));
		await assert.rejects(convertDocument(resolveOptions({ path, outputDir: out } as never, {}, {}), undefined, seamsWith(async () => { throw Error("must not run"); }, { kind: "python", exe: "python3", pdf: true, xlsx: true, docx: true, email: false })), /MSG conversion needs the extract-msg package/);
		assert.deepEqual(readdirSync(out), []);
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("page images publish and unsupported routes explain absence", async () => {
	const out = mkdtempSync(join(tmpdir(), "quiver-pages-"));
	try {
		const r = await convertDocument(opts({ outputDir: out, pageImages: true }), undefined, seamsWith(async (mode, co) => {
			assert.equal(mode, "pdf-primary"); mkdirSync(String(co.pagesStagingDir), { recursive: true });
			for (const page of [1, 12]) writeFileSync(join(String(co.pagesStagingDir), `p${page}.png`), "x");
			return { ok: true, json: { markdown: "![page 1](pages/p1.png)\n", pageCount: 12, pageImages: [{ page: 1, file: "p1.png" }, { page: 12, file: "p12.png" }] } };
		}));
		assert.match(r.output, /^Pages-Dir: .*pages \(2 pages\)$/m);
		assert.match(readFileSync(r.details.savedTo, "utf8"), /pages\/multipage-p01.png/);
		assert.ok(existsSync(join(out, "pages", "multipage-p12.png")));
		const none = await convertDocument(opts({ pageImages: true }), undefined, seamsWith(async () => okTier("x\n", [1]), { kind: "none", reason: "not found" }));
		assert.match(none.output, /^Pages-Dir: none - page images need the Python backend$/m); rmSync(dirname(none.details.savedTo), { recursive: true, force: true });
		const docx = await convertDocument(docxOpts({ pageImages: true }), undefined, seamsWith(async () => okDocx("# doc\n")));
		assert.match(docx.output, /^Pages-Dir: none - docx has no page geometry$/m); rmSync(dirname(docx.details.savedTo), { recursive: true, force: true });
		const html = await convertDocument(htmlOpts("page.html", { pageImages: true }), undefined, seamsWith(async () => okTier("# page\n", [1])));
		assert.match(html.output, /^Pages-Dir: none - html has no page geometry$/m); rmSync(dirname(html.details.savedTo), { recursive: true, force: true });
		const xlsxPath = fileURLToPath(new URL("../test/fixtures/tall.xlsx", import.meta.url));
		const xlsx = await convertDocument(resolveOptions({ path: xlsxPath, pageImages: true } as never, {}, {}), undefined, seamsWith(async () => okTier("# sheet\n", [1])));
		assert.match(xlsx.output, /^Pages-Dir: none - xlsx has no page geometry$/m); rmSync(dirname(xlsx.details.savedTo), { recursive: true, force: true });
		const plain = await convertDocument(opts(), undefined, seamsWith(async () => okTier("x\n", [1])));
		assert.doesNotMatch(plain.output, /Pages-Dir:/); rmSync(dirname(plain.details.savedTo), { recursive: true, force: true });
	} finally { rmSync(out, { recursive: true, force: true }); }
});

test("lock-only collision reports the held lock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-lock-note-"));
	try {
		writeFileSync(join(dir, "multipage.md.lock"), "");
		const r = await convertDocument(opts({ outputDir: dir, pages: "1" }), undefined, seamsWith(async () => okTier("# one\n", [1])));
		assert.match(r.output, /^Notes: renamed to multipage-2 \(multipage\.md\.lock held; delete it if no conversion is running\)$/m);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same stem twice without overwrite renames and notes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-coll-"));
	try {
		const seams = seamsWith(async () => okTier("# one\n", [1]));
		const a = await convertDocument(opts({ outputDir: dir, pages: "1" }), undefined, seams);
		const b = await convertDocument(opts({ outputDir: dir, pages: "1" }), undefined, seams);
		assert.ok(a.details.savedTo.endsWith("multipage.md") && b.details.savedTo.endsWith("multipage-2.md"));
		assert.match(b.output, /^Notes: renamed to multipage-2 \(multipage\.md exists\)$/m);
		rmSync(b.details.savedTo);
		writeFileSync(join(dir, "multipage-2.md.lock"), "");
		const c = await convertDocument(opts({ outputDir: dir, pages: "1" }), undefined, seams);
		assert.ok(c.details.savedTo.endsWith("multipage-3.md"));
		assert.match(c.output, /^Notes: renamed to multipage-3 \(multipage\.md exists\)$/m);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
