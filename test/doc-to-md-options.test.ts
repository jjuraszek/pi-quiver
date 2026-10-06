import { test } from "node:test";
import assert from "node:assert";
import {
	BUNDLE_LAYOUT, DOC_TO_MD_OPTIONS, TUNABLE_DEFAULTS, UsageError, classifyInput, coerceDocToMdSettings,
	countDistinctPages, ocrCeilingMessage, pageIntervals, renderHelp, resolveOptions, sanitizeStem, usagePatterns, USAGE_PATTERNS,
} from "../lib/doc-to-md-options.ts";

test("descriptors: every tunable has a flag, default and help; per-call intents are not settable", () => {
	for (const d of DOC_TO_MD_OPTIONS) {
		assert.ok(d.help.length > 0, d.key);
		if (d.key !== "path" && !d.settingsOnly) assert.match(d.flag!, /^--[a-z-]+$/, d.key);
	}
	const intents = DOC_TO_MD_OPTIONS.filter((d) => !d.settable).map((d) => d.key).sort();
	assert.deepStrictEqual(intents, ["info", "ocrMode", "outputDir", "overwrite", "pageImages", "pages", "path", "words"]);
	assert.strictEqual(TUNABLE_DEFAULTS.primaryTimeoutMs, 60000);
	assert.strictEqual(TUNABLE_DEFAULTS.fallbackTimeoutMs, 30000);
	assert.strictEqual(TUNABLE_DEFAULTS.sofficeTimeoutMs, 120000);
	assert.strictEqual(TUNABLE_DEFAULTS.excelTimeoutMs, 60000);
	assert.strictEqual(TUNABLE_DEFAULTS.warmTimeoutMs, 120000);
	assert.strictEqual(TUNABLE_DEFAULTS.pymupdfVersion, "1.27.2.3");
	assert.strictEqual(TUNABLE_DEFAULTS.imageDpi, 150);
	assert.strictEqual(TUNABLE_DEFAULTS.imageFormat, "png");
	assert.ok(!("maxCellsPerSheet" in TUNABLE_DEFAULTS));
	assert.ok(!DOC_TO_MD_OPTIONS.some((d) => (d.key as string) === "maxCellsPerSheet"));
	assert.strictEqual(TUNABLE_DEFAULTS.maxOutputBytes, 20000000);
	assert.strictEqual(TUNABLE_DEFAULTS.outlineMaxEntries, 40);
});

test("pages help names DOCX explicit-page-break segments", () => {
	const pages = DOC_TO_MD_OPTIONS.find((d) => d.key === "pages")!;
	assert.ok(pages.help.includes("DOCX: selects explicit-page-break segments; rejected when the file has none"), pages.help);
});

test("resolveOptions: per-call > settings > env > default", () => {
	const env = { PI_DOC_TO_MD_CONVERT_TIMEOUT_MS: "1000", PI_DOC_TO_MD_SOFFICE_TIMEOUT_MS: "2000", PI_DOC_TO_MD_WARM_TIMEOUT_MS: "3000", PI_DOC_TO_MD_PYMUPDF_VERSION: "1.27.0" };
	const r = resolveOptions({ path: "a.pdf", primaryTimeoutMs: 5 }, { primaryTimeoutMs: 7, sofficeTimeoutMs: 9 }, env);
	assert.strictEqual(r.primaryTimeoutMs, 5);
	assert.strictEqual(r.sofficeTimeoutMs, 9);
	assert.strictEqual(r.warmTimeoutMs, 3000);
	assert.strictEqual(r.pymupdfVersion, "1.27.0");
	assert.strictEqual(r.excelTimeoutMs, 60000);
	assert.strictEqual(r.info, false);
	assert.strictEqual(r.pages, null);
	assert.strictEqual(r.outputDir, null);
	assert.strictEqual(r.overwrite, false);
});

