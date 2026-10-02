import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliAgentDir, parseCliArgs, readCliSettings } from "../bin/pi-quiver.ts";
import { DOC_TO_MD_OPTIONS, resolveOptions } from "../lib/doc-to-md-core.ts";
import { BUNDLE_LAYOUT } from "../lib/doc-to-md-options.ts";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/pi-quiver.ts", import.meta.url));
const MULTIPAGE = fileURLToPath(new URL("../test/fixtures/multipage.pdf", import.meta.url));
const FIXTURE_DOCX = fileURLToPath(new URL("../test/fixtures/sample.docx", import.meta.url));

// Spec hard rule: no network, no uv/pip, never the real cache dir.
// PATH = node dir only (uv/python/soffice all ENOENT); cache env -> temp dir.
function scrubbedEnv(tmp: string): NodeJS.ProcessEnv {
	return { ...process.env, PATH: dirname(process.execPath), HOME: tmp, XDG_CACHE_HOME: join(tmp, "xdg"), LOCALAPPDATA: join(tmp, "lad") };
}

test("parseCliArgs: doc-to-md flags map to per-call input", () => {
	const r = parseCliArgs(["doc-to-md", "--pages", "2-3", "--output-dir", "out", "--overwrite", "--primary-timeout", "5000", "--image-format", "jpg", "a.pdf"]);
	assert.deepStrictEqual(r, { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", pages: "2-3", outputDir: "out", overwrite: true, primaryTimeoutMs: 5000, imageFormat: "jpg" }, json: false });
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--info", "a.pdf"]), { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", info: true }, json: false });
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--help"]), { ok: true, cmd: "doc-to-md-help" });
});

test("parseCliArgs: --no-ocr sets false and overrides a settings-level ocr: true", () => {
	const r = parseCliArgs(["doc-to-md", "--no-ocr", "a.pdf"]);
	assert.deepStrictEqual(r, { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", ocr: false }, json: false });
	if (!r.ok || r.cmd !== "doc-to-md") return;
	assert.strictEqual(resolveOptions(r.perCall, { ocr: true }, {}).ocr, false);
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--no-overwrite", "a.pdf"]), { ok: false, error: "unknown flag: --no-overwrite" });
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--ocr", "a.pdf"]), { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", ocr: true }, json: false });
});

test("parseCliArgs: --hide-annotations and --no-hide-annotations override settings", () => {
	for (const [flag, value] of [["--hide-annotations", true], ["--no-hide-annotations", false]] as const) {
		const r = parseCliArgs(["doc-to-md", flag, "a.pdf"]);
		assert.deepStrictEqual(r, { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", hideAnnotations: value }, json: false });
		if (!r.ok || r.cmd !== "doc-to-md") return;
		assert.strictEqual(resolveOptions(r.perCall, { hideAnnotations: !value }, {}).hideAnnotations, value);
	}
});

test("parseCliArgs: every doc-to-md descriptor flag round-trips", () => {
	for (const d of DOC_TO_MD_OPTIONS) {
		if (!d.flag) continue;
		const value = d.type === "int" ? "7"
			: d.type === "enum" ? d.enumValues![0]
			: d.type === "version" ? "1.27.2.3"
			: d.type === "pages" ? "1-2"
			: "x";
		const r = parseCliArgs(["doc-to-md", d.flag, ...(d.type === "bool" ? [] : [value]), "a.pdf"]);
		assert.deepStrictEqual({ ok: r.ok, cmd: r.ok ? r.cmd : undefined }, { ok: true, cmd: "doc-to-md" }, d.flag);
		if (!r.ok || r.cmd !== "doc-to-md") continue;
		assert.strictEqual(r.perCall[d.key], d.type === "int" ? 7 : d.type === "bool" ? true : value, d.flag);
		if (d.type === "int") assert.strictEqual(parseCliArgs(["doc-to-md", d.flag, "not-a-number", "a.pdf"]).ok, false, d.flag);
	}
});

test("parseCliArgs: doc-to-md usage errors", () => {
	for (const argv of [["doc-to-md"], ["doc-to-md", "a.pdf", "b.pdf"], ["doc-to-md", "--raw", "a.pdf"], ["doc-to-md", "--pages"], ["doc-to-md", "--primary-timeout", "x", "a.pdf"]]) {
		assert.strictEqual(parseCliArgs(argv).ok, false, JSON.stringify(argv));
	}
});

test("readCliSettings: agent dir from PI_CODING_AGENT_DIR (tilde expanded, empty = unset), project wins", () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-cli-set-"));
	try {
		mkdirSync(join(tmp, "agent")); writeFileSync(join(tmp, "agent", "settings.json"), JSON.stringify({ quiver: { docToMd: { primaryTimeoutMs: 111, imageDpi: 72 } } }));
		mkdirSync(join(tmp, "proj", ".pi"), { recursive: true }); writeFileSync(join(tmp, "proj", ".pi", "settings.json"), JSON.stringify({ quiver: { docToMd: { primaryTimeoutMs: 222, bogus: 1, bogus2: 2 } } }));
		const warnings: string[] = [];
		const s = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: join(tmp, "agent") }, (m) => warnings.push(m));
		assert.deepStrictEqual(s, { primaryTimeoutMs: 222, imageDpi: 72 });
		const unknownWarnings = warnings.filter((w) => w.includes("not tunable"));
		assert.strictEqual(unknownWarnings.length, 1);
		assert.deepStrictEqual(unknownWarnings[0].split("ignored: ")[1].split(", "), ["bogus", "bogus2"]);
		const home = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: "", HOME: tmp }, () => {});
		assert.deepStrictEqual(home, { primaryTimeoutMs: 222 }); // ~/.pi/agent/settings.json absent -> project only
		const tilde = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: "~/agent", HOME: tmp }, () => {});
		assert.deepStrictEqual(tilde, { primaryTimeoutMs: 222, imageDpi: 72 });
		assert.strictEqual(cliAgentDir({ PI_CODING_AGENT_DIR: "~other", HOME: tmp }), "~other");
		const otherUser = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: "~other", HOME: tmp }, () => {});
		assert.deepStrictEqual(otherUser, { primaryTimeoutMs: 222 }); // literal ~other/settings.json absent -> project only
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: flagless call prints a handle (degraded unpdf), exit 0", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-cli-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /^Saved-To: .*multipage\.md$/m);
		assert.match(stdout, /^Type: pdf   Engine: unpdf   Tier: unpdf$/m);
		assert.match(stdout, /^Page-Count: 6   Pages: all/m);
		assert.match(stdout, /^Degraded: unpdf text extraction - structure not preserved$/m);
		assert.ok(stdout.endsWith("\n") && !stdout.endsWith("\n\n"));
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --info prints the info handle", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-info-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--info", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /^Type: pdf   Page-Count: 6   Backend: none$/m);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --help exit 0 lists every flag", async () => {
	const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--help"]);
	for (const f of ["--info", "--pages", "--output-dir", "--overwrite", "--primary-timeout", "--fallback-timeout", "--soffice-timeout", "--excel-timeout", "--warm-timeout", "--pymupdf-version", "--image-dpi", "--image-format", "--max-output-bytes", "--outline-max-entries", "--ocr", "--ocr-language", "--hide-annotations"]) assert.ok(stdout.includes(f), f);
	assert.ok(!stdout.includes("--max-cells-per-sheet"));
});

