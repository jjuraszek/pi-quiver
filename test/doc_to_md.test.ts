import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, classifyInput, applyGate, withMarker, pagesToMarkdown, DEGRADED_MARKER, soffArgs, warmArgs, convertArgs, runCapped, findPackageRoot, parseProbeOutput, meetsFloor, cacheDir, venvPython, pythonConvertArgs, resolveBackend, getBackend, resetBackendCacheForTests, runPipeline, probeArgs, PROBE_PROGRAM, convertDocument, convertOffice } from "../lib/doc-to-md-core.ts";
import type { Backend, CappedResult as CR, ResolverDeps } from "../lib/doc-to-md-core.ts";

const FIXTURE_PDF = fileURLToPath(new URL("fixtures/sample.pdf", import.meta.url));

test("parseConfig: defaults when env unset", () => {
	const c = parseConfig({});
	assert.equal(c.pymupdfVersion, "1.27.2.3");
	assert.equal(c.warmTimeoutMs, 120_000);
	assert.equal(c.convertTimeoutMs, 60_000);
	assert.equal(c.sofficeTimeoutMs, 120_000);
});

test("parseConfig: reads overrides", () => {
	const c = parseConfig({ PI_DOC_TO_MD_PYMUPDF_VERSION: "1.26.0", PI_DOC_TO_MD_CONVERT_TIMEOUT_MS: "5000" });
	assert.equal(c.pymupdfVersion, "1.26.0");
	assert.equal(c.convertTimeoutMs, 5000);
});

test("parseConfig: rejects bad version pin (injection guard)", () => {
	assert.throws(() => parseConfig({ PI_DOC_TO_MD_PYMUPDF_VERSION: "1.0; rm -rf /" }), /PI_DOC_TO_MD_PYMUPDF_VERSION/);
});

test("parseConfig: rejects non-positive / NaN timeout", () => {
	assert.throws(() => parseConfig({ PI_DOC_TO_MD_WARM_TIMEOUT_MS: "0" }), /PI_DOC_TO_MD_WARM_TIMEOUT_MS/);
	assert.throws(() => parseConfig({ PI_DOC_TO_MD_CONVERT_TIMEOUT_MS: "abc" }), /PI_DOC_TO_MD_CONVERT_TIMEOUT_MS/);
});

test("classifyInput: routes by extension, case-insensitive", () => {
	assert.equal(classifyInput("/a/b.pdf"), "pdf");
	assert.equal(classifyInput("/a/b.PDF"), "pdf");
	assert.equal(classifyInput("report.docx"), "docx");
	assert.equal(classifyInput("deck.pptx"), "pptx");
});

test("classifyInput: rejects unsupported", () => {
	assert.throws(() => classifyInput("data.xlsx"), /unsupported/i);
	assert.throws(() => classifyInput("notes.txt"), /unsupported/i);
});

test("applyGate: small inline, large spills", () => {
	assert.equal(applyGate("hi").spill, false);
	assert.equal(applyGate("x".repeat(33_000)).spill, true);
	assert.equal(applyGate(Array(1_001).fill("a").join("\n")).spill, true);
	assert.equal(applyGate("").spill, false);
});

test("withMarker: prepends exact marker only when degraded", () => {
	assert.equal(withMarker("body", false), "body");
	assert.equal(withMarker("body", true), `${DEGRADED_MARKER}\n\nbody`);
});

test("pagesToMarkdown: joins pages with separator, trims", () => {
	assert.equal(pagesToMarkdown(["a", "b"]), `a${"\n\n---\n\n"}b`);
	assert.equal(pagesToMarkdown(["  only  "]), "only");
});

test("warmArgs: pins version + python 3.14 + import probe", () => {
	const a = warmArgs(parseConfig({}));
	assert.deepEqual(a, ["run", "--with", "pymupdf4llm==1.27.2.3", "--python", "3.14", "python", "-c", "import pymupdf4llm"]);
});

