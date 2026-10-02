import { test } from "node:test";
import assert from "node:assert";
import { compactRanges, formatHandle, formatInfoHandle, formatSize, scanOutline, ocrLine, type HandleData, type OcrInfo } from "../lib/doc-to-md-handle.ts";

const base: HandleData = {
	savedTo: "/out/manual.md", imagesDir: "/out/images", sheetsDir: null, pagesDir: null, type: "pdf", engine: "pymupdf4llm", tier: "primary",
	pageCount: 42, pages: [3, 4, 5], explicitBreaks: null, imageCount: 4, pageImageCount: 0, pageImagesReason: null, bytes: 18637, lines: 412, degraded: null, fallbackReason: null,
	nativeImages: [], pageStats: null, pageStatsPath: null, ocrDir: null,
	wordsPath: null, wordsReason: null, wordsErrors: {},
	failedPages: [], emptyPages: [], ocr: null, notes: [], outline: [{ line: 1, level: 1, title: "Installation", page: null }, { line: 88, level: 2, title: "Wiring", page: null }], outlineTotal: 2,
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
		outline: [{ line: 1, level: 1, title: "x".repeat(100), page: null }], outlineTotal: 41,
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

test("formatHandle: workbook preview note keeps all sheet CSV references; ordinary notes keep the character cap", () => {
	const sheets = Array.from({ length: 8 }, (_, i) => `Sheet${i + 1}`);
	const preview = `preview truncated: ${sheets.map((s) => `${s} (100 of 150 rows)`).join("; ")}; full data: ${sheets.map((s) => `sheets/book-${s}.csv`).join(", ")}`;
	const ordinary = "x".repeat(210);
	assert.ok(preview.length > 200);
	const lines = formatHandle({ ...base, type: "xlsx", engine: "openpyxl", tier: "excel", notes: [preview, ordinary, "last"] }).split("\n");
	assert.ok(lines.includes(`Notes: ${preview}`));
	assert.ok(lines.includes(`       ${"x".repeat(197)}...`));
	assert.ok(lines.includes("       last"));
});

test("compactRanges: ranges, cap with +N more", () => {
	assert.strictEqual(compactRanges([1, 2, 3, 7, 10, 11, 12]), "1-3, 7, 10-12");
	const many = Array.from({ length: 25 }, (_, i) => i * 2 + 1);
	assert.match(compactRanges(many, 20), /^(\d+, ){19}\d+ \(\+5 more\)$/);
	assert.strictEqual(compactRanges([]), "");
});

test("scanOutline: ATX headings outside fences, line numbers 1-based, cap, page from the next closing marker", () => {
	const md = ["# A", "text", "```", "# not a heading", "```", "## B", "####### seven hashes is not a heading", "#nospace"].join("\n");
	const r = scanOutline(md, 40);
	assert.deepStrictEqual(r.entries, [{ line: 1, level: 1, title: "A", page: null }, { line: 6, level: 2, title: "B", page: null }]);
	assert.strictEqual(r.total, 2);
	const capped = scanOutline("# a\n# b\n# c", 2);
	assert.strictEqual(capped.entries.length, 2);
	assert.strictEqual(capped.total, 3);
	const paged = scanOutline(["# H", "text", "--- end of page.page_number=2 ---", "## Mid", "--- end of page.page_number=5 ---", "# Tail"].join("\n"), 40);
	assert.deepStrictEqual(paged.entries.map((e) => [e.title, e.page]), [["H", 2], ["Mid", 5], ["Tail", null]]);
});

test("formatHandle: Outline page column, Outline: none, Page-Count suffixes", () => {
	const paged = formatHandle({ ...base, outline: [{ line: 12, level: 2, title: "Title", page: 2 }, { line: 120, level: 1, title: "Late", page: 14 }], outlineTotal: 2 }).split("\n");
	assert.ok(paged.includes("  L12   p2   ## Title") && paged.includes("  L120  p14  # Late"), paged.join("\n"));
	const unpaged = formatHandle({ ...base, outline: [{ line: 12, level: 2, title: "Title", page: null }], outlineTotal: 1 }).split("\n");
	assert.ok(unpaged.includes("  L12  ## Title"));
	const none = formatHandle({ ...base, outline: [], outlineTotal: 0 }).split("\n");
	assert.strictEqual(none.at(-1), "Outline: none");
	assert.ok(none.some((l) => l.startsWith("Page-Count: 42   Pages: 3-5   Images: 4   Size: ")));
	const docx = { ...base, type: "docx" as const, tier: "docx" as const, engine: "mammoth" as const, pages: null, pageCount: 5 };
	assert.ok(formatHandle({ ...docx, explicitBreaks: 4 }).includes("Page-Count: 5 (explicit page breaks, not printed pages)   Pages: all"));
	assert.ok(formatHandle({ ...docx, pageCount: 1, explicitBreaks: 0 }).includes("Page-Count: 1 (no explicit page breaks) - no page markers; cite by Outline line   Pages: all"));
	assert.ok(formatHandle({ ...docx, tier: "primary", engine: "pymupdf4llm", explicitBreaks: null }).includes("Page-Count: 5 (LibreOffice pagination)   Pages: all"));
	assert.ok(formatHandle({ ...base, explicitBreaks: 0 }).includes("Page-Count: 42   Pages: 3-5"));
});

test("formatInfoHandle: docx TOC none line and (p?) for null pages; pdf unchanged", () => {
	const empty = formatInfoHandle({ type: "docx", backend: "uv", pageCount: 1, metadata: {}, toc: [], tocTotal: 0, sheets: null, sheetsTotal: 0 }, 40);
	assert.deepStrictEqual(empty.split("\n"), ["Type: docx   Page-Count: 1   Backend: uv", "TOC: none (no heading styles found)"]);
	const nul = formatInfoHandle({ type: "docx", backend: "uv", pageCount: 1, metadata: { title: "T" }, toc: [{ level: 1, title: "Intro", page: null }], tocTotal: 1, sheets: null, sheetsTotal: 0 }, 40);
	assert.deepStrictEqual(nul.split("\n"), ["Type: docx   Page-Count: 1   Backend: uv", "Title: T", "TOC:", "  L1 Intro (p?)"]);
	const pdf = formatInfoHandle({ type: "pdf", backend: "uv", pageCount: 3, metadata: {}, toc: [], tocTotal: 0, sheets: null, sheetsTotal: 0 }, 40);
	assert.deepStrictEqual(pdf.split("\n"), ["Type: pdf   Page-Count: 3   Backend: uv"]);
});

test("formatInfoHandle: pdf and xlsx shapes", () => {
	const pdf = formatInfoHandle({ type: "pdf", backend: "uv", pageCount: 42, metadata: { title: "Installation Manual", author: "Me" }, toc: [{ level: 1, title: "Installation", page: 3 }], tocTotal: 1, sheets: null, sheetsTotal: 0 }, 40);
	assert.deepStrictEqual(pdf.split("\n"), ["Type: pdf   Page-Count: 42   Backend: uv", "Title: Installation Manual   Author: Me", "TOC:", "  L1 Installation (p3)"]);
	const xl = formatInfoHandle({ type: "xlsx", backend: "uv", pageCount: null, metadata: {}, toc: [], tocTotal: 0, sheets: [
		{ index: 0, name: "Data", kind: "worksheet", hidden: false, rows: 120, cols: 9, hiddenRows: 1, hiddenCols: 1, charts: 1, images: 2, rendered: false, csv: null },
		{ index: 1, name: "Hidden", kind: "worksheet", hidden: true, rows: 3, cols: 2, hiddenRows: 0, hiddenCols: 0, charts: 0, images: 0, rendered: false, csv: null },
		{ index: 2, name: "Trends", kind: "chartsheet", hidden: false, rows: null, cols: null, hiddenRows: 0, hiddenCols: 0, charts: 1, images: 0, rendered: false, csv: null },
	], sheetsTotal: 3 }, 40);
	assert.deepStrictEqual(xl.split("\n"), ["Type: xlsx   Sheets: 3", "  Data  worksheet rows=120 cols=9 charts=1 images=2 hiddenRows=1 hiddenCols=1", "  Hidden  hidden worksheet rows=3 cols=2 charts=0 images=0", "  Trends  chartsheet rows=- cols=- charts=1 images=0"]);
});

test("formatHandle: Sheets-Dir printed after Images-Dir only when set", () => {
	const base = { nativeImages: [], pageStats: null, pageStatsPath: null, ocrDir: null, wordsPath: null, wordsReason: null, wordsErrors: {}, savedTo: "/out/book.md", imagesDir: "/out/images", pagesDir: null, type: "xlsx" as const, engine: "openpyxl" as const, tier: "excel" as const, pageCount: null, pages: null, explicitBreaks: null, imageCount: 1, pageImageCount: 0, pageImagesReason: null, bytes: 10, lines: 1, degraded: null, fallbackReason: null, failedPages: [], emptyPages: [], ocr: null, notes: [], outline: [], outlineTotal: 0 };
	const withSheets = formatHandle({ ...base, sheetsDir: "/out/sheets" }).split("\n");
	assert.deepStrictEqual(withSheets.slice(0, 3), ["Saved-To: /out/book.md", "Images-Dir: /out/images", "Sheets-Dir: /out/sheets"]);
	assert.ok(!formatHandle({ ...base, sheetsDir: null }).includes("Sheets-Dir"));
});

test("formatHandle: Pages-Dir printed after Sheets-Dir when page images exist; none-variant when requested and unavailable", () => {
	const withPages = formatHandle({ ...base, sheetsDir: "/out/sheets", pagesDir: "/out/pages", pageImageCount: 3 }).split("\n");
	assert.deepStrictEqual(withPages.slice(0, 4), ["Saved-To: /out/manual.md", "Images-Dir: /out/images", "Sheets-Dir: /out/sheets", "Pages-Dir: /out/pages (3 pages)"]);
	const none = formatHandle({ ...base, pageImagesReason: "docx has no page geometry" });
	assert.match(none, /^Pages-Dir: none - docx has no page geometry$/m);
	assert.ok(!formatHandle(base).includes("Pages-Dir"));
});

test("ocrLine: ran with no-text pages lists the page ranges", () => {
	const ocr: OcrInfo = { mode: "textless", sidecars: {}, wordSidecars: {}, ocrErrors: {}, killed: null, notAttempted: [], childError: null, status: "ran", lang: "eng", textless: [1, 2, 3, 7], pages: [1, 2, 3, 7], noText: [2, 3, 7], ocrFailed: [], budgetStopped: [], reason: null, tesseract: null };
	assert.strictEqual(ocrLine(ocr, "pdf"), "OCR: 4 page(s) (eng); no text on pages 2-3, 7");
});

test("formatHandle: DOCX without explicit breaks carries the citation suffix", () => {
	const h = formatHandle({ ...base, type: "docx", tier: "docx", engine: "mammoth", pageCount: 1, pages: null, explicitBreaks: 0 });
	assert.match(h, /^Page-Count: 1 \(no explicit page breaks\) - no page markers; cite by Outline line   Pages: all/m);
});

test("formatHandle: Native-Images follows Page-Stats, uses ranges, and is omitted when empty", () => {
	const nativeImages = [1, 2, 3, 4, 7].map((page) => ({ page, file: `/out/images/manual-p${page}-1.jpeg`, width: 10, height: 10 }));
	const one = formatHandle({ ...base, pageStatsPath: "/out/manual.pages.json", nativeImages: nativeImages.slice(0, 1) }).split("\n");
	assert.strictEqual(one[one.indexOf("Page-Stats: /out/manual.pages.json") + 1], "Native-Images: page 1 (embedded image streams, no render DPI)");
	assert.match(formatHandle({ ...base, nativeImages }), /^Native-Images: pages 1-4, 7 \(embedded image streams, no render DPI\)$/m);
	assert.ok(!formatHandle(base).includes("Native-Images:"));
});

test("formatSize", () => {
	assert.strictEqual(formatSize(512), "512B");
	assert.strictEqual(formatSize(18637), "18.2KB");
	assert.strictEqual(formatSize(3 * 1024 * 1024), "3.0MB");
});

const OCR0: OcrInfo = { mode: "textless", sidecars: {}, wordSidecars: {}, ocrErrors: {}, killed: null, notAttempted: [], childError: null, status: "off", lang: "eng", textless: [], pages: [], noText: [], ocrFailed: [], budgetStopped: [], reason: null, tesseract: null };
const FORCED: OcrInfo = { ...OCR0, status: "ran", mode: "all" };

test("ocrLine: forced mode lists only non-empty buckets and ends with the re-run hint", () => {
	assert.strictEqual(ocrLine({ ...FORCED, pages: [2, 7] }, "pdf"), "OCR: forced (eng) - sidecars for pages 2, 7");
	assert.strictEqual(ocrLine({ ...FORCED, pages: [2], sidecars: { 2: "/o/ocr/s-p002.md" } }, "pdf"), "OCR: forced (eng) - sidecars for page 2");
	assert.strictEqual(ocrLine({ ...FORCED, pages: [2, 7], noText: [9], ocrFailed: [4], ocrErrors: { 4: "RuntimeError: tesseract exploded" }, budgetStopped: [13, 20] }, "pdf"), "OCR: forced (eng) - sidecars for pages 2, 7; no text on page 9; failed on page 4 (RuntimeError: tesseract exploded); budget-stopped pages 13, 20 - re-run with --pages 13,20");
	assert.strictEqual(ocrLine({ ...FORCED, pages: [2, 7], killed: 13, notAttempted: [20, 25] }, "pdf"), "OCR: forced (eng) - sidecars for pages 2, 7; page 13 killed the OCR child (timeout or crash - likely a compression bomb); pages 20, 25 not attempted - re-run with --pages 20,25");
	assert.strictEqual(ocrLine({ ...FORCED, childError: "exit 1 (Traceback: boom)", notAttempted: [2, 7] }, "pdf"), "OCR: forced (eng) - OCR child failed before processing pages: exit 1 (Traceback: boom); pages 2, 7 not attempted - re-run with --pages 2,7");
	assert.strictEqual(ocrLine({ ...FORCED, lang: "deu+eng", budgetStopped: [1, 2, 3] }, "pdf"), "OCR: forced (deu+eng) - budget-stopped pages 1, 2, 3 - re-run with --pages 1,2,3");
	assert.strictEqual(ocrLine({ ...FORCED, noText: [1] }, "pdf"), "OCR: forced (eng) - no text on page 1");
});

test("ocr JSON shapes: textless defaults and forced sidecar outcomes survive serialization", () => {
	const handle: HandleData = { ...base, wordsPath: "/out/manual.words.json", wordsErrors: { 2: "ValueError: x", 5: "RuntimeError: boom" } };
	const parsed = JSON.parse(JSON.stringify(handle));
	assert.strictEqual(parsed.wordsPath, "/out/manual.words.json");
	assert.strictEqual(parsed.wordsReason, null);
	assert.deepStrictEqual(parsed.wordsErrors, { "2": "ValueError: x", "5": "RuntimeError: boom" });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(OCR0)), {
		status: "off", lang: "eng", textless: [], pages: [], noText: [], ocrFailed: [], budgetStopped: [], reason: null, tesseract: null,
		mode: "textless", sidecars: {}, wordSidecars: {}, ocrErrors: {}, killed: null, notAttempted: [], childError: null,
	});
	const forced: OcrInfo = { ...FORCED, pages: [2], sidecars: { 2: "/out/ocr/s-p002.md" }, wordSidecars: { 2: "/out/ocr/s-p002.words.json" }, ocrFailed: [4], ocrErrors: { 4: "boom" }, killed: 13, notAttempted: [20], childError: null };
	assert.deepStrictEqual(JSON.parse(JSON.stringify(forced)), {
		status: "ran", lang: "eng", textless: [], pages: [2], noText: [], ocrFailed: [4], budgetStopped: [], reason: null, tesseract: null,
		mode: "all", sidecars: { "2": "/out/ocr/s-p002.md" }, wordSidecars: { "2": "/out/ocr/s-p002.words.json" }, ocrErrors: { "4": "boom" }, killed: 13, notAttempted: [20], childError: null,
	});
});