test("CLI subprocess: exit 2 on bad --pages, unknown flag, --info with --pages", async () => {
	for (const argv of [["--pages", "x", MULTIPAGE], ["--nope", MULTIPAGE], ["--info", "--pages", "1", MULTIPAGE]]) {
		await assert.rejects(execFileAsync(process.execPath, [BIN, "doc-to-md", ...argv]), (e: { code?: number; stderr?: string }) => e.code === 2 && /Usage:/.test(e.stderr ?? ""), JSON.stringify(argv));
	}
});

test("CLI subprocess: same stem twice -> multipage-2.md with a note; --overwrite replaces multipage.md", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-coll-"));
	try {
		await execFileAsync(process.execPath, [BIN, "doc-to-md", "--output-dir", tmp, MULTIPAGE], { env: scrubbedEnv(tmp) });
		const second = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--output-dir", tmp, MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(second.stdout, /^Saved-To: .*multipage-2\.md$/m);
		assert.match(second.stdout, /^Notes: renamed to multipage-2 \(multipage\.md exists\)$/m);
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--output-dir", tmp, "--overwrite", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /^Saved-To: .*[/\\]multipage\.md$/m);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: missing file -> exit 1, no stack trace", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-miss-"));
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [BIN, "doc-to-md", "/nope/absent.pdf"], { env: scrubbedEnv(tmp) }),
			(err: { code?: number; stderr?: string }) =>
				err.code === 1 && /doc-to-md failed: Not a readable file/.test(err.stderr ?? "") && !/\n\s+at /.test(err.stderr ?? ""),
		);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: docx without soffice -> exit 1 naming LibreOffice", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-soff-"));
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [BIN, "doc-to-md", FIXTURE_DOCX], { env: scrubbedEnv(tmp) }),
			(err: { code?: number; stderr?: string }) => err.code === 1 && /LibreOffice/.test(err.stderr ?? ""),
		);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('parseCliArgs: --json is a CLI flag, --page-images a descriptor flag, --pages "" is accepted', () => {
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--json", "--page-images", "--words", "--pages", "", "a.pdf"]), { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", pageImages: true, words: true, pages: "" }, json: true });
	assert.ok(!DOC_TO_MD_OPTIONS.some((d) => d.flag === "--json"));
});

