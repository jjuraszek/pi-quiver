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
let tmp: string;
beforeEach(() => { resetBackendCacheForTests(); tmp = mkdtempSync(join(tmpdir(), "quiver-py-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

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

test("workbook.xlsx: inventory, matrix, formulas, disclosures, images by sheet index", T, async () => {
	const r = await convertDocument(opts(fx("workbook.xlsx"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.startsWith("## Sheets\n"));
	assert.ok(md.includes("## Data") && md.includes("| | A | B | C |"));
	assert.match(md, /\| 18 \|.*42 \(=D17\*2\)/);
	assert.match(md, /\(no cached result\) \(=SUM\(A2:A20\)\)/);
	assert.ok(md.includes("pipe\\|in\\|text"));
	assert.ok(md.includes("Merged: A1:C1") && md.includes("Hidden rows: 4") && md.includes("Hidden cols: F"));
	assert.ok(md.includes("## Hidden\nHidden sheet"));
	assert.match(md, /## Settings[\s\S]*\| 17 \|.*threshold \| 42/);
	const imgs = readdirSyncSafe(join(dirname(h["Saved-To"]), "images"));
	assert.ok(imgs.includes("workbook-s1-1.png") && imgs.some((f) => f.startsWith("workbook-s3-")) && imgs.some((f) => f.startsWith("workbook-s4-")));
	assert.match(r.output, /Engine: openpyxl   Tier: excel/);
	assert.ok(r.output.includes("## Sheets") && r.output.includes("## Data"));
});

test("workbook.xlsx --info: sheets with dims and hidden counts", T, async () => {
	const r = await inspectDocument(opts(fx("workbook.xlsx"), { info: true }));
	assert.match(r.output, /^Type: xlsx   Sheets: 5/m);
	for (const sheet of ["Data", "Settings", "A B", "A_B", "Hidden"]) assert.match(r.output, new RegExp(`^  ${sheet}  .+$`, "m"));
	assert.match(r.output, /^  Data  rows=\d+ cols=\d+ hiddenRows=1 hiddenCols=1$/m);
	assert.match(r.output, /^  Hidden  hidden .+$/m);
});

test("workbook.xlsx --pages 1 rejects unstable worksheet page numbering", T, async () => {
	await assert.rejects(convertDocument(opts(fx("workbook.xlsx"), { pages: "1", outputDir: tmp })), /worksheets have no stable page numbering/);
});

test("legacy.xls: unavailable note, merged + hidden disclosures, error cells", T, async () => {
	const r = await convertDocument(opts(fx("legacy.xls"), { outputDir: tmp }));
	const h = parseHandle(r.output);
	const md = linksResolve(h["Saved-To"]);
	assert.ok(md.includes("Formulas: unavailable (.xls via xlrd); Images: unavailable"));
	assert.ok(md.includes("Merged: A1:C1") && md.includes("Hidden rows: 4") && md.includes("Hidden cols: B"));
	assert.ok(md.includes("#DIV/0!"));
});

test("maxCellsPerSheet truncation line", T, async () => {
	const r = await convertDocument(opts(fx("workbook.xlsx"), { maxCellsPerSheet: 20, outputDir: tmp }));
	const h = parseHandle(r.output);
	assert.match(linksResolve(h["Saved-To"]), /Truncated: showing rows 1-\d+ of \d+, cols A-[A-Z]+ of \d+/);
});

test("Excel stall (excelTimeoutMs 1) -> remedy error, lock released", T, async () => {
	const before = process.platform === "win32" ? null : excelPids();
	await assert.rejects(convertDocument(opts(fx("workbook.xlsx"), { excelTimeoutMs: 1, outputDir: tmp })), /Remedy: raise excelTimeoutMs or lower maxCellsPerSheet/);
	assert.ok(!existsSync(join(tmp, "workbook.md.lock")));
	if (before) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		const survivors = [...excelPids()].filter((pid) => !before.has(pid));
		assert.deepStrictEqual(survivors, [], "Excel child survived timeout");
	}
});

function readdirSyncSafe(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
