import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveOptions, TUNABLE_DEFAULTS } from "../lib/doc-to-md-options.ts";
import { classifyInput, soffArgs, warmArgs, uvChildArgs, pythonChildArgs, scriptPath, runCapped, KILL_GRACE_MS, VENV_DIR_NAME, LEGACY_VENV_DIR_NAME, findPackageRoot, parseProbeOutput, meetsFloor, cacheDir, venvPython, resolveBackend, getBackend, resetBackendCacheForTests, probeArgs, PROBE_PROGRAM, convertOffice, pipInstallArgs, convertDocument, inspectDocument, resolveUnpdfWorker, type PipelineSeams, type TierResult, type Backend } from "../lib/doc-to-md-core.ts";
import type { CappedResult as CR, ResolverDeps } from "../lib/doc-to-md-core.ts";

const FAKE_TIER = fileURLToPath(new URL("../test/fixtures/fake-tier.mjs", import.meta.url));


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

test("parseProbeOutput: PY/PDF/XLSX grammar", () => {
	assert.deepEqual(parseProbeOutput("PY 3 12\nPDF yes\nXLSX no\n"), { major: 3, minor: 12, pdf: true, xlsx: false });
	assert.deepEqual(parseProbeOutput("PY 3 14\r\nPDF yes\r\nXLSX yes\r\n"), { major: 3, minor: 14, pdf: true, xlsx: true });
	assert.equal(parseProbeOutput("PY 3 12\nPKG 1.27.0\n"), null);
});

test("meetsFloor: >= 3.12 only", () => {
	assert.equal(meetsFloor({ major: 3, minor: 12, pdf: false, xlsx: false }), true);
	assert.equal(meetsFloor({ major: 4, minor: 0, pdf: false, xlsx: false }), true);
	assert.equal(meetsFloor({ major: 3, minor: 11, pdf: false, xlsx: false }), false);
	assert.equal(meetsFloor({ major: 2, minor: 7, pdf: false, xlsx: false }), false);
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
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX yes\n") });
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
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "uv", pdf: true, xlsx: true });
});

test("resolver: uv absent, python3 importable -> python backend, python not probed", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX yes\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", pdf: true, xlsx: true });
	assert.ok(!d.calls.includes("python"));
});

test("resolver: uv warm FAILURE (present) still continues to python", async () => {
	const d = fakeDeps({ uv: fail("warm exploded"), python3: ok("PY 3 13\nPDF yes\nXLSX yes\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", pdf: true, xlsx: true });
});

test("resolver: python3 too old is skipped entirely; python picks up", async () => {
	const d = fakeDeps({ python3: ok("PY 3 11\nPDF yes\nXLSX yes\n"), python: ok("PY 3 12\nPDF yes\nXLSX yes\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python", pdf: true, xlsx: true });
});

test("resolver: all candidates package-less -> bootstrap from first eligible; venv backend at pin", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		python: ok("PY 3 13\nPDF no\nXLSX no\n"),
		[FAKE_VENV_EXE]: enoent(),
		[FAKE_VENV_TMP_EXE]: ok(""), // pip install
	});
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
	assert.deepEqual(d.renames, [[FAKE_VENV_TMP_DIR, FAKE_VENV_DIR]]);
	// python (second candidate) still probed before bootstrap chose python3
	assert.ok(d.calls.includes("python"));
});

test("resolver: cached venv wins over bootstrap, loses to importable system python", async () => {
	const cachedOnly = fakeDeps({ python3: ok("PY 3 12\nPDF no\nXLSX no\n"), [FAKE_VENV_EXE]: ok("PY 3 12\nPDF yes\nXLSX yes\n") });
	assert.deepEqual(await resolveBackend(CFG, cachedOnly), { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
	const sysWins = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX yes\n"), [FAKE_VENV_EXE]: ok("PY 3 12\nPDF yes\nXLSX yes\n") });
	assert.deepEqual(await resolveBackend(CFG, sysWins), { kind: "python", exe: "python3", pdf: true, xlsx: true });
});

test("resolver: broken cached venv is removed and re-bootstrapped", async () => {
	// First rename attempt fails because the stale broken venvDir is still present; the winner probe finds it still
	// broken, so venvDir is rmrf'd and the rename is retried.
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		[FAKE_VENV_EXE]: fail("dyld: missing"),
		[FAKE_VENV_TMP_EXE]: ok(""),
	}, { rename: (() => { let n = 0; return () => { n++; if (n === 1) throw new Error("EEXIST"); }; })() });
	const r = await resolveBackend(CFG, d);
	assert.equal(r.kind, "venv");
	assert.ok(d.rms.includes(FAKE_VENV_DIR));
});