test("CLI subprocess: --json prints one HandleData object and nothing else; --json --info prints InfoData", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-json-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--json", "--pages", "", "--output-dir", tmp, MULTIPAGE], { env: scrubbedEnv(tmp) });
		const h = JSON.parse(stdout);
		assert.deepStrictEqual(Object.keys(h).sort(), ["bytes", "degraded", "emptyPages", "engine", "explicitBreaks", "failedPages", "fallbackReason", "imageCount", "imagesDir", "lines", "nativeImages", "notes", "ocr", "ocrDir", "pageStats", "pageStatsPath", "outline", "outlineTotal", "pageCount", "pageImageCount", "pageImagesReason", "pages", "pagesDir", "savedTo", "sheetsDir", "tier", "type", "wordsPath", "wordsReason", "wordsErrors"].sort());
		assert.strictEqual(h.tier, "unpdf"); assert.strictEqual(h.pages, null);
		assert.strictEqual(h.wordsPath, null);
		assert.strictEqual(h.wordsReason, null);
		assert.deepStrictEqual(h.wordsErrors, {});
		assert.ok(!stdout.includes("Saved-To:"));
		const info = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--json", "--info", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.deepStrictEqual(Object.keys(JSON.parse(info.stdout)).sort(), ["backend", "metadata", "pageCount", "sheets", "sheetsTotal", "toc", "tocTotal", "type"]);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --json --words reports no geometry on the unpdf tier", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-json-words-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--json", "--words", "--output-dir", tmp, MULTIPAGE], { env: scrubbedEnv(tmp) });
		const h = JSON.parse(stdout);
		assert.strictEqual(h.tier, "unpdf");
		assert.strictEqual(h.wordsPath, null);
		assert.strictEqual(h.wordsReason, "none - unpdf tier has no page geometry");
		assert.deepStrictEqual(h.wordsErrors, {});
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --help lists --page-images and the empty file error is exit 1", async () => {
	const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--help"]);
	assert.ok(stdout.includes("--page-images"));
	assert.match(stdout, /^  --words\s+Write word positions/m);
	assert.ok(stdout.includes("Bundle layout:"));
	for (const r of BUNDLE_LAYOUT) assert.ok(stdout.includes(r.artifact), r.artifact);
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-zero-"));
	try {
		writeFileSync(join(tmp, "zero.pdf"), "");
		await assert.rejects(execFileAsync(process.execPath, [BIN, "doc-to-md", join(tmp, "zero.pdf")], { env: scrubbedEnv(tmp) }), (e: { code?: number; stderr?: string }) => e.code === 1 && /doc-to-md failed: empty file: .*zero\.pdf/.test(e.stderr ?? ""));
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});


test("parseCliArgs: --ocr-mode maps to perCall.ocrMode", () => {
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--ocr", "--ocr-mode", "all", "--pages", "2", "a.pdf"]), { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", ocr: true, ocrMode: "all", pages: "2" }, json: false });
});

test("CLI subprocess: --ocr-mode all usage errors exit 2 with the guard message; no backend is exit 1", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-ocr-mode-"));
	try {
		const cases: [string[], RegExp][] = [
			[["--ocr-mode", "all", "--pages", "2", MULTIPAGE], /^--ocr-mode all requires --ocr$/m],
			[["--ocr", "--ocr-mode", "all", MULTIPAGE], /^--ocr-mode all requires an explicit --pages selection \(e\.g\. --pages 2,7\); omitted pages and --pages "" mean all pages and are refused to keep OCR cost bounded$/m],
			[["--ocr", "--ocr-mode", "all", "--pages", "", MULTIPAGE], /requires an explicit --pages selection/],
			...[FIXTURE_DOCX, fileURLToPath(new URL("./fixtures/html/page.html", import.meta.url)), fileURLToPath(new URL("./fixtures/ocr.png", import.meta.url))].map((path): [string[], RegExp] => [["--ocr", "--ocr-mode", "all", "--pages", "1", path], /^--ocr-mode all applies to PDF, PPTX and DOC inputs only \(DOCX pages are page-break segments, not PDF pages; convert the DOCX to PDF first\)$/m]),
			[["--info", "--ocr-mode", "all", MULTIPAGE], /--info cannot be combined with .*--ocr-mode all/],
			[["--ocr-mode", "sometimes", MULTIPAGE], /--ocr-mode must be one of textless, all/],
		];
		for (const [argv, re] of cases) {
			await assert.rejects(execFileAsync(process.execPath, [BIN, "doc-to-md", ...argv], { env: scrubbedEnv(tmp) }), (e: { code?: number; stderr?: string }) => e.code === 2 && re.test(e.stderr ?? "") && /Usage:/.test(e.stderr ?? "") && /\[--ocr\] \[--ocr-mode textless\|all\]/.test(e.stderr ?? ""), JSON.stringify(argv));
		}
		await assert.rejects(execFileAsync(process.execPath, [BIN, "doc-to-md", "--ocr", "--ocr-mode", "all", "--pages", "1", MULTIPAGE], { env: scrubbedEnv(tmp) }), (e: { code?: number; stderr?: string }) => e.code === 1 && /doc-to-md failed: --ocr-mode all cannot run: no Python backend/.test(e.stderr ?? ""));
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --help lists --ocr-mode and the two-pass recipe", async () => {
	const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--help"]);
	assert.ok(stdout.includes("--ocr-mode"));
	assert.ok(stdout.includes("Two-pass OCR (PDF, PPTX, DOC):"));
	assert.ok(stdout.includes("pi-quiver doc-to-md report.pdf --output-dir out --ocr --ocr-mode all --pages 2,7 --json"));
});