test("convertArgs: pins version + runs the script with the pdf path", () => {
	const a = convertArgs(parseConfig({}), "/pkg/scripts/pdf_to_md.py", "/tmp/x.pdf");
	assert.deepEqual(a, ["run", "--with", "pymupdf4llm==1.27.2.3", "--python", "3.14", "python", "/pkg/scripts/pdf_to_md.py", "/tmp/x.pdf"]);
});

test("soffArgs: headless flags + isolated profile + convert-to pdf", () => {
	const a = soffArgs("/in/deck.pptx", "/tmp/prof", "/tmp/out");
	assert.ok(a.includes("--headless") && a.includes("--convert-to") && a.includes("pdf"));
	assert.ok(a.includes("-env:UserInstallation=file:///tmp/prof"));
	assert.equal(a[a.length - 1], "/in/deck.pptx");
	const oi = a.indexOf("--outdir");
	assert.equal(a[oi + 1], "/tmp/out");
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

test("parseProbeOutput: grammar — importable / none / garbage", () => {
	assert.deepEqual(parseProbeOutput("PY 3 12\nPKG 0.0.17\n"), { major: 3, minor: 12, pkg: "0.0.17" });
	assert.deepEqual(parseProbeOutput("PY 3 14\nPKG none\n"), { major: 3, minor: 14, pkg: null });
	assert.deepEqual(parseProbeOutput("PY 3 12\r\nPKG none\r\n"), { major: 3, minor: 12, pkg: null }); // windows CRLF
	assert.equal(parseProbeOutput("Python was not found; run without arguments to install"), null); // Store stub
	assert.equal(parseProbeOutput(""), null);
});

test("meetsFloor: >= 3.12 only", () => {
	assert.equal(meetsFloor({ major: 3, minor: 12, pkg: null }), true);
	assert.equal(meetsFloor({ major: 4, minor: 0, pkg: null }), true);
	assert.equal(meetsFloor({ major: 3, minor: 11, pkg: null }), false);
	assert.equal(meetsFloor({ major: 2, minor: 7, pkg: null }), false);
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

test("pythonConvertArgs: bare interpreter argv", () => {
	assert.deepEqual(pythonConvertArgs("/pkg/scripts/pdf_to_md.py", "/tmp/x.pdf"), ["/pkg/scripts/pdf_to_md.py", "/tmp/x.pdf"]);
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
		cacheRoot: "/cache", platform: "linux", pid: 42,
		rename: (a, b) => { renames.push([a, b]); }, rmrf: (p) => { rms.push(p); }, now: () => 0,
		calls, renames, rms, ...over,
	};
}
const CFG = parseConfig({});

test("resolver: injected env is threaded into the run seam", async () => {
	const seenEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
	const d = fakeDeps({ python3: ok("PY 3 12\nPKG 0.0.17\n") });
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
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "uv" });
});

test("resolver: uv absent, python3 importable -> python backend, python not probed", async () => {
	const d = fakeDeps({ python3: ok("PY 3 12\nPKG 0.0.17\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", version: "0.0.17" });
	assert.ok(!d.calls.includes("python"));
});

test("resolver: uv warm FAILURE (present) still continues to python", async () => {
	const d = fakeDeps({ uv: fail("warm exploded"), python3: ok("PY 3 13\nPKG 1.0.0\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python3", version: "1.0.0" });
});

test("resolver: python3 too old is skipped entirely; python picks up", async () => {
	const d = fakeDeps({ python3: ok("PY 3 11\nPKG 0.9.9\n"), python: ok("PY 3 12\nPKG 0.0.17\n") });
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "python", exe: "python", version: "0.0.17" });
});

test("resolver: all candidates package-less -> bootstrap from first eligible; venv backend at pin", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPKG none\n"),
		python: ok("PY 3 13\nPKG none\n"),
		"/cache/pymupdf-venv/bin/python": enoent(),
		"/cache/pymupdf-venv.tmp-42/bin/python": ok(""), // pip install
	});
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: "/cache/pymupdf-venv/bin/python", version: "1.27.2.3" });
	assert.deepEqual(d.renames, [["/cache/pymupdf-venv.tmp-42", "/cache/pymupdf-venv"]]);
	// python (second candidate) still probed before bootstrap chose python3
	assert.ok(d.calls.includes("python"));
});