test("ocrLine: textless wording unchanged by the new fields", () => {
	assert.strictEqual(ocrLine({ ...OCR0, status: "ran", pages: [1, 2, 3] }, "pdf"), "OCR: 3 page(s) (eng)");
	assert.strictEqual(ocrLine({ ...OCR0, textless: [1], tesseract: true }, "pdf"), "OCR: off - 1 page(s) without a text layer; rerun with ocr=true");
});

test("formatHandle: Page-Stats after the Dir lines, OCR-Dir only with sidecars", () => {
	const lines = formatHandle({ ...base, pageStats: [{ page: 3, chars: 1, images: 1, imageCoverage: 0.94 }], pageStatsPath: "/out/manual.pages.json", ocrDir: "/out/ocr", ocr: { ...FORCED, pages: [3], sidecars: { 3: "/out/ocr/manual-p003.md" } } }).split("\n");
	assert.deepStrictEqual(lines.slice(0, 5), ["Saved-To: /out/manual.md", "Images-Dir: /out/images", "Page-Stats: /out/manual.pages.json", "OCR-Dir: /out/ocr", "Type: pdf   Engine: pymupdf4llm   Tier: primary"]);
	assert.ok(lines.includes("OCR: forced (eng) - sidecars for page 3"));
	const plain = formatHandle({ ...base, pageStatsPath: "/out/manual.pages.json" }).split("\n");
	assert.strictEqual(plain[2], "Page-Stats: /out/manual.pages.json");
	assert.ok(!plain.some((l) => l.startsWith("OCR-Dir:")));
	assert.ok(!formatHandle(base).includes("Page-Stats:"));
});

