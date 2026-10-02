import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertDocument, inspectDocument, resetBackendCacheForTests, resolveOptions, runTierReal, type PipelineSeams } from "../lib/doc-to-md-core.ts";
import type { PageStat } from "../lib/doc-to-md-handle.ts";
import { TUNABLE_DEFAULTS } from "../lib/doc-to-md-options.ts";

const has = (cmd: string) => spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
const HAS_UV = has("uv");
const HAS_SOFFICE = has("soffice");
const fx = (n: string) => fileURLToPath(new URL(`../test/fixtures/${n}`, import.meta.url));
const opts = (path: string, extra: Record<string, unknown> = {}) => resolveOptions({ path, ...extra } as never, {}, {});
const parseHandle = (text: string) => Object.fromEntries([...text.matchAll(/^([A-Za-z-]+): (.*)$/gm)].map((m) => [m[1], m[2]]));
const excelPids = (): Set<string> => {
	const result = spawnSync("pgrep", ["-f", "doc_to_md.py xlsx"], { encoding: "utf8" });
	if (result.status === 1) return new Set();
	assert.strictEqual(result.status, 0, result.error ?? new Error(`pgrep exited ${result.status}`));
	return new Set(result.stdout.trim().split(/\s+/).filter(Boolean));
};
const linksResolve = (mdPath: string) => { const md = readFileSync(mdPath, "utf8"); for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) assert.ok(statSync(resolve(dirname(mdPath), m[1])).isFile(), m[1]); return md; };
const T = { timeout: 300_000, skip: !HAS_UV && "uv not on PATH" } as const;
const NO_SOFFICE_ENV = () => ({ ...process.env, PATH: (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter((p) => !existsSync(join(p, process.platform === "win32" ? "soffice.exe" : "soffice"))).join(process.platform === "win32" ? ";" : ":") });
const SCRIPT = fileURLToPath(new URL("../scripts/doc_to_md.py", import.meta.url));
let tmp: string;
beforeEach(() => { resetBackendCacheForTests(); tmp = mkdtempSync(join(tmpdir(), "quiver-py-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("primary image rewrites accept Windows forward-slash source paths", { skip: !HAS_UV && "uv not on PATH" }, () => {
	const program = [
		"import importlib.util, json",
		`spec = importlib.util.spec_from_file_location("doc_to_md", ${JSON.stringify(SCRIPT)})`,
		"module = importlib.util.module_from_spec(spec)",
		"spec.loader.exec_module(module)",
		"source = 'C:' + chr(92) + 'tmp' + chr(92) + 'pdf-0003-02.png'",
		"sources = module.image_source_map(source, 'p1/img1.png', 'pdf-0003-02.png')",
		"print(json.dumps(module.rewrite_image_destinations('![](C:/tmp/pdf-0003-02.png)', sources)))",
	].join("; ");
	const result = spawnSync("uv", ["run", "--python", "3.14", "python", "-c", program], {
		encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	});
	assert.strictEqual(result.status, 0, result.stderr);
	assert.strictEqual(JSON.parse(result.stdout), "![](p1/img1.png)");
});

test("info: multipage.pdf", T, async () => {
	const r = await inspectDocument(opts(fx("multipage.pdf"), { info: true }));
	assert.match(r.output, /^Type: pdf   Page-Count: 6   Backend: (uv|python|venv)$/m);
	assert.match(r.output, /Title: Multipage Fixture/);
	assert.ok(r.output.includes("TOC:\n  L1 Chapter 1 (p1)\n  L2 Section 2 (p2)"));
});

test("primary --pages 3-5: separators in order, page images for 3 and 5 only, page 4 empty, links resolve", T, async () => {
	const r = await convertDocument(opts(fx("multipage.pdf"), { pages: "3-5", outputDir: tmp }));
	const h = parseHandle(r.output);
	assert.strictEqual(h["Tier"] ?? r.output.match(/Tier: (\w+)/)?.[1], "primary");
	const md = linksResolve(h["Saved-To"]);
	const seps = [...md.matchAll(/--- end of page\.page_number=(\d+) ---/g)].map((m) => Number(m[1]));
	assert.deepStrictEqual(seps, [3, 4, 5]);
	assert.ok(md.includes("PAGE-3") && md.includes("PAGE-5") && !md.includes("PAGE-2"));
	assert.match(r.output, /Empty-Pages: 4/);
	const imgs = readdirSyncSafe(join(dirname(h["Saved-To"]), "images"));
	assert.ok(imgs.some((f) => f.startsWith("multipage-p3-")));
	assert.ok(imgs.filter((f) => f.startsWith("multipage-p5-")).length >= 2);
	assert.ok(!imgs.some((f) => f.startsWith("multipage-p2-")));
});

test("whole document: six separators, Pages: all", T, async () => {
	const r = await convertDocument(opts(fx("multipage.pdf"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	assert.match(r.output, /Page-Count: 6   Pages: all/);
	assert.strictEqual([...linksResolve(h["Saved-To"]).matchAll(/--- end of page\.page_number=\d+ ---/g)].length, 6);
});

test("forced fallback (primaryTimeoutMs 1): Degraded + Fallback-Reason, images extracted, separators intact", T, async () => {
	const r = await convertDocument(opts(fx("multipage.pdf"), { primaryTimeoutMs: 1, outputDir: tmp }));
	const h = parseHandle(r.output);
	assert.match(r.output, /^Degraded: PyMuPDF text extraction - layout\/tables not preserved$/m);
	assert.match(r.output, /^Fallback-Reason: primary timeout after 1ms$/m);
	assert.match(r.output, /Engine: pymupdf-text   Tier: fallback/);
	const md = linksResolve(h["Saved-To"]);
	assert.strictEqual([...md.matchAll(/--- end of page\.page_number=\d+ ---/g)].length, 6);
	assert.ok(readdirSyncSafe(join(dirname(h["Saved-To"]), "images")).some((f) => f.startsWith("multipage-p3-")));
});

test("shared-resources.pdf --pages 2 on the fallback tier: no image (displayed images only)", T, async () => {
	const r = await convertDocument(opts(fx("shared-resources.pdf"), { pages: "2", primaryTimeoutMs: 1, outputDir: tmp }));
	const h = parseHandle(r.output);
	linksResolve(h["Saved-To"]);
	assert.match(r.output, /Images: 0/);
});

test("encrypted.pdf -> password error, no fallback", T, async () => {
	await assert.rejects(convertDocument(opts(fx("encrypted.pdf"), { outputDir: tmp })), (error: Error) => {
		assert.match(error.message, /Password-protected PDF/);
		assert.doesNotMatch(error.message, /Conversion failed|Fallback/);
		return true;
	});
});

const markers = (md: string) => [...md.matchAll(/--- end of page\.page_number=(\d+) ---/g)].map((m) => Number(m[1]));

test("docx: headings, outline offsets, hyperlink, footnote, and two linked images", T, async () => {
	const r = await convertDocument(opts(fx("headings.docx"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	assert.match(r.output, /^Type: docx   Engine: mammoth   Tier: docx$/m);
	assert.match(r.output, /^Page-Count: 3 \(explicit page breaks, not printed pages\)   Pages: all   Images: 2/m);
	const md = linksResolve(h["Saved-To"]);
	assert.match(md, /^# Chapter One$/m);
	assert.match(md, /^## Section A$/m);
	assert.match(md, /^### Detail A1$/m);
	assert.ok(md.includes("[pi-quiver](https://github.com/jjuraszek/pi-quiver)"));
	assert.ok(md.includes("FOOTNOTE-TEXT about provenance") && !md.includes("data:"));
	assert.deepStrictEqual(markers(md), [1, 2, 3]);
	assert.match(md, /^# Chapter Two$\n\n--- end of page\.page_number=1 ---\n\n# Continued$/m);
	assert.match(md, /- beta\n\n--- end of page\.page_number=2 ---\n\n- gamma/);
	const outline = r.output.slice(r.output.indexOf("Outline:"));
	assert.match(outline, /^  L\d+\s+p1\s+# Chapter One$/m);
	assert.match(outline, /^  L\d+\s+p1\s+## Section A$/m);
	assert.match(outline, /^  L\d+\s+p1\s+### Detail A1$/m);
	assert.match(outline, /^  L\d+\s+p2\s+# Continued$/m);
	const imgs = readdirSyncSafe(join(dirname(h["Saved-To"]), "images")).sort();
	assert.deepStrictEqual(imgs, ["headings-p1-1.png", "headings-p3-1.png"]);
	assert.ok(md.includes("![](images/headings-p3-1.png)"), "table-cell picture link kept");
});

test("docx: pages selects segments and referenced footnotes; bounds name segments", T, async () => {
	const one = await convertDocument(opts(fx("headings.docx"), { pages: "1", outputDir: tmp }));
	const mdOne = linksResolve(parseHandle(one.output)["Saved-To"]);
	assert.deepStrictEqual(markers(mdOne), [1]);
	assert.ok(mdOne.includes("FOOTNOTE-TEXT"));
	const three = await convertDocument(opts(fx("headings.docx"), { pages: "3", outputDir: join(tmp, "three") }));
	const mdThree = linksResolve(parseHandle(three.output)["Saved-To"]);
	assert.deepStrictEqual(markers(mdThree), [3]);
	assert.ok(!mdThree.includes("FOOTNOTE-TEXT"));
	const r = await convertDocument(opts(fx("multipage.docx"), { pages: "2-3", outputDir: join(tmp, "mp") }));
	const md = linksResolve(parseHandle(r.output)["Saved-To"]);
	assert.deepStrictEqual(markers(md), [2, 3]);
	assert.ok(md.includes("PAGE-2") && md.includes("PAGE-3") && !md.includes("PAGE-1") && !md.includes("PAGE-4"));
	assert.match(r.output, /^Page-Count: 5 \(explicit page breaks, not printed pages\)   Pages: 2-3   Images: 1/m);
	assert.match(r.output, /^  L\d+\s+p2\s+# Heading 2$/m);
	assert.match(r.output, /^  L\d+\s+p3\s+# Heading 3$/m);
	await assert.rejects(convertDocument(opts(fx("multipage.docx"), { pages: "9", outputDir: join(tmp, "b") })), /pages out of range: 9 \(document has 5 segments\)/);
	await assert.rejects(convertDocument(opts(fx("sample.docx"), { pages: "1", outputDir: join(tmp, "s") })), /--pages does not apply to this DOCX: it has no explicit page breaks; read the \.md by Outline line offsets instead/);
});

test("docx: multipage converts without soffice and has five markers", T, async () => {
	const saved = process.env.PATH;
	process.env.PATH = NO_SOFFICE_ENV().PATH;
	try {
		const r = await convertDocument(opts(fx("multipage.docx"), { outputDir: tmp }));
		const h = parseHandle(r.output);
		assert.ok(h["Saved-To"]);
		assert.deepStrictEqual(markers(linksResolve(h["Saved-To"])), [1, 2, 3, 4, 5]);
		assert.match(r.output, /Tier: docx/);
		assert.match(r.output, /^Page-Count: 5 \(explicit page breaks, not printed pages\)/m);
		for (let n = 1; n <= 5; n++) assert.match(r.output, new RegExp(`^  L\\d+\\s+p${n}\\s+# Heading ${n}$`, "m"));
	} finally { process.env.PATH = saved; }
});

test("docx: bold headings have no outline; sample has no explicit page breaks", T, async () => {
	const r = await convertDocument(opts(fx("bold-headings.docx"), { outputDir: tmp }));
	assert.match(r.output, /^Page-Count: 1 \(no explicit page breaks\) - no page markers; cite by Outline line   Pages: all   Images: 0   Size: \d+(\.\d+)?(B|KB|MB) \/ \d+ lines$/m);
	assert.ok(r.output.split("\n").includes("Outline: none"));
	const s = await convertDocument(opts(fx("sample.docx"), { outputDir: join(tmp, "s") }));
	assert.match(s.output, /^Page-Count: 1 \(no explicit page breaks\) - no page markers; cite by Outline line   Pages: all/m);
});

test("docx: forced python-docx fallback keeps headings and markers", T, async () => {
	process.env.DOC_TO_MD_FORCE_DOCX_FALLBACK = "1";
	try {
		const r = await convertDocument(opts(fx("headings.docx"), { outputDir: tmp }));
		assert.match(r.output, /Engine: python-docx   Tier: docx/);
		assert.match(r.output, /^Degraded: python-docx text extraction - footnotes, hyperlinks, images not preserved$/m);
		assert.match(r.output, /^Fallback-Reason: mammoth RuntimeError: forced by DOC_TO_MD_FORCE_DOCX_FALLBACK$/m);
		const md = readFileSync(parseHandle(r.output)["Saved-To"], "utf8");
		assert.deepStrictEqual(markers(md), [1, 2, 3]);
		assert.match(md, /^# Chapter One$/m);
	} finally { delete process.env.DOC_TO_MD_FORCE_DOCX_FALLBACK; }
});

test("docx info: metadata, paged TOC, no headings, and no soffice dependency", T, async () => {
	const saved = process.env.PATH;
	process.env.PATH = NO_SOFFICE_ENV().PATH;
	try {
		const i = await inspectDocument(opts(fx("headings.docx"), { info: true }));
		assert.match(i.output, /^Type: docx   Page-Count: 3   Backend: (uv|python|venv)$/m);
		assert.match(i.output, /Title: Headings Fixture   Author: pi-quiver tests/);
		assert.match(i.output, /Created: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
		assert.ok(i.output.includes("TOC:\n  L1 Chapter One (p1)\n  L2 Section A (p1)\n  L3 Detail A1 (p1)\n  L1 Chapter Two (p1)\n  L1 Continued (p2)"), i.output);
		const s = await inspectDocument(opts(fx("sample.docx"), { info: true }));
		assert.match(s.output, /^Type: docx   Page-Count: 1   Backend: /m);
		assert.ok(s.output.split("\n").includes("TOC: none (no heading styles found)"));
	} finally { process.env.PATH = saved; }
});

test("pptx --pages 3", { ...T, skip: T.skip || (!HAS_SOFFICE && "soffice not on PATH") }, async () => {
	const r = await convertDocument(opts(fx("multislide.pptx"), { pages: "3", outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.includes("SLIDE-3"));
	assert.ok(!md.includes("SLIDE-1") && !md.includes("SLIDE-2") && !md.includes("SLIDE-4"));
});

test("workbook.xlsx: preamble, dual formula display, disclosures, 0-based image names, CSVs", T, async () => {
	const r = await convertDocument(opts(fx("workbook.xlsx"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.includes("# workbook\n\n## Sheets\n| # | name | kind | size |"));
	assert.ok(md.includes("## Data") && md.includes("| | A | B | C |"));
	assert.match(md, /\| 18 \|.*42 \(=D17\*2\)/);
	assert.match(md, /\(no cached result\) \(=SUM\(A2:A20\)\)/);
	assert.ok(md.includes("pipe\\|in\\|text"));
	assert.ok(md.includes("Merged: A1:C1") && md.includes("Hidden rows: 4") && md.includes("Hidden cols: F"));
	assert.ok(md.includes("## Hidden\nHidden sheet"));
	assert.match(md, /## Settings[\s\S]*\| 17 \|.*threshold \| 42/);
	const imgs = readdirSyncSafe(join(dirname(h["Saved-To"]), "images"));
	assert.ok(imgs.includes("workbook-s0-1.png") && imgs.some((f) => f.startsWith("workbook-s2-")) && imgs.some((f) => f.startsWith("workbook-s3-")));
	const csvs = readdirSyncSafe(h["Sheets-Dir"]);
	assert.deepStrictEqual(csvs.sort(), ["workbook-s0-data.csv", "workbook-s1-settings.csv", "workbook-s2-a-b.csv", "workbook-s3-a-b.csv", "workbook-s4-hidden.csv"]);
	assert.match(r.output, /Engine: openpyxl   Tier: excel/);
	assert.ok(r.output.includes("## Sheets") && r.output.includes("## Data"));
});

test("charts.xlsx: chartsheets in inventory, preview/profile, CSVs, rendered views with soffice", { ...T, skip: T.skip || (!HAS_SOFFICE && "soffice not on PATH") }, async () => {
	const r = await convertDocument(opts(fx("charts.xlsx"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.includes("| 0 | Data | worksheet | 200 x 3 | no | 1 | 1 | yes | [sheets/charts-s0-data.csv](sheets/charts-s0-data.csv) |"));
	assert.ok(md.includes("| 1 | Empty | worksheet | 0 x 0 | no | 0 | 0 | - | - |"));
	assert.ok(md.includes("| 2 | Aux | worksheet | 10 x 2 | yes | 0 | 0 | - | [sheets/charts-s2-aux.csv](sheets/charts-s2-aux.csv) |"));
	assert.ok(md.includes("| 3 | Trends | chartsheet | - | no | 1 | 0 | yes | - |") && md.includes("| 4 | Bars | chartsheet | - | no | 1 | 0 | yes | - |"));
	assert.ok(md.includes("| 5 | Wide | worksheet | 300 x 80 | no | 0 | 0 | - | [sheets/charts-s5-wide.csv](sheets/charts-s5-wide.csv) |"));
	assert.equal((md.match(/^Rendered view: !\[Rendered view of sheet \d\]\(images\/charts-s\d\.png\)$/gm) ?? []).length, 3);
	assert.ok(md.includes("## Data\nData: [sheets/charts-s0-data.csv](sheets/charts-s0-data.csv) - 200 rows x 3 cols, 199 formulas"));
	assert.ok(md.includes("## Wide\nData: [sheets/charts-s5-wide.csv](sheets/charts-s5-wide.csv) - 300 rows x 80 cols"));
	assert.ok(md.includes("Preview (rows 1-100 of 200, cols A-C of 3) - full data in the CSV above:"));
	assert.ok(md.includes("| | A | B | C |\n|---|---|---|---|\n| 1 | Step | North | Double |"));
	assert.ok(md.includes("Preview (rows 1-100 of 300, cols A-AX of 80) - full data in the CSV above:"));
	const wideSection = md.match(/## Wide\n([\s\S]*)$/)?.[1] ?? "";
	const columnRows = wideSection.match(/Columns:\n\| col \| header \| type \| non-empty \| min \| max \| distinct \|\n\|---\|---\|---\|---\|---\|---\|---\|\n([\s\S]*?)\n?$/)?.[1].split("\n") ?? [];
	assert.equal(columnRows.length, 80);
	assert.ok(columnRows.includes("| B | C2 | float | 300 | 0.143 | 42.714 | >50 |"));
	assert.ok(columnRows.includes("| D | C4 | date | 300 | 2026-01-03T00:00:00 | 2026-10-28T00:00:00 | >50 |"));
	assert.ok(columnRows.includes("| A | C1 | int | 300 | 1 | 299 | >50 |") && columnRows.includes("| C | C3 | str | 300 | - | - | 5 |"));
	const widePreviewHeader = wideSection.match(/Preview \(rows 1-100 of 300, cols A-AX of 80\)[^\n]*:\n(\| \|[^\n]+\|)/)?.[1] ?? "";
	assert.deepStrictEqual(widePreviewHeader.match(/[A-Z]+/g), Array.from({ length: 50 }, (_, i) => columnLetter(i + 1)));
	assert.ok(md.includes("## Aux\nHidden sheet\nData: [sheets/charts-s2-aux.csv](sheets/charts-s2-aux.csv) - 10 rows x 2 cols\n\nContent (10 rows x 2 cols):"));
	assert.ok(!/## Aux[\s\S]*?Columns:[\s\S]*?## Trends/.test(md));
	assert.ok(md.includes("## Data\n") && /## Data\n[\s\S]*?Rendered view: !\[Rendered view of sheet 0\]\(images\/charts-s0\.png\)[\s\S]*?## Empty/.test(md));
	assert.ok(md.includes("## Trends (chartsheet)\nCharts:\n- LineChart \"Synthetic trends\" - 1 series ('Data'!$B$2:$B$200)\nRendered view: ![Rendered view of sheet 3](images/charts-s3.png)"));
	assert.ok(/## Bars \(chartsheet\)[\s\S]*?Rendered view: !\[Rendered view of sheet 4\]\(images\/charts-s4\.png\)[\s\S]*?## Wide/.test(md));
	assert.ok(h["Images-Dir"]);
	assert.equal(h["Images-Dir"], join(dirname(h["Saved-To"]), "images"));
	const imgs = readdirSyncSafe(h["Images-Dir"]);
	assert.deepStrictEqual(imgs.filter((f) => /^charts-s\d\.png$/.test(f)).sort(), ["charts-s0.png", "charts-s3.png", "charts-s4.png"]);
	for (const f of ["charts-s0.png", "charts-s3.png", "charts-s4.png"]) {
		const probe = spawnSync("uv", ["run", "--with", "pymupdf==1.27.2.3", "--python", "3.14", "python", "-c", `import pymupdf,sys; p=pymupdf.Pixmap(sys.argv[1]); print(p.width, p.height, len(set(p.samples[i:i+p.n] for i in range(0, len(p.samples), p.n * 97))))`, join(dirname(h["Saved-To"]), "images", f)], { encoding: "utf8" });
		const [w, hh, colors] = probe.stdout.trim().split(" ").map(Number);
		assert.ok(w >= 200 && hh >= 200 && colors > 1, `${f}: ${probe.stdout} ${probe.stderr}`);
	}
	const csvs = readdirSyncSafe(h["Sheets-Dir"]);
	assert.deepStrictEqual(csvs.sort(), ["charts-s0-data.csv", "charts-s2-aux.csv", "charts-s5-wide.csv"]);
	const dataCsv = readFileSync(join(h["Sheets-Dir"], "charts-s0-data.csv"), "utf8").split("\r\n");
	const auxCsv = readFileSync(join(h["Sheets-Dir"], "charts-s2-aux.csv"), "utf8").split("\r\n");
	const wideCsv = readFileSync(join(h["Sheets-Dir"], "charts-s5-wide.csv"), "utf8").split("\r\n");
	assert.equal(dataCsv.length, 201);
	assert.equal(auxCsv.length, 11);
	assert.equal(wideCsv.length, 301);
	assert.equal(dataCsv[0].split(",").length, 3);
	assert.equal(auxCsv[0].split(",").length, 2);
	assert.equal(wideCsv[0].split(",").length, 80);
	assert.ok(dataCsv[1].includes("=A2*2"));
	assert.ok(wideCsv.some((row) => row.includes("2026-01-03")));
	assert.ok(!r.output.includes("Rendered views skipped"));
});

test("charts-zero-extent.xlsx: degenerate chartsheet page degrades with a named reason", { ...T, skip: T.skip || (!HAS_SOFFICE && "soffice not on PATH") }, async () => {
	const r = await convertDocument(opts(fx("charts-zero-extent.xlsx"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.match(md, /Rendered view: unavailable \(rendered view degenerate \(page \d+ x \d+ pt\)\)/);
	assert.ok(md.includes("| 1 | Chart | chartsheet | - | no | 1 | 0 | no | - |"));
	assert.ok(r.output.includes("Rendered views: 1 of 1 unavailable"));
});

test("charts.xlsx without soffice on PATH: same Markdown minus rendered views, success", T, async () => {
	const saved = process.env.PATH;
	process.env.PATH = NO_SOFFICE_ENV().PATH;
	try {
		const r = await convertDocument(opts(fx("charts.xlsx"), { outputDir: join(tmp, "nosoffice") }));
		const h = parseHandle(r.output);
		const md = linksResolve(h["Saved-To"]);
		assert.equal((md.match(/^Rendered view: unavailable \(LibreOffice not found\)$/gm) ?? []).length, 3);
		assert.ok(md.includes("| 0 | Data | worksheet | 200 x 3 | no | 1 | 1 | no |") && md.includes("| 3 | Trends | chartsheet | - | no | 1 | 0 | no | - |"));
		assert.ok(md.includes("| 4 | Bars | chartsheet | - | no | 1 | 0 | no | - |"));
		assert.ok(md.includes("| 1 | Empty | worksheet | 0 x 0 | no | 0 | 0 | - | - |"));
		assert.ok(md.includes("| 2 | Aux | worksheet | 10 x 2 | yes | 0 | 0 | - |"));
		assert.ok(md.includes("| 5 | Wide | worksheet | 300 x 80 | no | 0 | 0 | - |"));
		assert.ok(!readdirSyncSafe(join(dirname(h["Saved-To"]), "images")).some((f) => /^charts-s\d\.png$/.test(f)));
		assert.ok(r.output.includes("Rendered views skipped: LibreOffice not found"));
		assert.deepStrictEqual(readdirSyncSafe(h["Sheets-Dir"]).sort(), ["charts-s0-data.csv", "charts-s2-aux.csv", "charts-s5-wide.csv"]);
	} finally { process.env.PATH = saved; }
});

test("charts.xlsx --info: six sheets with kinds and counts", T, async () => {
	const r = await inspectDocument(opts(fx("charts.xlsx"), { info: true }));
	assert.match(r.output, /^Type: xlsx   Sheets: 6$/m);
	assert.match(r.output, /^  Data  worksheet rows=200 cols=3 charts=1 images=1$/m);
	assert.match(r.output, /^  Empty  worksheet rows=1 cols=1 charts=0 images=0$/m);
	assert.match(r.output, /^  Aux  hidden worksheet rows=10 cols=2 charts=0 images=0$/m);
	assert.match(r.output, /^  Wide  worksheet rows=300 cols=80 charts=0 images=0$/m);
	assert.match(r.output, /^  Trends  chartsheet rows=- cols=- charts=1 images=0$/m);
	assert.match(r.output, /^  Bars  chartsheet rows=- cols=- charts=1 images=0$/m);
});

test("workbook.xlsx --info: dims and hidden counts in the new line format", T, async () => {
	const r = await inspectDocument(opts(fx("workbook.xlsx"), { info: true }));
	assert.match(r.output, /^Type: xlsx   Sheets: 5/m);
	assert.match(r.output, /^  Data  worksheet rows=\d+ cols=\d+ charts=0 images=1 hiddenRows=1 hiddenCols=1$/m);
	assert.match(r.output, /^  Hidden  hidden worksheet .+$/m);
});

test("workbook.xlsx --pages 1 rejects unstable worksheet page numbering", T, async () => {
	await assert.rejects(convertDocument(opts(fx("workbook.xlsx"), { pages: "1", outputDir: tmp })), /worksheets have no stable page numbering/);
});

test("legacy.xls: preamble, CSV, workbook-level unavailable line, disclosures, error cells", T, async () => {
	const r = await convertDocument(opts(fx("legacy.xls"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.includes("Rendered views: unavailable (visual detection not supported for .xls)"));
	assert.ok(r.output.includes("Notes: Rendered views: unavailable (visual detection not supported for .xls)"));
	assert.ok(md.includes("| 0 | Legacy | worksheet | 6 x 4 | no | 0 | 0 | - | [sheets/legacy-s0-legacy.csv](sheets/legacy-s0-legacy.csv) |"));
	assert.ok(md.includes("Formulas: unavailable (.xls via xlrd); Images: unavailable"));
	assert.ok(md.includes("Merged: A1:C1") && md.includes("Hidden rows: 4") && md.includes("Hidden cols: B"));
	assert.ok(md.includes("#DIV/0!") && !md.includes("<!--rv"));
	assert.deepStrictEqual(readdirSyncSafe(h["Sheets-Dir"]), ["legacy-s0-legacy.csv"]);
	const csv = readFileSync(join(h["Sheets-Dir"], "legacy-s0-legacy.csv"), "utf8").split("\r\n");
	assert.equal(csv.length, 7);
	assert.ok(csv.some((row) => row.includes("#DIV/0!")));
	assert.match(r.output, /Engine: xlrd   Tier: excel/);
});

test("Excel stall (excelTimeoutMs 1) -> remedy error, lock released", T, async () => {
	const before = process.platform === "win32" ? null : excelPids();
	await assert.rejects(convertDocument(opts(fx("workbook.xlsx"), { excelTimeoutMs: 1, outputDir: tmp })), /Remedy: raise excelTimeoutMs/);
	assert.ok(!existsSync(join(tmp, "workbook.md.lock")));
	if (before) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		const survivors = [...excelPids()].filter((pid) => !before.has(pid));
		assert.deepStrictEqual(survivors, [], "Excel child survived timeout");
	}
});

const SHORT = () => fx("short-text-ocr.pdf");
const skipUnavailable = async <T,>(t: { skip: (m: string) => void }, run: () => Promise<T>): Promise<T | null> => {
	try { return await run(); } catch (e) { if (/OCR unavailable|no Python backend/.test((e as Error).message)) { t.skip((e as Error).message); return null; } throw e; }
};

test("short-text-ocr.pdf --ocr default: no OCR on either page; pages.json reports the thin page", T, async () => {
	const r = await convertDocument(opts(SHORT(), { ocr: true, outputDir: tmp }));
	assert.deepStrictEqual(r.details.ocr?.pages ?? [], []);
	const md = readFileSync(r.details.savedTo, "utf8");
	assert.ok(!md.includes("Text recognized"), md);
	assert.match(md.split("--- end of page.page_number=1 ---")[1], /^3$/m);
	const h = parseHandle(r.output);
	assert.strictEqual(h["Page-Stats"], join(tmp, "short-text-ocr.pages.json"));
	const stats = JSON.parse(readFileSync(h["Page-Stats"], "utf8")) as Extract<PageStat, { chars: number }>[];
	assert.strictEqual(stats.length, 2);
	assert.ok(stats[0].chars >= 200 && stats[0].images === 0, JSON.stringify(stats[0]));
	assert.ok(stats[1].chars === 1 && stats[1].images === 1 && stats[1].imageCoverage >= 0.9, JSON.stringify(stats[1]));
	assert.deepStrictEqual(r.details.pageStats, stats);
});

test("short-text-ocr.pdf --ocr --ocr-mode all --pages 2: sidecar with the known words, Markdown byte-identical", T, async (t) => {
	const plain = await convertDocument(opts(SHORT(), { pages: "2", outputDir: join(tmp, "plain") }));
	const r = await skipUnavailable(t, () => convertDocument(opts(SHORT(), { ocr: true, ocrMode: "all", pages: "2", outputDir: join(tmp, "forced") })));
	if (!r) return;
	const sidecar = join(tmp, "forced", "ocr", "short-text-ocr-p002.md");
	assert.ok(existsSync(sidecar), r.output);
	const text = readFileSync(sidecar, "utf8");
	assert.ok(text.startsWith("<!-- OCR of page 2 (tesseract eng); recognized text, not the text layer -->\n\n"), text);
	assert.match(text, /Hello OCR world 12345/);
	assert.ok(text.trimEnd().endsWith("--- end of page.page_number=2 ---"), text);
	assert.deepStrictEqual([r.details.ocr!.mode, r.details.ocr!.pages, r.details.ocr!.textless, r.details.ocr!.sidecars[2]], ["all", [2], [], sidecar]);
	assert.ok(readFileSync(r.details.savedTo).equals(readFileSync(plain.details.savedTo)));
	assert.strictEqual(parseHandle(r.output)["OCR-Dir"], join(tmp, "forced", "ocr"));
});

test("scan.pdf --ocr --ocr-mode all --pages 1: textless page keeps the picture link only, one sidecar, textless reported", T, async (t) => {
	const plain = await convertDocument(opts(fx("scan.pdf"), { pages: "1", outputDir: join(tmp, "plain") }));
	const r = await skipUnavailable(t, () => convertDocument(opts(fx("scan.pdf"), { ocr: true, ocrMode: "all", pages: "1", outputDir: join(tmp, "forced") })));
	if (!r) return;
	assert.ok(readFileSync(r.details.savedTo).equals(readFileSync(plain.details.savedTo)));
	assert.ok(!readFileSync(r.details.savedTo, "utf8").includes("Text recognized"));
	assert.deepStrictEqual([r.details.ocr!.textless, Object.keys(r.details.ocr!.sidecars)], [[1], ["1"]]);
	assert.match(readFileSync(r.details.ocr!.sidecars[1], "utf8"), /Hello OCR world 12345/);
});

test("ocr-mode all after a forced pdf-fallback tier still produces sidecars", T, async (t) => {
	const seams: Partial<PipelineSeams> = { runTier: (mode, ...rest) => mode === "pdf-primary" ? Promise.resolve({ ok: false, reason: "timeout after 1ms" }) : runTierReal(mode, ...rest) };
	const r = await skipUnavailable(t, () => convertDocument(opts(SHORT(), { ocr: true, ocrMode: "all", pages: "2", outputDir: tmp }), undefined, seams));
	if (!r) return;
	assert.match(r.output, /Tier: fallback/);
	assert.ok(existsSync(join(tmp, "ocr", "short-text-ocr-p002.md")));
	assert.deepStrictEqual(r.details.ocr!.pages, [2]);
});

test("ocr-mode all: a wedged sidecar child is killed at the deadline; page 1 named, page 2 not attempted, Markdown intact", T, async (t) => {
	const seams: Partial<PipelineSeams> = { runTier: (mode, co, b, signal, timeoutMs, backend) => runTierReal(mode, co, b, signal, mode === "ocr-pages" ? 3000 : timeoutMs, backend) };
	const plain = await convertDocument(opts(SHORT(), { pages: "1,2", outputDir: join(tmp, "plain") }));
	const previous = process.env.DOC_TO_MD_OCR_STALL_PAGE;
	process.env.DOC_TO_MD_OCR_STALL_PAGE = "1";
	try {
		const r = await skipUnavailable(t, () => convertDocument(opts(SHORT(), { ocr: true, ocrMode: "all", pages: "1,2", outputDir: tmp, words: true }), undefined, seams));
		if (!r) return;
		assert.ok(!existsSync(join(tmp, "ocr", "short-text-ocr-p001.md")));
		assert.ok(!existsSync(join(tmp, "ocr", "short-text-ocr-p001.words.json")));
		assert.ok(!Object.hasOwn(r.details.ocr!.wordSidecars, 1));
		assert.deepStrictEqual([r.details.ocr!.killed, r.details.ocr!.notAttempted, r.details.ocr!.pages, r.details.ocrDir], [1, [2], [], null]);
		assert.deepStrictEqual(existsSync(join(tmp, "ocr")) ? readdirSync(join(tmp, "ocr")) : [], []);
		assert.ok(existsSync(r.details.savedTo) && !existsSync(`${r.details.savedTo}.lock`));
		assert.ok(readFileSync(r.details.savedTo).equals(readFileSync(plain.details.savedTo)));
		assert.match(r.output, /page 1 killed the OCR child \(timeout or crash - likely a compression bomb\); page 2 not attempted - re-run with --pages 2/);
	} finally {
		if (previous === undefined) delete process.env.DOC_TO_MD_OCR_STALL_PAGE;
		else process.env.DOC_TO_MD_OCR_STALL_PAGE = previous;
	}
});

const words = (r: { details: { wordsPath: string | null } }) => {
	assert.ok(r.details.wordsPath, "words document published");
	return JSON.parse(readFileSync(r.details.wordsPath, "utf8"));
};

test("CLI subprocess: --json --words publishes the geometry words path", T, () => {
	const bin = fileURLToPath(new URL("../bin/pi-quiver.ts", import.meta.url));
	const result = spawnSync(process.execPath, [bin, "doc-to-md", "--json", "--words", "--pages", "1", fx("multipage.pdf"), "--output-dir", tmp], { encoding: "utf8", timeout: T.timeout });
	assert.strictEqual(result.status, 0, result.error?.message ?? result.stderr);
	const h = JSON.parse(result.stdout);
	assert.strictEqual(typeof h.wordsPath, "string");
	assert.strictEqual(h.wordsPath, join(tmp, "multipage.words.json"));
	assert.ok(existsSync(h.wordsPath));
	assert.strictEqual(h.wordsReason, null);
});

test("words: multipage p1 has 13 text words, unchanged Markdown, fallback parity, no file without --words", T, async () => {
	const plain = await convertDocument(opts(fx("multipage.pdf"), { pages: "1", outputDir: join(tmp, "plain") }));
	assert.equal(plain.details.wordsPath, null);
	assert.ok(!existsSync(join(tmp, "plain", "multipage.words.json")));
	const r = await convertDocument(opts(fx("multipage.pdf"), { pages: "1", outputDir: join(tmp, "w"), words: true }));
	assert.equal(parseHandle(r.output)["Words"], join(tmp, "w", "multipage.words.json"));
	assert.ok(readFileSync(r.details.savedTo).equals(readFileSync(plain.details.savedTo)));
	const w = words(r);
	assert.equal(w.unit, "pt");
	assert.equal(w.pages.length, 1);
	assert.deepEqual([w.pages[0].page, w.pages[0].width, w.pages[0].height, w.pages[0].rotation, w.pages[0].words.length], [1, 595, 842, 0, 13]);
	const probe = spawnSync("uv", ["run", "--with", `pymupdf==${TUNABLE_DEFAULTS.pymupdfVersion}`, "--python", "3.14", "python", "-c", "import pymupdf,json,sys; print(json.dumps(pymupdf.open(sys.argv[1])[0].get_text('text').split()))", fx("multipage.pdf")], { encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	assert.deepEqual(w.pages[0].words.map((x: any) => x.text), JSON.parse(probe.stdout));
	for (const x of w.pages[0].words) {
		assert.equal(x.source, "text");
		assert.ok(x.bbox[0] >= 0 && x.bbox[1] >= 0 && x.bbox[2] <= 595 && x.bbox[3] <= 842, JSON.stringify(x));
	}
	const fb = await convertDocument(opts(fx("multipage.pdf"), { pages: "1", primaryTimeoutMs: 1, outputDir: join(tmp, "fb"), words: true }));
	assert.match(fb.output, /Tier: fallback/);
	assert.deepEqual(words(fb).pages[0].words.map((x: any) => x.text), w.pages[0].words.map((x: any) => x.text));
});

test("words: rotated display space on both tiers; blank empty and omitted when OCR unavailable", T, async () => {
	for (const [dir, extra] of [["p", {}], ["f", { primaryTimeoutMs: 1 }]] as const) {
		const r = await convertDocument(opts(fx("rotated.pdf"), { outputDir: join(tmp, dir), words: true, ...extra }));
		assert.match(r.output, dir === "p" ? /Tier: primary/ : /Tier: fallback/);
		const p = words(r).pages[0];
		assert.deepEqual([p.width, p.height, p.rotation, p.words[0].text], [792, 612, 90, "NORTH"]);
		assert.ok(Math.abs(p.words[0].bbox[0] - 720) <= 10 && Math.abs(p.words[0].bbox[1] - 72) <= 10, `rotated.pdf: ${p.words[0].bbox}`);
	}
	const b = await convertDocument(opts(fx("blank.pdf"), { outputDir: join(tmp, "b"), words: true }));
	assert.deepEqual(words(b).pages, [{ page: 1, width: 595, height: 842, rotation: 0, words: [] }]);
	const prev = process.env.TESSDATA_PREFIX;
	process.env.TESSDATA_PREFIX = join(tmp, "none");
	try {
		const o = await convertDocument(opts(fx("blank.pdf"), { outputDir: join(tmp, "bo"), ocr: true, words: true }));
		assert.equal(o.details.ocr?.status, "unavailable");
		assert.deepEqual(words(o).pages, []);
	} finally {
		if (prev === undefined) delete process.env.TESSDATA_PREFIX;
		else process.env.TESSDATA_PREFIX = prev;
	}
});

test("words + ocr: scan picture coordinates, image pixels, and empty words without OCR", T, async (t) => {
	const off = await convertDocument(opts(fx("scan.pdf"), { pages: "1", outputDir: join(tmp, "off"), words: true }));
	assert.deepEqual(words(off).pages[0].words, []);
	const imgOff = await convertDocument(opts(fx("ocr.png"), { outputDir: join(tmp, "imgoff"), words: true }));
	assert.equal(words(imgOff).pages.length, 1);
	assert.deepEqual(words(imgOff).pages[0].words, []);
	assert.equal(words(imgOff).unit, "px");
	const r = await convertDocument(opts(fx("scan.pdf"), { pages: "1", outputDir: join(tmp, "scan"), ocr: true, words: true }));
	if (r.details.ocr?.status === "unavailable") { t.skip(`OCR unavailable: ${r.details.ocr.reason}`); return; }
	assert.equal(r.details.ocr?.status, "ran");
	const p = words(r).pages[0];
	assert.deepEqual(p.words.map((x: any) => x.text), ["Hello", "OCR", "world", "12345"]);
	assert.ok(p.words.every((x: any) => x.source === "ocr" && x.bbox[0] >= 36 && x.bbox[1] >= 72 && x.bbox[2] <= 576 && x.bbox[3] <= 175), JSON.stringify(p.words));
	assert.ok(Math.abs(p.words[0].bbox[0] - 51) <= 10, `scan.pdf: ${p.words[0].bbox}`);
	const img = await convertDocument(opts(fx("ocr.png"), { outputDir: join(tmp, "img"), ocr: true, words: true }));
	if (img.details.ocr?.status === "unavailable") { t.skip(`OCR unavailable: ${img.details.ocr.reason}`); return; }
	assert.equal(img.details.ocr?.status, "ran");
	const iw = words(img);
	assert.equal(iw.unit, "px");
	const png = readFileSync(fx("ocr.png"));
	assert.equal(iw.pages[0].width, png.readUInt32BE(16));
	assert.equal(iw.pages[0].height, png.readUInt32BE(20));
	assert.deepEqual(iw.pages[0].words.map((x: any) => x.text), ["Hello", "OCR", "world", "12345"]);
	assert.ok(iw.pages[0].words.every((x: any) => x.source === "ocr" && x.bbox[0] >= 0 && x.bbox[1] >= 0 && x.bbox[2] <= iw.pages[0].width && x.bbox[3] <= iw.pages[0].height), JSON.stringify(iw.pages[0].words));
	assert.ok(Math.abs(iw.pages[0].words[0].bbox[0] - 33) <= 15, `ocr.png: ${iw.pages[0].words[0].bbox}`);
});

test("words + ocr-mode all: native main words, OCR word sidecars, pre-OCRed text layer", T, async (t) => {
	const r = await skipUnavailable(t, () => convertDocument(opts(SHORT(), { ocr: true, ocrMode: "all", pages: "2", outputDir: join(tmp, "short"), words: true })));
	if (!r) return;
	assert.deepEqual(words(r).pages[0].words.map((x: any) => [x.text, x.source]), [["3", "text"]]);
	assert.equal(r.details.ocr!.wordSidecars[2], join(tmp, "short", "ocr", "short-text-ocr-p002.words.json"));
	const side = JSON.parse(readFileSync(r.details.ocr!.wordSidecars[2], "utf8"));
	assert.equal(side.page, 2);
	assert.deepEqual(side.words.map((x: any) => x.text), ["3", "Hello", "OCR", "world", "12345"]);
	assert.ok(side.words.every((x: any) => x.source === "ocr"));
	const native = await convertDocument(opts(fx("pre-ocr.pdf"), { pages: "1", outputDir: join(tmp, "native"), words: true }));
	assert.equal(words(native).pages[0].words.length, 4);
	assert.ok(words(native).pages[0].words.every((x: any) => x.source === "text"));
	const pre = await skipUnavailable(t, () => convertDocument(opts(fx("pre-ocr.pdf"), { ocr: true, ocrMode: "all", pages: "1", outputDir: join(tmp, "pre"), words: true })));
	if (!pre) return;
	assert.deepEqual(words(pre).pages[0].words, words(native).pages[0].words);
	const preSide = JSON.parse(readFileSync(pre.details.ocr!.wordSidecars[1], "utf8"));
	assert.equal(preSide.words.length, 4);
	assert.ok(preSide.words.every((x: any) => x.source === "ocr"));
});

test("words: mixed pages resolve every word; injected failure preserves Markdown, stats, notes and OCR", T, async (t) => {
	const r = await convertDocument(opts(SHORT(), { pages: "2", outputDir: join(tmp, "mix"), words: true }));
	assert.deepEqual(words(r).pages[0].words.map((x: any) => [x.text, x.source]), [["3", "text"]]);
	const s2 = await convertDocument(opts(fx("scan.pdf"), { pages: "2", outputDir: join(tmp, "s2"), ocr: true, words: true }));
	assert.equal(words(s2).pages[0].words.length, 5);
	assert.ok(words(s2).pages[0].words.every((x: any) => x.source === "text"));
	for (const [fixture, result] of [[SHORT(), r], [fx("scan.pdf"), s2]] as const) {
		const probe = spawnSync("uv", ["run", "--with", `pymupdf==${TUNABLE_DEFAULTS.pymupdfVersion}`, "--python", "3.14", "python", "-c", "import pymupdf,json,sys; print(json.dumps([w[4] for w in pymupdf.open(sys.argv[1])[1].get_text('words')]))", fixture], { encoding: "utf8" });
		assert.equal(probe.status, 0, probe.stderr);
		assert.deepEqual(words(result).pages[0].words.map((x: any) => x.text), JSON.parse(probe.stdout));
	}
	const clean = await convertDocument(opts(fx("scan.pdf"), { pages: "1", outputDir: join(tmp, "clean"), ocr: true, words: true }));
	if (clean.details.ocr?.status === "unavailable") { t.skip(`OCR unavailable: ${clean.details.ocr.reason}`); return; }
	assert.equal(clean.details.ocr?.status, "ran");
	const previous = process.env.DOC_TO_MD_WORDS_FAIL;
	process.env.DOC_TO_MD_WORDS_FAIL = "1";
	try {
		const bad = await convertDocument(opts(fx("scan.pdf"), { pages: "1", outputDir: join(tmp, "bad"), ocr: true, words: true }));
		if (bad.details.ocr?.status === "unavailable") { t.skip(`OCR unavailable: ${bad.details.ocr.reason}`); return; }
		assert.equal(bad.details.ocr?.status, "ran");
		assert.ok(readFileSync(bad.details.savedTo).equals(readFileSync(clean.details.savedTo)));
		assert.deepEqual(bad.details.pageStats, clean.details.pageStats);
		assert.deepEqual(bad.details.ocr, clean.details.ocr);
		assert.deepEqual(bad.details.notes, clean.details.notes);
		assert.match(bad.details.wordsErrors[1], /words injected failure/);
		assert.deepEqual(words(bad).pages, []);
		assert.match(bad.output, /^Words: .*scan\.words\.json \(extraction failed for pages 1: RuntimeError: words injected failure\)$/m);
	} finally {
		if (previous === undefined) delete process.env.DOC_TO_MD_WORDS_FAIL;
		else process.env.DOC_TO_MD_WORDS_FAIL = previous;
	}
});

test("words + ocr-mode all: injected word failure preserves the Markdown sidecar and OCR outcome", T, async (t) => {
	const clean = await skipUnavailable(t, () => convertDocument(opts(SHORT(), { ocr: true, ocrMode: "all", pages: "2", outputDir: join(tmp, "clean"), words: true })));
	if (!clean) return;
	const previous = process.env.DOC_TO_MD_WORDS_FAIL;
	process.env.DOC_TO_MD_WORDS_FAIL = "2";
	try {
		const bad = await skipUnavailable(t, () => convertDocument(opts(SHORT(), { ocr: true, ocrMode: "all", pages: "2", outputDir: join(tmp, "bad"), words: true })));
		if (!bad) return;
		const sidecar = join(tmp, "bad", "ocr", "short-text-ocr-p002.md");
		assert.equal(bad.details.ocr!.sidecars[2], sidecar);
		assert.ok(existsSync(sidecar));
		assert.ok(readFileSync(sidecar).equals(readFileSync(clean.details.ocr!.sidecars[2])));
		assert.ok(!Object.hasOwn(bad.details.ocr!.wordSidecars, 2));
		assert.ok(!existsSync(join(tmp, "bad", "ocr", "short-text-ocr-p002.words.json")));
		assert.match(bad.details.wordsErrors[2], /words injected failure/);
		assert.deepEqual(words(clean).pages.map((p: any) => p.page), [2]);
		assert.deepEqual(words(bad).pages, []);
		assert.ok(readFileSync(bad.details.savedTo).equals(readFileSync(clean.details.savedTo)));
		assert.deepEqual(bad.details.pageStats, clean.details.pageStats);
		assert.deepEqual(bad.details.notes, clean.details.notes);
		const { sidecars: cleanSidecars, wordSidecars: cleanWordSidecars, ...cleanOutcome } = clean.details.ocr!;
		const { sidecars: badSidecars, wordSidecars: badWordSidecars, ...badOutcome } = bad.details.ocr!;
		assert.deepEqual(badOutcome, cleanOutcome);
	} finally {
		if (previous === undefined) delete process.env.DOC_TO_MD_WORDS_FAIL;
		else process.env.DOC_TO_MD_WORDS_FAIL = previous;
	}
});

test("words: payload never crosses the capped child stdout", T, async (t) => {
	const r = await convertDocument(opts(fx("multipage.pdf"), { outputDir: join(tmp, "cap0"), words: true }));
	const wordsBytes = statSync(r.details.wordsPath!).size;
	const maxOutputBytes = wordsBytes - 1;
	t.diagnostic(`wordsBytes=${wordsBytes}; markdownBytes=${r.details.bytes}; maxOutputBytes=${maxOutputBytes}; markdownPlusOverhead=${r.details.bytes + 4096}`);
	assert.ok(maxOutputBytes > r.details.bytes + 4096);
	const capped = await convertDocument(opts(fx("multipage.pdf"), { outputDir: join(tmp, "cap1"), words: true, maxOutputBytes }));
	assert.ok(capped.details.wordsPath);
	assert.equal(capped.details.wordsPath, join(tmp, "cap1", "multipage.words.json"));
	assert.match(capped.output, /Tier: primary/);
	assert.equal(statSync(capped.details.wordsPath!).size, wordsBytes);
});

test("words: unsupported type and image copy route report reasons without a file", T, async () => {
	const d = await convertDocument(opts(fx("sample.docx"), { outputDir: join(tmp, "docx"), words: true }));
	assert.equal(parseHandle(d.output)["Words"], "none - word positions apply to PDF and image inputs only (docx)");
	assert.equal(d.details.wordsPath, null);
	assert.ok(!existsSync(join(tmp, "docx", "sample.words.json")));
	const seams: Partial<PipelineSeams> = { runTier: (mode, ...rest) => mode === "image" ? Promise.resolve({ ok: false, reason: "boom" }) : runTierReal(mode, ...rest) };
	const plain = await convertDocument(opts(fx("ocr.png"), { outputDir: join(tmp, "plain-copy") }), undefined, seams);
	const c = await convertDocument(opts(fx("ocr.png"), { outputDir: join(tmp, "copy"), words: true }), undefined, seams);
	assert.equal(c.details.engine, "copy");
	assert.equal(c.details.wordsPath, null);
	assert.ok(!existsSync(join(tmp, "copy", "ocr.words.json")));
	assert.match(parseHandle(c.output)["Words"], /^none - image copied without conversion \(/);
	assert.ok(readFileSync(c.details.savedTo).equals(readFileSync(plain.details.savedTo)));
});

function readdirSyncSafe(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

function columnLetter(column: number): string {
	let result = "";
	for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
	return result;
}
