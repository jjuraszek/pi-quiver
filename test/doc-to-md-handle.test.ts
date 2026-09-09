import { test } from "node:test";
import assert from "node:assert";
import { compactRanges, formatHandle, formatInfoHandle, formatSize, scanOutline, type HandleData } from "../lib/doc-to-md-handle.ts";

const base: HandleData = {
	savedTo: "/out/manual.md", imagesDir: "/out/images", type: "pdf", engine: "pymupdf4llm", tier: "primary",
	pageCount: 42, pages: [3, 4, 5], imageCount: 4, bytes: 18637, lines: 412, degraded: null, fallbackReason: null,
	failedPages: [], emptyPages: [], notes: [], outline: [{ line: 1, level: 1, title: "Installation" }, { line: 88, level: 2, title: "Wiring" }], outlineTotal: 2,
};

test("formatHandle: full shape, conditional lines omitted when empty", () => {
	const h = formatHandle(base);
	assert.deepStrictEqual(h.split("\n"), [
		"Saved-To: /out/manual.md",
		"Images-Dir: /out/images",
		"Type: pdf   Engine: pymupdf4llm   Tier: primary",
		"Page-Count: 42   Pages: 3-5   Images: 4   Size: 18.2KB / 412 lines",
		"Outline:",
		"  L1   # Installation",
		"  L88  ## Wiring",
	]);
	assert.ok(!h.includes("Degraded:") && !h.includes("Failed-Pages:") && !h.includes("Notes:"));
});

test("formatHandle: degraded/fallback/failed/empty/notes lines, Images-Dir omitted at zero images, +N more cap", () => {
	const h = formatHandle({
		...base, imagesDir: null, imageCount: 0, engine: "pymupdf-text", tier: "fallback", pages: null,
		degraded: "PyMuPDF text extraction - layout/tables not preserved", fallbackReason: "primary timeout after 60000ms",
		failedPages: [4, 9, 10, 11, 12], emptyPages: [4], notes: ["a", "b", "c", "d", "e", "f"],
		outline: [{ line: 1, level: 1, title: "x".repeat(100) }], outlineTotal: 41,
	});
	const lines = h.split("\n");
	assert.ok(!lines.some((l) => l.startsWith("Images-Dir:")));
	assert.ok(lines.includes("Type: pdf   Engine: pymupdf-text   Tier: fallback"));
	assert.ok(lines.includes("Page-Count: 42   Pages: all   Images: 0   Size: 18.2KB / 412 lines"));
	assert.ok(lines.includes("Degraded: PyMuPDF text extraction - layout/tables not preserved"));
	assert.ok(lines.includes("Fallback-Reason: primary timeout after 60000ms"));
	assert.ok(lines.includes("Failed-Pages: 4, 9-12    Empty-Pages: 4"));
	assert.strictEqual(lines.filter((l) => l.startsWith("Notes:") || l.startsWith("       ")).length, 5);
	assert.ok(lines.some((l) => l === `  L1   # ${"x".repeat(77)}...`));
	assert.strictEqual(lines.at(-1), "  (+40 more)");
});

test("compactRanges: ranges, cap with +N more", () => {
	assert.strictEqual(compactRanges([1, 2, 3, 7, 10, 11, 12]), "1-3, 7, 10-12");
	const many = Array.from({ length: 25 }, (_, i) => i * 2 + 1);
	assert.match(compactRanges(many, 20), /^(\d+, ){19}\d+ \(\+5 more\)$/);
	assert.strictEqual(compactRanges([]), "");
});

test("scanOutline: ATX headings outside fences, line numbers 1-based, cap", () => {
	const md = ["# A", "text", "```", "# not a heading", "```", "## B", "####### seven hashes is not a heading", "#nospace"].join("\n");
	const r = scanOutline(md, 40);
	assert.deepStrictEqual(r.entries, [{ line: 1, level: 1, title: "A" }, { line: 6, level: 2, title: "B" }]);
	assert.strictEqual(r.total, 2);
	const capped = scanOutline("# a\n# b\n# c", 2);
	assert.strictEqual(capped.entries.length, 2);
	assert.strictEqual(capped.total, 3);
});

test("formatInfoHandle: pdf and xlsx shapes", () => {
	const pdf = formatInfoHandle({ type: "pdf", backend: "uv", pageCount: 42, metadata: { title: "Installation Manual", author: "Me" }, toc: [{ level: 1, title: "Installation", page: 3 }], tocTotal: 1, sheets: null, sheetsTotal: 0 }, 40);
	assert.deepStrictEqual(pdf.split("\n"), ["Type: pdf   Page-Count: 42   Backend: uv", "Title: Installation Manual   Author: Me", "TOC:", "  L1 Installation (p3)"]);
	const xl = formatInfoHandle({ type: "xlsx", backend: "uv", pageCount: null, metadata: {}, toc: [], tocTotal: 0, sheets: [{ index: 1, name: "Data", hidden: false, rows: 120, cols: 9, hiddenRows: 1, hiddenCols: 1 }, { index: 2, name: "Hidden", hidden: true, rows: null, cols: null, hiddenRows: 0, hiddenCols: 0 }], sheetsTotal: 2 }, 40);
	assert.deepStrictEqual(xl.split("\n"), ["Type: xlsx   Sheets: 2", "  Data  rows=120 cols=9 hiddenRows=1 hiddenCols=1", "  Hidden  hidden rows=? cols=?"]);
});

test("formatSize", () => {
	assert.strictEqual(formatSize(512), "512B");
	assert.strictEqual(formatSize(18637), "18.2KB");
	assert.strictEqual(formatSize(3 * 1024 * 1024), "3.0MB");
});