test("ocrLine: every row and clause, first match wins", () => {
	assert.strictEqual(ocrLine({ ...OCR0, textless: [1, 2, 3], tesseract: true }, "pdf"), "OCR: off - 3 page(s) without a text layer; rerun with ocr=true");
	assert.strictEqual(ocrLine({ ...OCR0, textless: [1, 2, 3], tesseract: false }, "pdf"), "OCR: off - 3 page(s) without a text layer; install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true");
	assert.strictEqual(ocrLine({ ...OCR0, tesseract: true }, "image"), "OCR: off; rerun with ocr=true");
	assert.strictEqual(ocrLine({ ...OCR0, tesseract: false }, "image"), "OCR: off; install Tesseract (see doc/doc-to-md.md), then rerun with ocr=true");
	assert.strictEqual(ocrLine({ ...OCR0, status: "unavailable", reason: "language data for deu not installed" }, "pdf"), "OCR: unavailable - language data for deu not installed (install Tesseract; see doc/doc-to-md.md)");
	for (const reason of ["fallback tier", "no Python backend", "OCR child failed: exit 1"]) assert.strictEqual(ocrLine({ ...OCR0, status: "unavailable", reason }, "pdf"), `OCR: unavailable - ${reason}`);
	assert.strictEqual(ocrLine({ ...OCR0, status: "skipped", reason: "image too small" }, "image"), "OCR: skipped - image too small");
	assert.strictEqual(ocrLine({ ...OCR0, status: "ran", pages: [1, 2, 3] }, "pdf"), "OCR: 3 page(s) (eng)");
	assert.strictEqual(ocrLine({ ...OCR0, status: "ran", pages: [1] }, "image"), "OCR: 1 image (eng)");
	assert.strictEqual(ocrLine({ ...OCR0, status: "ran", lang: "deu+eng", pages: [1, 2], noText: [5], ocrFailed: [6, 7], budgetStopped: [3, 7, 8, 9] }, "pdf"),
		"OCR: 2 page(s) (deu+eng); no text on pages 5; 2 failed and were converted without OCR; time budget reached for pages=3,7-9; rerun with pages=3,7-9 or raise primaryTimeoutMs");
	assert.strictEqual(ocrLine({ ...OCR0, status: "ran", textless: [1, 2], budgetStopped: [18, 19, 20] }, "pdf"), "OCR: 0 page(s) (eng); time budget reached for pages=18-20; rerun with pages=18-20 or raise primaryTimeoutMs");
});