test("resolveOptions: info with a bundle option is a UsageError", () => {
	assert.throws(() => resolveOptions({ path: "a.pdf", info: true, pages: "1" }, {}, {}), UsageError);
	assert.throws(() => resolveOptions({ path: "a.pdf", info: true, outputDir: "x" }, {}, {}), UsageError);
	assert.throws(() => resolveOptions({ path: "a.pdf", info: true, overwrite: true }, {}, {}), UsageError);
	assert.throws(() => resolveOptions({ path: "a.pdf", info: true, pageImages: true }, {}, {}), UsageError);
});

test("resolveOptions: bad per-call values are UsageErrors", () => {
	assert.throws(() => resolveOptions({ path: "a.pdf", pages: "x" }, {}, {}), UsageError);
	assert.throws(() => resolveOptions({ path: "a.pdf", imageFormat: "gif" as "png" }, {}, {}), UsageError);
	assert.throws(() => resolveOptions({ path: "a.pdf", primaryTimeoutMs: 0 }, {}, {}), UsageError);
	assert.throws(() => resolveOptions({ path: "a.pdf", pymupdfVersion: "1.26.0" }, {}, {}), UsageError);
});

test("coerceDocToMdSettings: unknown and intent keys are dropped silently, ill-typed keys warn", () => {
	const warnings: string[] = [];
	const patch = coerceDocToMdSettings({ primaryTimeoutMs: 100, bogus: 1, imageDpi: "high", pages: "1-2", imageFormat: "jpg" }, (m) => warnings.push(m));
	assert.deepStrictEqual(patch, { primaryTimeoutMs: 100, imageFormat: "jpg" });
	assert.deepStrictEqual(warnings, ["pi-quiver: quiver.docToMd.imageDpi must be a positive integer; ignored."]);
	assert.strictEqual(coerceDocToMdSettings(null), undefined);
	assert.strictEqual(coerceDocToMdSettings([1]), undefined);
});

test("coerceDocToMdSettings: numeric strings are ill-typed", () => {
	const warnings: string[] = [];
	assert.deepStrictEqual(coerceDocToMdSettings({ imageDpi: "150" }, (m) => warnings.push(m)), {});
	assert.strictEqual(warnings.length, 1);
	assert.ok(warnings[0].includes("imageDpi"));
});

test("resolveOptions pages: inclusive 1-based, sorted, deduped", () => {
	const pages = (spec: string) => resolveOptions({ path: "a.pdf", pages: spec }, {}, {}).pages;
	assert.deepStrictEqual(pages("12-15"), [12, 13, 14, 15]);
	assert.deepStrictEqual(pages("3,7,10-12,7"), [3, 7, 10, 11, 12]);
	assert.deepStrictEqual(pages(" 2 , 1 "), [1, 2]);
	for (const bad of ["0", "a", "5-3", "1-", "-2", "1,,2", "1.5"]) assert.throws(() => pages(bad), UsageError, bad);
});

test("sanitizeStem: [A-Za-z0-9._-] only, runs collapsed, empty -> document", () => {
	assert.strictEqual(sanitizeStem("My Doc (v2)"), "My_Doc_v2_");
	assert.strictEqual(sanitizeStem("report.final"), "report.final");
	assert.strictEqual(sanitizeStem("Ärger  &  Co"), "_rger_Co");
	assert.strictEqual(sanitizeStem(""), "document");
	assert.strictEqual(sanitizeStem("###"), "_");
});

test("classifyInput: office/pdf types, case-insensitive; unsupported names the list", () => {
	assert.strictEqual(classifyInput("A.PDF"), "pdf");
	assert.strictEqual(classifyInput("b.docx"), "docx");
	assert.strictEqual(classifyInput("c.pptx"), "pptx");
	assert.strictEqual(classifyInput("d.xlsx"), "xlsx");
	assert.strictEqual(classifyInput("e.xls"), "xls");
	assert.strictEqual(classifyInput("f.xlsm"), "xlsm");
});

