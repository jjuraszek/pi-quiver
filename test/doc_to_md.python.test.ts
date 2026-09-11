import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertDocument, inspectDocument, resetBackendCacheForTests, resolveOptions } from "../lib/doc-to-md-core.ts";

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

test("docx info + pages + bounds", { ...T, skip: T.skip || (!HAS_SOFFICE && "soffice not on PATH") }, async () => {
	const i = await inspectDocument(opts(fx("multipage.docx"), { info: true }));
	assert.match(i.output, /Type: docx   Page-Count: 5/);
	const r = await convertDocument(opts(fx("multipage.docx"), { pages: "2", outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.includes("PAGE-2") && !md.includes("PAGE-1") && !md.includes("PAGE-3"));
	assert.match(r.output, /Images: [1-9]/);
	await assert.rejects(convertDocument(opts(fx("multipage.docx"), { pages: "9", outputDir: join(tmp, "b") })), /pages out of range: 9 \(document has 5 pages\)/);
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

function readdirSyncSafe(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

function columnLetter(column: number): string {
	let result = "";
	for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
	return result;
}