test("resolver: winner publishes after our build starts — first rename fails, healthy winner adopted, never rmrf'd", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		// cached probe + recheck: absent (no winner yet); post-rename-failure probe: winner has published
		[FAKE_VENV_EXE]: [enoent(), enoent(), ok("PY 3 12\nPDF yes\nXLSX yes\n")],
		[FAKE_VENV_TMP_EXE]: ok(""),
	}, { rename: () => { throw new Error("EEXIST"); } });
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
	assert.deepEqual(d.rms, [FAKE_VENV_TMP_DIR]); // only our tmp cleaned up, winner's venvDir untouched
});

test("resolver: bootstrap pip failure -> none with closed-list reason", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
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
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		[FAKE_VENV_EXE]: [enoent(), enoent(), ok("PY 3 12\nPDF yes\nXLSX yes\n")], // first probe: absent; pre-rmrf recheck: absent; post-race probe: winner
		[FAKE_VENV_TMP_EXE]: ok(""),
	}, { rename: () => { throw new Error("EEXIST"); } });
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
});

test("resolver: competing venv published between probe and bootstrap is adopted, not deleted", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		[FAKE_VENV_EXE]: [enoent(), ok("PY 3 12\nPDF yes\nXLSX yes\n")], // first probe: absent; recheck: winner appeared
	});
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
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
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		[FAKE_VENV_EXE]: enoent(),
		[FAKE_VENV_TMP_EXE]: ok(""),
	});
	const [a, b] = await Promise.all([getBackend(CFG, d), getBackend(CFG, d)]);
	const expected = { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true };
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
	assert.deepEqual(await getBackend(CFG, goodDeps), { kind: "uv", pdf: true, xlsx: true });
	resetBackendCacheForTests();
});

test("getBackend: a non-creator's abort signal is ignored — creator-only binding", async () => {
	resetBackendCacheForTests();
	const d = fakeDeps({ uv: ok("") });
	const ac = new AbortController();
	ac.abort();
	const first = await getBackend(CFG, d); // creates backendPromise, no signal
	const second = await getBackend(CFG, undefined, ac.signal); // finds existing promise, aborted signal must be ignored
	assert.deepEqual(first, { kind: "uv", pdf: true, xlsx: true });
	assert.deepEqual(second, { kind: "uv", pdf: true, xlsx: true });
	resetBackendCacheForTests();
});

test("convertOffice: soffice ran (code 0) but produced no PDF — hard error naming LibreOffice", async () => {
	const run = async (): Promise<CR> => ({ stdout: "", stderr: "", code: 0, timedOut: false, capped: false });
	await assert.rejects(convertOffice(120_000, join(process.cwd(), "test/fixtures/sample.docx"), undefined, run), /LibreOffice/);
});



test("warmArgs: pins the full package set + python 3.14 + import probe", () => {
	assert.deepEqual(warmArgs(CFG), ["run", "--with", "pymupdf4llm==1.27.2.3", "--with", "openpyxl==3.1.5", "--with", "xlrd==2.0.2", "--with", "pillow==12.3.0", "--python", "3.14", "python", "-c", "import pymupdf4llm, openpyxl, xlrd, PIL"]);
});

test("uvChildArgs / pythonChildArgs: mode only on argv, script resolved from package root", () => {
	assert.deepEqual(uvChildArgs(CFG, "/pkg/scripts/doc_to_md.py", "pdf-primary").slice(-3), ["python", "/pkg/scripts/doc_to_md.py", "pdf-primary"]);
	assert.deepEqual(pythonChildArgs("/pkg/scripts/doc_to_md.py", "xlsx"), ["/pkg/scripts/doc_to_md.py", "xlsx"]);
	assert.ok(scriptPath().endsWith(join("scripts", "doc_to_md.py")));
});