test("classifyInput: html and image inputs; .webp stays unsupported", () => {
	assert.strictEqual(classifyInput("a.html"), "html");
	assert.strictEqual(classifyInput("A.HTM"), "html");
	for (const e of [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif"]) assert.strictEqual(classifyInput(`x${e}`), "image", e);
	assert.throws(() => classifyInput("x.webp"), /Unsupported file type "\.webp"; supported: \.pdf, \.docx, \.pptx, \.xlsx, \.xls, \.xlsm, \.doc, \.msg, \.eml, \.html, \.htm, \.png, \.jpg, \.jpeg, \.tif, \.tiff, \.bmp, \.gif/);
});

test("ocr tunables: defaults, precedence, per-call false beats settings true", () => {
	assert.strictEqual(TUNABLE_DEFAULTS.ocr, false);
	assert.strictEqual(TUNABLE_DEFAULTS.ocrLanguage, "eng");
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, { ocr: true }, {}).ocr, true);
	assert.strictEqual(resolveOptions({ path: "a.pdf", ocr: false }, { ocr: true }, {}).ocr, false);
	assert.strictEqual(resolveOptions({ path: "a.pdf", ocrLanguage: "deu+eng" }, { ocrLanguage: "pol" }, {}).ocrLanguage, "deu+eng");
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, { ocrLanguage: "chi_sim" }, {}).ocrLanguage, "chi_sim");
});

test("hideAnnotations: settable bool, default false and per-call precedence", () => {
	const d = DOC_TO_MD_OPTIONS.find((o) => o.key === "hideAnnotations")!;
	assert.ok(d, "hideAnnotations descriptor exists");
	assert.deepStrictEqual([d.type, d.default, d.settable, d.flag], ["bool", false, true, "--hide-annotations"]);
	assert.strictEqual(d.help, "Render PDF pages without annotations (sticky notes, highlights, stamps - and form-field widgets, so filled form values disappear); default paints them, as PyMuPDF does. Applies to pages/ renders and textless-page renders, not to OCR text or embedded images; also lets an annotated scan be delivered as its embedded image.");
	assert.strictEqual(TUNABLE_DEFAULTS.hideAnnotations, false);
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, {}, {}).hideAnnotations, false);
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, { hideAnnotations: true }, {}).hideAnnotations, true);
	assert.strictEqual(resolveOptions({ path: "a.pdf", hideAnnotations: true }, { hideAnnotations: false }, {}).hideAnnotations, true);
	assert.strictEqual(resolveOptions({ path: "a.pdf", hideAnnotations: false }, { hideAnnotations: true }, {}).hideAnnotations, false);
	assert.strictEqual(resolveOptions({ path: "a.pdf", info: true, hideAnnotations: true }, {}, {}).info, true);
	assert.deepStrictEqual(coerceDocToMdSettings({ hideAnnotations: true }), { hideAnnotations: true });
	const warnings: string[] = [];
	assert.deepStrictEqual(coerceDocToMdSettings({ hideAnnotations: "yes" }, (m) => warnings.push(m)), {});
	assert.deepStrictEqual(warnings, ["pi-quiver: quiver.docToMd.hideAnnotations must be true or false; ignored."]);
});

test("ocrLanguage validation: plain Tesseract codes only", () => {
	for (const bad of ["Deu", "eng+", "+eng", "../eng", "script/Latin", "eng deu", ""]) assert.throws(() => resolveOptions({ path: "a.pdf", ocrLanguage: bad }, {}, {}), UsageError, bad);
	const warnings: string[] = [];
	assert.deepStrictEqual(coerceDocToMdSettings({ ocrLanguage: "script/Latin", ocr: true }, (m) => warnings.push(m)), { ocr: true });
	assert.match(warnings[0], /quiver\.docToMd\.ocrLanguage must be Tesseract language codes/);
});

test("classifyInput: new office and email extensions", () => {
	assert.strictEqual(classifyInput("a.xlsm"), "xlsm");
	assert.strictEqual(classifyInput("a.DOC"), "doc");
	assert.strictEqual(classifyInput("a.msg"), "email");
	assert.strictEqual(classifyInput("a.eml"), "email");
	assert.throws(() => classifyInput("a.webp"), /supported: .*\.xlsm.*\.doc.*\.msg.*\.eml/);
});