test("resolver: cached venv wins over bootstrap, loses to importable system python", async () => {
	const venvExe = "/cache/pymupdf-venv/bin/python";
	const cachedOnly = fakeDeps({ python3: ok("PY 3 12\nPKG none\n"), [venvExe]: ok("PY 3 12\nPKG 0.0.9\n") });
	assert.deepEqual(await resolveBackend(CFG, cachedOnly), { kind: "venv", exe: venvExe, version: "0.0.9" });
	const sysWins = fakeDeps({ python3: ok("PY 3 12\nPKG 0.0.17\n"), [venvExe]: ok("PY 3 12\nPKG 0.0.9\n") });
	assert.deepEqual(await resolveBackend(CFG, sysWins), { kind: "python", exe: "python3", version: "0.0.17" });
});

test("resolver: broken cached venv is removed and re-bootstrapped", async () => {
	const venvExe = "/cache/pymupdf-venv/bin/python";
	// First rename attempt fails because the stale broken venvDir is still present; the winner probe finds it still
	// broken, so venvDir is rmrf'd and the rename is retried.
	const d = fakeDeps({
		python3: ok("PY 3 12\nPKG none\n"),
		[venvExe]: fail("dyld: missing"),
		"/cache/pymupdf-venv.tmp-42/bin/python": ok(""),
	}, { rename: (() => { let n = 0; return () => { n++; if (n === 1) throw new Error("EEXIST"); }; })() });
	const r = await resolveBackend(CFG, d);
	assert.equal(r.kind, "venv");
	assert.ok(d.rms.includes("/cache/pymupdf-venv"));
});

test("resolver: winner publishes after our build starts — first rename fails, healthy winner adopted, never rmrf'd", async () => {
	const venvExe = "/cache/pymupdf-venv/bin/python";
	const d = fakeDeps({
		python3: ok("PY 3 12\nPKG none\n"),
		// cached probe + recheck: absent (no winner yet); post-rename-failure probe: winner has published
		[venvExe]: [enoent(), enoent(), ok("PY 3 12\nPKG 1.27.2.3\n")],
		"/cache/pymupdf-venv.tmp-42/bin/python": ok(""),
	}, { rename: () => { throw new Error("EEXIST"); } });
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: venvExe, version: "1.27.2.3" });
	assert.deepEqual(d.rms, ["/cache/pymupdf-venv.tmp-42"]); // only our tmp cleaned up, winner's venvDir untouched
});

test("resolver: bootstrap pip failure -> none with closed-list reason", async () => {
	const d = fakeDeps({
		python3: ok("PY 3 12\nPKG none\n"),
		"/cache/pymupdf-venv.tmp-42/bin/python": fail("No matching distribution"),
	});
	const r = await resolveBackend(CFG, d);
	assert.equal(r.kind, "none");
	assert.ok(r.kind === "none" && /python 3\.12 found but venv bootstrap failed: .*No matching distribution.* - install python3-venv, or uv/.test(r.reason));
	assert.ok(d.rms.includes("/cache/pymupdf-venv.tmp-42"));
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
	const venvExe = "/cache/pymupdf-venv/bin/python";
	const d = fakeDeps({
		python3: ok("PY 3 12\nPKG none\n"),
		[venvExe]: [enoent(), enoent(), ok("PY 3 12\nPKG 1.27.2.3\n")], // first probe: absent; pre-rmrf recheck: absent; post-race probe: winner
		"/cache/pymupdf-venv.tmp-42/bin/python": ok(""),
	}, { rename: () => { throw new Error("EEXIST"); } });
	const r = await resolveBackend(CFG, d);
	assert.deepEqual(r, { kind: "venv", exe: venvExe, version: "1.27.2.3" });
});