test("formatHandle: OCR line after Failed/Empty-Pages, omitted when ocr is null; OCR blockquote headings not in the Outline", () => {
	const h: HandleData = { nativeImages: [], pageStats: null, pageStatsPath: null, ocrDir: null, wordsPath: null, wordsReason: null, wordsErrors: {}, savedTo: "/o/s.md", imagesDir: "/o/images", sheetsDir: null, pagesDir: null, type: "pdf", engine: "pymupdf4llm", tier: "primary", pageCount: 2, pages: null, explicitBreaks: null, imageCount: 1, pageImageCount: 0, pageImagesReason: null, bytes: 10, lines: 1, degraded: null, fallbackReason: null, failedPages: [], emptyPages: [1], notes: ["n"], outline: [], outlineTotal: 0, ocr: { ...OCR0, textless: [1], tesseract: true } };
	const lines = formatHandle(h).split("\n");
	assert.strictEqual(lines[lines.indexOf("Empty-Pages: 1") + 1], "OCR: off - 1 page(s) without a text layer; rerun with ocr=true");
	assert.ok(!formatHandle({ ...h, ocr: null }).includes("OCR:"));
	assert.deepStrictEqual(scanOutline("> # Scanned heading\n>\n# Real\n", 10).entries.map((e) => e.title), ["Real"]);
});