test("pageIntervals: empty string means all pages", () => {
	assert.strictEqual(pageIntervals(""), null);
	assert.strictEqual(pageIntervals("   "), null);
	assert.strictEqual(resolveOptions({ path: "a.pdf", pages: "" }, {}, {}).pages, null);
	assert.throws(() => pageIntervals("1,,2"), /invalid --pages/);
	assert.throws(() => resolveOptions({ path: "a.pdf", pages: 1 as never }, {}, {}), { constructor: UsageError, message: "--pages must be a string" });
});

test("pageImages: per-call bool, default false, not settable", () => {
	const d = DOC_TO_MD_OPTIONS.find((o) => o.key === "pageImages")!;
	assert.deepStrictEqual([d.type, d.default, d.settable, d.flag], ["bool", false, false, "--page-images"]);
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, {}, {}).pageImages, false);
	assert.strictEqual(resolveOptions({ path: "a.pdf", pageImages: true }, {}, {}).pageImages, true);
	assert.deepStrictEqual(coerceDocToMdSettings({ pageImages: true }), {});
});

test("help text documents the stem rule and empty pages", () => {
	assert.match(DOC_TO_MD_OPTIONS.find((o) => o.key === "outputDir")!.help, /\[\^A-Za-z0-9\._-\]\+ -> _/);
	assert.match(DOC_TO_MD_OPTIONS.find((o) => o.key === "pages")!.help, /"" means all pages/);
});

test("ocrMode: per-call enum, default textless, not settable, all + info rejected", () => {
	const d = DOC_TO_MD_OPTIONS.find((o) => o.key === "ocrMode")!;
	assert.deepStrictEqual([d.type, d.default, d.settable, d.flag, d.enumValues], ["enum", "textless", false, "--ocr-mode", ["textless", "all"]]);
	assert.match(d.help, /ocr\/<stem>-pNNN\.md/);
	assert.match(d.help, /all requires --ocr and an explicit --pages/);
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, {}, {}).ocrMode, "textless");
	assert.strictEqual(resolveOptions({ path: "a.pdf", ocrMode: "all" }, {}, {}).ocrMode, "all");
	assert.throws(() => resolveOptions({ path: "a.pdf", ocrMode: "sometimes" as never }, {}, {}), /--ocr-mode must be one of textless, all/);
	assert.throws(() => resolveOptions({ path: "a.pdf", info: true, ocrMode: "all" }, {}, {}), { constructor: UsageError, message: "--info cannot be combined with --pages, --output-dir, --overwrite, --page-images, --words or --ocr-mode all" });
	assert.strictEqual(resolveOptions({ path: "a.pdf", info: true, ocrMode: "textless" }, {}, {}).info, true);
	assert.deepStrictEqual(coerceDocToMdSettings({ ocrMode: "all" }), {});
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, { ocrMode: "all" } as never, {}).ocrMode, "textless");
});

test("USAGE_PATTERNS: template carries <cmd>, usagePatterns substitutes it, renderHelp ends with it", () => {
	assert.strictEqual(typeof USAGE_PATTERNS, "string");
	assert.ok(USAGE_PATTERNS.includes("<cmd> report.pdf --output-dir out --json"));
	assert.ok(USAGE_PATTERNS.includes("--ocr --ocr-mode all --pages 2,7 --json"));
	const rendered = usagePatterns("pi-quiver doc-to-md");
	assert.ok(!rendered.includes("<cmd>"));
	assert.ok(rendered.includes("pi-quiver doc-to-md report.pdf --output-dir out --json"));
	assert.ok(renderHelp().endsWith(rendered));
	assert.ok(renderHelp().includes("--ocr-mode"));
});