test("resolver: competing venv published between probe and bootstrap is adopted, not deleted", async () => {
	const venvExe = "/cache/pymupdf-venv/bin/python";
	const d = fakeDeps({
		python3: ok("PY 3 12\nPKG none\n"),
		[venvExe]: [enoent(), ok("PY 3 12\nPKG 1.27.2.3\n")], // first probe: absent; recheck: winner appeared
	});
	assert.deepEqual(await resolveBackend(CFG, d), { kind: "venv", exe: venvExe, version: "1.27.2.3" });
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
		python3: ok("PY 3 12\nPKG none\n"),
		"/cache/pymupdf-venv/bin/python": enoent(),
		"/cache/pymupdf-venv.tmp-42/bin/python": ok(""),
	});
	const [a, b] = await Promise.all([getBackend(CFG, d), getBackend(CFG, d)]);
	const expected = { kind: "venv", exe: "/cache/pymupdf-venv/bin/python", version: "1.27.2.3" };
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
	assert.deepEqual(await getBackend(CFG, goodDeps), { kind: "uv" });
	resetBackendCacheForTests();
});

test("getBackend: a non-creator's abort signal is ignored — creator-only binding", async () => {
	resetBackendCacheForTests();
	const d = fakeDeps({ uv: ok("") });
	const ac = new AbortController();
	ac.abort();
	const first = await getBackend(CFG, d); // creates backendPromise, no signal
	const second = await getBackend(CFG, undefined, ac.signal); // finds existing promise, aborted signal must be ignored
	assert.deepEqual(first, { kind: "uv" });
	assert.deepEqual(second, { kind: "uv" });
	resetBackendCacheForTests();
});

test("runPipeline: pymupdf conversion failure falls to unpdf without re-resolving", async () => {
	resetBackendCacheForTests();
	let resolved = 0;
	const seams = {
		backend: async () => { resolved++; return { kind: "uv" } as Backend; },
		convertPymupdf: async () => { throw new Error("doc-specific crash"); },
		convertUnpdf: async () => "plain text",
	};
	const r = await runPipeline(parseConfig({}), "/tmp/x.pdf", "pdf", undefined, seams);
	assert.equal(r.engine, "unpdf");
	assert.equal(r.degraded, true);
	assert.equal(r.backend, "unpdf");
	assert.equal(r.fallbackReason, "pymupdf4llm (uv) conversion failed: doc-specific crash - fell back to unpdf");
	assert.equal(resolved, 1);
	resetBackendCacheForTests();
});

test("convertOffice: soffice ran (code 0) but produced no PDF — hard error naming LibreOffice", async () => {
	const run = async (): Promise<CR> => ({ stdout: "", stderr: "", code: 0, timedOut: false, capped: false });
	await assert.rejects(convertOffice(parseConfig({}), join(process.cwd(), "test/fixtures/sample.docx"), undefined, run), /LibreOffice/);
});

test("convertDocument: trims trailing newlines from the engine's output — no trailing newline in the formatter output", async () => {
	const seams: Partial<import("../lib/doc-to-md-core.ts").PipelineSeams> = {
		backend: async () => ({ kind: "none", reason: "test" }) as Backend,
		convertUnpdf: async () => "text\n\n",
	};
	const { output } = await convertDocument(FIXTURE_PDF, parseConfig({}), undefined, seams);
	assert.ok(!output.endsWith("\n"));
	assert.ok(output.endsWith("text"));
});

test("convertDocument: no trailing newline in the composed output when the normalized body is empty (non-degraded)", async () => {
	const seams: Partial<import("../lib/doc-to-md-core.ts").PipelineSeams> = {
		backend: async () => ({ kind: "uv" }) as Backend,
		convertPymupdf: async () => "",
	};
	const { output } = await convertDocument(FIXTURE_PDF, parseConfig({}), undefined, seams);
	assert.ok(!output.endsWith("\n"));
});

test("convertDocument: no trailing newline in the composed output for a normal non-empty body", async () => {
	const seams: Partial<import("../lib/doc-to-md-core.ts").PipelineSeams> = {
		backend: async () => ({ kind: "uv" }) as Backend,
		convertPymupdf: async () => "hello world",
	};
	const { output } = await convertDocument(FIXTURE_PDF, parseConfig({}), undefined, seams);
	assert.ok(!output.endsWith("\n"));
	assert.ok(output.endsWith("hello world"));
});