test("Words: line - path, extraction-failed clause, reasons, absent without --words", () => {
	const at = (h: Partial<HandleData>) => formatHandle({ ...base, ...h }).split("\n");
	assert.ok(!formatHandle(base).includes("Words:"));
	assert.strictEqual(at({ wordsPath: "/out/manual.words.json" })[2], "Words: /out/manual.words.json");
	assert.strictEqual(at({ wordsPath: "/out/manual.words.json", wordsErrors: { 5: "RuntimeError: boom", 2: "ValueError: x" } })[2], "Words: /out/manual.words.json (extraction failed for pages 2, 5: ValueError: x)");
	assert.strictEqual(at({ wordsReason: "none - word positions apply to PDF and image inputs only (docx)" })[2], "Words: none - word positions apply to PDF and image inputs only (docx)");
	assert.strictEqual(at({ wordsReason: "none - unpdf tier has no page geometry" })[2], "Words: none - unpdf tier has no page geometry");
	assert.strictEqual(at({ wordsReason: "none - image copied without conversion (no Python backend)" })[2], "Words: none - image copied without conversion (no Python backend)");
	assert.strictEqual(at({ wordsReason: "write failed - EACCES" })[2], "Words: write failed - EACCES");
	const withStats = at({ pageStatsPath: "/out/manual.pages.json", wordsPath: "/out/manual.words.json", ocrDir: "/out/ocr" });
	assert.deepStrictEqual(withStats.slice(2, 5), ["Page-Stats: /out/manual.pages.json", "Words: /out/manual.words.json", "OCR-Dir: /out/ocr"]);
	const withNative = at({ pageStatsPath: "/out/manual.pages.json", nativeImages: [{ page: 1, file: "/out/images/page.jpeg", width: 2000, height: 2800 }], wordsPath: "/out/manual.words.json", ocrDir: "/out/ocr" });
	assert.deepStrictEqual(withNative.slice(2, 6), ["Page-Stats: /out/manual.pages.json", "Native-Images: page 1 (embedded image streams, no render DPI)", "Words: /out/manual.words.json", "OCR-Dir: /out/ocr"]);
});