test("PROBE_PROGRAM gates PDF on pymupdf import + pymupdf4llm >= 1.27.0 and XLSX on openpyxl/xlrd/PIL", () => {
	assert.match(PROBE_PROGRAM, /import pymupdf\b/);
	assert.match(PROBE_PROGRAM, /1\.27\.0/);
	assert.match(PROBE_PROGRAM, /import openpyxl, xlrd, PIL/);
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
	const d = fakeDeps({ uv: fail("warm failed"), python3: ok("PY 3 12\nPDF no\nXLSX no\n") }, { now: () => t });
	const wrapped: ResolverDeps = { ...d, run: async (cmd, args, opts) => { seen.push(opts.timeoutMs); t += 3000; return d.run(cmd, args, opts); } };
	const backend = await resolveBackend({ ...CFG, warmTimeoutMs: 5000 }, wrapped);
	assert.deepEqual(seen, [5000, 2000]);
	assert.equal(backend.kind, "none");
	if (backend.kind === "none") assert.match(backend.reason, /exceeded warmTimeoutMs/);
});

test("resolver: uv elapsed time bounds discovery before fake bootstrap stages can run", async () => {
	let t = 0;
	const timeouts: number[] = [];
	const d = fakeDeps({ uv: fail("warm failed"), python3: ok("PY 3 12\nPDF no\nXLSX no\n") }, { now: () => t });
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
		python3: ok("PY 3 12\nPDF no\nXLSX no\n"),
		[FAKE_VENV_EXE]: [enoent(), enoent()],
		[FAKE_VENV_TMP_EXE]: ok("PY 3 12\nPDF yes\nXLSX yes\n"),
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
	assert.deepEqual(backend, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
	assert.ok(t - t0 <= 5000 + KILL_GRACE_MS, `simulated elapsed ${t - t0}ms`);
	assert.ok(timeouts.every(({ left, timeout }) => timeout <= left), JSON.stringify(timeouts));
});

test("resolver: python with PDF but not XLSX is a valid python backend with xlsx=false", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF yes\nXLSX no\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", pdf: true, xlsx: false });
});

test("resolver: bootstrap installs the full package set into doc-to-md-venv-v2 and removes the legacy pymupdf-venv", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPDF no\nXLSX no\n"), [FAKE_VENV_TMP_EXE]: ok("") });
	const seenArgs: string[][] = [];
	const wrapped: ResolverDeps = { ...d, run: async (cmd, args, opts) => { seenArgs.push(args); return d.run(cmd, args, opts); } };
	const b = await resolveBackend(CFG, wrapped);
	assert.deepEqual(b, { kind: "venv", exe: FAKE_VENV_EXE, pdf: true, xlsx: true });
	assert.ok(seenArgs.some((a) => a.join(" ") === "-m pip install pymupdf4llm==1.27.2.3 openpyxl==3.1.5 xlrd==2.0.2 pillow==12.3.0"));
	assert.deepEqual(d.renames, [[FAKE_VENV_TMP_DIR, FAKE_VENV_DIR]]);
	assert.ok(d.rms.includes(join(FAKE_CACHE_ROOT, LEGACY_VENV_DIR_NAME)));
});

const MULTIPAGE = fileURLToPath(new URL("../test/fixtures/multipage.pdf", import.meta.url));
const opts = (extra: Record<string, unknown> = {}) => resolveOptions({ path: MULTIPAGE, ...extra } as never, {}, {});
const okTier = (markdown: string, pages: number[]): TierResult => ({ ok: true, json: { markdown, pages, pageCount: 6, emptyPages: [], failedPages: [], notes: [] } });
const seamsWith = (runTier: PipelineSeams["runTier"], backend: Backend = { kind: "uv", pdf: true, xlsx: true }): Partial<PipelineSeams> => ({ backend: async () => backend, runTier });

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
	assert.ok(r.output.includes("Outline:\n  L1  # H") || r.output.includes("Outline:\n  L1   # H"));
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
				backend: async () => ({ kind: "python", exe: "/nonexistent/python-binary", pdf: true, xlsx: true }),
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
	await assert.rejects(convertDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => ({ ok: false, reason: "timeout after 1ms" }))), /Excel conversion failed: timeout after 1ms\. Remedy: raise excelTimeoutMs or lower maxCellsPerSheet/);
});

test("convertDocument: xlsx with python backend lacking XLSX -> remedy; no backend -> remedy", async () => {
	const xl = fileURLToPath(new URL("../test/fixtures/workbook.xlsx", import.meta.url));
	await assert.rejects(convertDocument(resolveOptions({ path: xl }, {}, {}), undefined, seamsWith(async () => okTier("", []), { kind: "python", exe: "python3", pdf: true, xlsx: false })), /Remedy: install uv, or pip install openpyxl xlrd pillow/);
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
			new RegExp(`Excel inspection failed: ${reason}\\. Remedy: raise excelTimeoutMs or lower maxCellsPerSheet`),
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