test("words: per-call bool, default false, not settable, never a tunable", () => {
	const d = DOC_TO_MD_OPTIONS.find((o) => o.key === "words")!;
	assert.deepStrictEqual([d.type, d.default, d.settable, d.flag], ["bool", false, false, "--words"]);
	assert.strictEqual(d.help, "Write word positions: <stem>.words.json beside the Markdown lists every text-layer word of each selected page with its bbox (PDF points, top-left origin, display orientation; image inputs in source pixels) and the words inline OCR recognized, tagged source \"text\" or \"ocr\"; under --ocr-mode all the OCR words go to ocr/<stem>-pNNN.words.json beside each sidecar. Never triggers OCR. PDF and image inputs only.");
	assert.strictEqual(resolveOptions({ path: "a.pdf" }, {}, {}).words, false);
	assert.strictEqual(resolveOptions({ path: "a.pdf", words: true }, {}, {}).words, true);
	assert.ok(!("words" in TUNABLE_DEFAULTS));
	assert.throws(() => resolveOptions({ path: "a.pdf", info: true, words: true }, {}, {}), (e: Error) => e instanceof UsageError && e.message === "--info cannot be combined with --pages, --output-dir, --overwrite, --page-images, --words or --ocr-mode all");
});

test("BUNDLE_LAYOUT: help names every artifact and its handle field", () => {
	assert.strictEqual(BUNDLE_LAYOUT.length, 9);
	for (const row of BUNDLE_LAYOUT) {
		assert.ok(renderHelp().includes(row.artifact), row.artifact);
		assert.ok(renderHelp().includes(`named by ${row.namedBy}`), row.namedBy);
	}
});

test("ocrMaxPages: settings-only descriptor and ignored per-call override", () => {
	const d = DOC_TO_MD_OPTIONS.find((o) => o.key === "ocrMaxPages")!;
	assert.deepStrictEqual([d.type, d.default, d.settable, d.settingsOnly, d.flag], ["int", 10, true, true, null]);
	assert.strictEqual(TUNABLE_DEFAULTS.ocrMaxPages, 10);
	assert.strictEqual(resolveOptions({ path: "a.pdf", ocrMaxPages: 999 }, {}, {}).ocrMaxPages, 10);
	assert.strictEqual(resolveOptions({ path: "a.pdf", ocrMaxPages: 999 }, { ocrMaxPages: 3 }, {}).ocrMaxPages, 3);
	assert.strictEqual(DOC_TO_MD_OPTIONS.filter((o) => o.settingsOnly).length, 1);
});

test("ocrMaxPages: invalid settings warn and drop, all ints must be safe", () => {
	for (const v of [0, -1, 1.5, "10", true, null, 2 ** 53]) {
		const warnings: string[] = [];
		assert.deepStrictEqual(coerceDocToMdSettings({ ocrMaxPages: v }, (m) => warnings.push(m)), {});
		assert.deepStrictEqual(warnings, ["pi-quiver: quiver.docToMd.ocrMaxPages must be a positive integer; ignored."]);
	}
	assert.deepStrictEqual(coerceDocToMdSettings({ ocrMaxPages: 25, primaryTimeoutMs: 2 ** 53 }, () => {}), { ocrMaxPages: 25 });
});

test("pageIntervals and countDistinctPages: distinct counts without expansion and safe endpoints", () => {
	assert.deepStrictEqual(pageIntervals(""), null);
	assert.deepStrictEqual(pageIntervals("2,7,19"), [[2, 2], [7, 7], [19, 19]]);
	assert.deepStrictEqual(pageIntervals("1-8,5-10"), [[1, 8], [5, 10]]);
	for (const [spec, count] of [["2,7,19", 3], ["1-8,5-10", 10], ["1-5,3", 5], ["10-12,1-3,2-11", 12], ["1-9999999999", 9999999999]] as const) {
		assert.strictEqual(countDistinctPages(pageIntervals(spec)!), count);
	}
	assert.throws(() => pageIntervals("1-9007199254740993"), (e: Error) => e instanceof UsageError && e.message === 'invalid --pages "1-9007199254740993": page numbers above 9007199254740991 are not supported');
	assert.throws(() => pageIntervals("3-1"), /ranges ascend/);
	assert.deepStrictEqual(resolveOptions({ path: "a.pdf", pages: "1-3,2" }, {}, {}).pages, [1, 2, 3]);
});

