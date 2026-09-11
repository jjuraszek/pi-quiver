import { test } from "node:test";
import assert from "node:assert";
import {
	DOC_TO_MD_OPTIONS, TUNABLE_DEFAULTS, UsageError, classifyInput, coerceDocToMdSettings,
	parsePages, renderHelp, resolveOptions, sanitizeStem,
} from "../lib/doc-to-md-options.ts";

test("descriptors: every tunable has a flag, default and help; per-call intents are not settable", () => {
	for (const d of DOC_TO_MD_OPTIONS) {
		assert.ok(d.help.length > 0, d.key);
		if (d.key !== "path") assert.match(d.flag!, /^--[a-z-]+$/, d.key);
	}
	const intents = DOC_TO_MD_OPTIONS.filter((d) => !d.settable).map((d) => d.key).sort();
	assert.deepStrictEqual(intents, ["info", "outputDir", "overwrite", "pages", "path"]);
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

test("parsePages: inclusive 1-based, sorted, deduped", () => {
	assert.deepStrictEqual(parsePages("12-15"), [12, 13, 14, 15]);
	assert.deepStrictEqual(parsePages("3,7,10-12,7"), [3, 7, 10, 11, 12]);
	assert.deepStrictEqual(parsePages(" 2 , 1 "), [1, 2]);
	for (const bad of ["", "0", "a", "5-3", "1-", "-2", "1,,2", "1.5"]) assert.throws(() => parsePages(bad), UsageError, bad);
});

test("sanitizeStem: [A-Za-z0-9._-] only, runs collapsed, empty -> document", () => {
	assert.strictEqual(sanitizeStem("My Doc (v2)"), "My_Doc_v2_");
	assert.strictEqual(sanitizeStem("report.final"), "report.final");
	assert.strictEqual(sanitizeStem("Ärger  &  Co"), "_rger_Co");
	assert.strictEqual(sanitizeStem(""), "document");
	assert.strictEqual(sanitizeStem("###"), "_");
});

test("classifyInput: five types, case-insensitive; unsupported names the list", () => {
	assert.strictEqual(classifyInput("A.PDF"), "pdf");
	assert.strictEqual(classifyInput("b.docx"), "docx");
	assert.strictEqual(classifyInput("c.pptx"), "pptx");
	assert.strictEqual(classifyInput("d.xlsx"), "xlsx");
	assert.strictEqual(classifyInput("e.xls"), "xls");
	assert.throws(() => classifyInput("f.xlsm"), /supported: \.pdf, \.docx, \.pptx, \.xlsx, \.xls/);
});

test("renderHelp: lists every flag and both tables", () => {
	const help = renderHelp();
	for (const d of DOC_TO_MD_OPTIONS) if (d.flag) assert.ok(help.includes(d.flag), d.flag);
	assert.match(help, /Per-call/);
	assert.match(help, /Tunables/);
});