test("resolveOptions: forced ceiling precedes expansion, textless remains uncapped", () => {
	const forced = (pages: string, settings = {}) => resolveOptions({ path: "a.pdf", ocr: true, ocrMode: "all", pages }, settings, {});
	const expected = (count: number, spec: string, ceiling = 10) => `ocrMode "all" selects ${count} distinct pages (pages=${spec}); the OCR page ceiling is ${ceiling} (quiver.docToMd.ocrMaxPages). Broad OCR is slow and usually unnecessary: convert without OCR first, read Page-Stats to find the pages that need it, and select only those. For more than ${ceiling} pages, run explicit sequential batches within the ceiling and inspect each result before the next. The ceiling is settings-only; no tool or CLI argument raises it.`;
	assert.throws(() => forced("1-11"), (e: Error) => e instanceof UsageError && e.message === expected(11, "1-11"));
	assert.strictEqual(ocrCeilingMessage(11, 10, "1-11"), expected(11, "1-11"));
	assert.deepStrictEqual(forced("1-10").pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.strictEqual(forced("1-8,5-10").pages!.length, 10);
	assert.throws(() => forced("1-8,5-11"), (e: Error) => e.message.startsWith('ocrMode "all" selects 11 distinct pages (pages=1-8,5-11)'));
	assert.deepStrictEqual(forced("2,7,19").pages, [2, 7, 19]);
	assert.throws(() => forced("1-6", { ocrMaxPages: 5 }), (e: Error) => e.message === expected(6, "1-6", 5));
	assert.strictEqual(forced("1-15", { ocrMaxPages: 20 }).pages!.length, 15);
	const started = performance.now();
	assert.throws(() => forced("1-9999999999"), (e: Error) => e.message.startsWith('ocrMode "all" selects 9999999999 distinct pages'));
	// Expanding ten billion pages would take minutes or exhaust memory.
	assert.ok(performance.now() - started < 5000, "huge range must be rejected before expansion");
	const long = Array.from({ length: 11 }, (_, i) => String(i + 1)).join(" ,       ");
	assert.ok(long.length > 80);
	assert.throws(() => forced(long), (e: Error) => {
		assert.ok(e.message.includes(`(pages=${long.slice(0, 77)}...)`));
		assert.strictEqual(e.message.match(/pages=([^)]*)\)/)![1].length, 80);
		return true;
	});
	assert.throws(() => resolveOptions({ path: "a.pdf", ocrMode: "all", pages: "1-11" }, {}, {}), (e: Error) => e instanceof UsageError && /ceiling is 10/.test(e.message));
	assert.strictEqual(resolveOptions({ path: "a.pdf", ocr: true, pages: "1-11" }, {}, {}).pages!.length, 11);
	assert.throws(() => resolveOptions({ path: "a.pdf", pages: "1-9007199254740993" }, {}, {}), (e: Error) => e instanceof UsageError && /above 9007199254740991/.test(e.message));
	assert.throws(() => resolveOptions({ path: "a.pdf", pages: "x" }, {}, {}), /bad token "x"/);
});

test("renderHelp and USAGE_PATTERNS name the settings-only ceiling", () => {
	const help = renderHelp();
	assert.ok(!help.includes("--ocr-max-pages"));
	assert.match(help, /^  quiver\.docToMd\.ocrMaxPages Most pages one invocation OCRs; .* \(settings-only\) \(default 10\)$/m);
	assert.ok(help.indexOf("quiver.docToMd.ocrMaxPages") > help.indexOf("Tunables"));
	assert.ok(USAGE_PATTERNS.includes("4. OCR is capped at quiver.docToMd.ocrMaxPages pages per call (default 10,"));
});

test("renderHelp: lists every flag and both tables", () => {
	const help = renderHelp();
	for (const d of DOC_TO_MD_OPTIONS) if (d.flag) assert.ok(help.includes(d.flag), d.flag);
	assert.match(help, /Per-call/);
	assert.match(help, /Tunables/);
});
