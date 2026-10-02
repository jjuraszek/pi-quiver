import { mock, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { abortBundle, commitBundle, openBundle, ownedOcrPattern, publishWords, publishSidecars, writePageStats, ownedCsvPattern, ownedPattern, publishAttachments, publishPageImages, publishSheetCsvs, publishSheetImages, publishStaged, rewriteLinks, validateImageLinks } from "../lib/doc-to-md-bundle.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "quiver-bundle-"));

test("publishStaged: truncated completion metadata still publishes the page", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "scan", false);
		const dir = join(b.stagingDir, "p1");
		mkdirSync(dir);
		writeFileSync(join(dir, "page.jpeg"), "image");
		writeFileSync(join(dir, ".done"), '{"native":');
		assert.deepStrictEqual(publishStaged(b).get(1), { files: ["scan-p1-1.jpeg"], meta: {} });
		assert.strictEqual(readFileSync(join(b.imagesDir, "scan-p1-1.jpeg"), "utf8"), "image");
		assert.strictEqual(b.sourceMap.get("p1/page.jpeg"), "images/scan-p1-1.jpeg");
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const raw of ["null", "[1]"]) test(`publishStaged: non-object completion metadata ${raw} still publishes the page`, () => {
	const root = tmp();
	try {
		const b = openBundle(root, "scan", false);
		const dir = join(b.stagingDir, "p1");
		mkdirSync(dir);
		writeFileSync(join(dir, "page.jpeg"), "image");
		writeFileSync(join(dir, ".done"), raw);
		assert.deepStrictEqual(publishStaged(b).get(1), { files: ["scan-p1-1.jpeg"], meta: {} });
		assert.strictEqual(readFileSync(join(b.imagesDir, "scan-p1-1.jpeg"), "utf8"), "image");
		assert.strictEqual(b.sourceMap.get("p1/page.jpeg"), "images/scan-p1-1.jpeg");
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("ownedPattern / ownedCsvPattern: exact stem; p/s with optional second number; csv slug form", () => {
	const re = ownedPattern("x");
	assert.ok(re.test("x-p1-1.png") && re.test("x-s2-10.jpeg") && re.test("x-s3-1.png") && re.test("x-s3.png"));
	assert.ok(!re.test("y-s3.png") && !re.test("x-v2-p1-1.png") && !re.test("x-p3-1") && !re.test("xx-p3-1.png") && !re.test("x-s3-data.csv"));
	const csv = ownedCsvPattern("x");
	assert.ok(csv.test("x-s0-data.csv") && csv.test("x-s12-a-b.csv"));
	assert.ok(!csv.test("y-s0-data.csv") && !csv.test("x-s0-data.txt") && !csv.test("x-s0.csv"));
});

test("openBundle: creates root, images, staging; lock held; second open fails fast with the lock message", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		assert.ok(existsSync(b.lockPath) && existsSync(b.imagesDir) && existsSync(b.stagingDir));
		assert.ok(b.stagingDir.startsWith(join(b.imagesDir, ".stage-")));
		assert.throws(() => openBundle(root, "manual", true), /Another conversion owns .*manual\.md/);
		const renamed = openBundle(root, "manual", false);
		assert.strictEqual(renamed.stem, "manual-2");
		assert.strictEqual(renamed.renamedFrom, "manual");
		assert.strictEqual(renamed.renameReason, "manual.md.lock held; delete it if no conversion is running");
		abortBundle(renamed);
		commitBundle(b, "# x\n");
		assert.ok(!existsSync(b.lockPath) && !existsSync(b.stagingDir));
		assert.strictEqual(readFileSync(b.mdPath, "utf8"), "# x\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle: existing <stem>.md without overwrite -> <stem>-2, then -3; a held .lock is skipped too", () => {
	const root = tmp();
	try {
		writeFileSync(join(root, "manual.md"), "old");
		const b2 = openBundle(root, "manual", false);
		assert.strictEqual(b2.stem, "manual-2");
		assert.strictEqual(b2.renamedFrom, "manual");
		assert.strictEqual(b2.renameReason, "manual.md exists");
		assert.ok(b2.mdPath.endsWith("manual-2.md") && existsSync(b2.lockPath));
		writeFileSync(join(root, "manual-3.md.lock"), "");
		const b4 = openBundle(root, "manual", false);
		assert.strictEqual(b4.stem, "manual-4");
		assert.strictEqual(openBundle(root, "fresh", false).renamedFrom, null);
		assert.ok(!existsSync(join(root, "manual.md.lock")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle: re-checks markdown after acquiring a candidate lock", () => {
	const root = tmp();
	const originalOpen = fs.openSync;
	try {
		const injected = mock.method(fs, "openSync", (path: fs.PathLike, flags: fs.OpenMode) => {
			if (path === join(root, "manual.md.lock")) writeFileSync(join(root, "manual.md"), "racing commit");
			return originalOpen(path, flags);
		});
		syncBuiltinESMExports();
		const b = openBundle(root, "manual", false);
		assert.strictEqual(b.stem, "manual-2");
		assert.strictEqual(readFileSync(join(root, "manual.md"), "utf8"), "racing commit");
		assert.ok(!existsSync(join(root, "manual.md.lock")));
		abortBundle(b);
		injected.mock.restore();
	} finally { mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("pages/ and attachments/: staged files publish to stem-prefixed names, links rewrite and validate, abort removes them", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "m", false);
		mkdirSync(b.pagesStagingDir, { recursive: true }); mkdirSync(b.attachmentsStagingDir, { recursive: true });
		writeFileSync(join(b.pagesStagingDir, "p3.png"), "x"); writeFileSync(join(b.pagesStagingDir, "p12.png"), "y");
		writeFileSync(join(b.attachmentsStagingDir, "notes.txt"), "n");
		publishPageImages(b, 12);
		publishAttachments(b);
		assert.deepStrictEqual([...b.pageManifest].sort(), ["m-p03.png", "m-p12.png"]);
		assert.deepStrictEqual([...b.attachmentManifest], ["m-notes.txt"]);
		assert.ok(existsSync(join(root, "pages", "m-p03.png")) && existsSync(join(root, "attachments", "m-notes.txt")));
		const md = rewriteLinks("![page 3](pages/p3.png) [`notes.txt`](attachments/notes.txt)", b.sourceMap);
		assert.strictEqual(md, "![page 3](pages/m-p03.png) [`notes.txt`](attachments/m-notes.txt)");
		validateImageLinks(md, b.manifest, b.csvManifest, false, b.pageManifest, b.attachmentManifest);
		assert.throws(() => validateImageLinks("![](pages/other.png)", b.manifest, b.csvManifest, false, b.pageManifest, b.attachmentManifest), /unexpected image reference/);
		assert.throws(() => validateImageLinks("[x](attachments/evil.txt)", b.manifest, b.csvManifest, false, b.pageManifest, b.attachmentManifest), /unexpected attachment reference/);
		abortBundle(b);
		assert.ok(!existsSync(join(root, "pages", "m-p03.png")) && !existsSync(join(root, "attachments", "m-notes.txt")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle overwrite: removes linked attachments and owned pages without touching sibling attachments", () => {
	const root = tmp();
	try {
		mkdirSync(join(root, "pages"), { recursive: true }); mkdirSync(join(root, "attachments"), { recursive: true });
		writeFileSync(join(root, "m.md"), "[a](attachments/m-a.txt) [report](attachments/m-2024-x.pdf)");
		for (const f of ["m-p01.png", "other-p01.png"]) writeFileSync(join(root, "pages", f), "x");
		for (const f of ["m-a.txt", "m-2024-x.pdf", "m-notes-a.txt", "m-2-notes.txt", "other-a.txt"]) writeFileSync(join(root, "attachments", f), "x");
		const b = openBundle(root, "m", true);
		assert.deepStrictEqual(readdirSync(join(root, "pages")).filter((f) => !f.startsWith(".")), ["other-p01.png"]);
		assert.deepStrictEqual(readdirSync(join(root, "attachments")).filter((f) => !f.startsWith(".")), ["m-2-notes.txt", "m-notes-a.txt", "other-a.txt"]);
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle overwrite: deletes <stem>.md and owned-pattern files only", () => {
	const root = tmp();
	try {
		mkdirSync(join(root, "images"), { recursive: true });
		writeFileSync(join(root, "manual.md"), "![](images/manual-p1-1.png) ![](images/manual-custom.png)");
		for (const f of ["manual-p1-1.png", "manual-custom.png", "manual-p2-1.png", "manual-v2-p1-1.png", "foreign.png"]) writeFileSync(join(root, "images", f), "x");
		const b = openBundle(root, "manual", true);
		assert.ok(!existsSync(join(root, "manual.md")));
		for (const gone of ["manual-p1-1.png", "manual-p2-1.png"]) assert.ok(!existsSync(join(root, "images", gone)), gone);
		for (const kept of ["manual-custom.png", "manual-v2-p1-1.png", "foreign.png"]) assert.ok(existsSync(join(root, "images", kept)), kept);
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle overwrite: ignores nested and traversal image link targets", () => {
	const parent = tmp();
	const root = join(parent, "bundle");
	try {
		mkdirSync(join(root, "images", "sub"), { recursive: true });
		writeFileSync(join(root, "manual.md"), "![](images/../../victim.txt) ![](images/sub/x.png) ![](images/manual-custom.png)");
		writeFileSync(join(parent, "victim.txt"), "victim");
		writeFileSync(join(root, "images", "sub", "x.png"), "nested");
		writeFileSync(join(root, "images", "manual-custom.png"), "linked");
		const b = openBundle(root, "manual", true);
		assert.ok(existsSync(join(parent, "victim.txt")));
		assert.ok(existsSync(join(root, "images", "sub", "x.png")));
		assert.ok(existsSync(join(root, "images", "manual-custom.png")));
		abortBundle(b);
	} finally { rmSync(parent, { recursive: true, force: true }); }
});

test("publishStaged: only .done pages move, named <stem>-p<N>-<n>.<ext>, recorded in manifest", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		mkdirSync(join(b.stagingDir, "p3")); writeFileSync(join(b.stagingDir, "p3", "b.jpeg"), "1"); writeFileSync(join(b.stagingDir, "p3", "a.png"), "2"); writeFileSync(join(b.stagingDir, "p3", ".done"), JSON.stringify({ native: { file: "a.png", width: 40, height: 30 } }));
		mkdirSync(join(b.stagingDir, "p5")); writeFileSync(join(b.stagingDir, "p5", "c.png"), "x"); writeFileSync(join(b.stagingDir, "p5", ".done"), " \n");
		mkdirSync(join(b.stagingDir, "p6")); writeFileSync(join(b.stagingDir, "p6", ".done"), "");
		mkdirSync(join(b.stagingDir, "p4")); writeFileSync(join(b.stagingDir, "p4", "z.png"), "3");
		const published = publishStaged(b);
		assert.deepStrictEqual([...published.entries()], [
			[3, { files: ["manual-p3-1.png", "manual-p3-2.jpeg"], meta: { native: { file: "manual-p3-1.png", width: 40, height: 30 } } }],
			[5, { files: ["manual-p5-1.png"], meta: {} }],
			[6, { files: [], meta: {} }],
		]);
		assert.ok(existsSync(join(b.imagesDir, "manual-p3-1.png")) && !existsSync(join(b.imagesDir, "manual-p4-1.png")));
		assert.deepStrictEqual([...b.manifest].sort(), ["manual-p3-1.png", "manual-p3-2.jpeg", "manual-p5-1.png"]);
		assert.ok(!existsSync(join(b.stagingDir, "p3")));
		abortBundle(b);
		assert.ok(!existsSync(join(b.imagesDir, "manual-p3-1.png")) && !existsSync(b.lockPath) && !existsSync(b.stagingDir));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("abortBundle: removes manifest images but preserves foreign images and releases the lock", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "image.png"), "owned"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
		publishStaged(b);
		writeFileSync(join(b.imagesDir, "keep-me.png"), "foreign");
		abortBundle(b);
		assert.ok(!existsSync(join(b.imagesDir, "manual-p1-1.png")));
		assert.ok(existsSync(join(b.imagesDir, "keep-me.png")));
		assert.ok(!existsSync(b.lockPath));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("commitBundle: moved bundle keeps every Markdown image link resolvable", () => {
	const root = tmp();
	const moved = `${root}-moved`;
	try {
		const b = openBundle(root, "manual", false);
		mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "image.png"), "image"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
		publishStaged(b);
		commitBundle(b, "![](images/manual-p1-1.png)\n");
		renameSync(root, moved);
		const mdPath = join(moved, "manual.md");
		for (const target of readFileSync(mdPath, "utf8").matchAll(/!\[[^\]]*\]\(([^ )]+)\)/g)) {
			assert.ok(statSync(resolve(dirname(mdPath), target[1])).isFile(), target[1]);
		}
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});

test("rewriteImageLinks: rewrites angle-bracket destinations with spaces", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "doc", false);
		mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "a b.png"), "1"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
		publishStaged(b);
		const md = rewriteLinks("![](<p1/a b.png>)", b.sourceMap);
		assert.strictEqual(md, "![](images/doc-p1-1.png)");
		validateImageLinks(md, b.manifest);
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("commitBundle: staging cleanup failure after publish preserves Markdown and manifest images", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "doc", false);
		mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "img.png"), "1"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
		publishStaged(b);
		const originalRmSync = fs.rmSync;
		const rmSyncMock = mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmDirOptions) => {
			if (path === b.stagingDir) {
				rmSyncMock.mock.restore();
				throw new Error("injected staging cleanup failure");
			}
			return originalRmSync(path, options);
		});
		assert.doesNotThrow(() => commitBundle(b, "![](images/doc-p1-1.png)\n"));
		assert.strictEqual(readFileSync(b.mdPath, "utf8"), "![](images/doc-p1-1.png)\n");
		assert.ok(existsSync(join(b.imagesDir, "doc-p1-1.png")));
		assert.ok(existsSync(b.stagingDir));
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishStaged: sources map lets Node rewrite links exactly; commit is atomic (no partial md on abort)", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "doc", false);
		mkdirSync(join(b.stagingDir, "p1")); writeFileSync(join(b.stagingDir, "p1", "img.png"), "1"); writeFileSync(join(b.stagingDir, "p1", ".done"), "");
		publishStaged(b);
		const md = rewriteLinks("![](p1/img.png) ![x](p1/img.png)", b.sourceMap);
		assert.strictEqual(md, "![](images/doc-p1-1.png) ![x](images/doc-p1-1.png)");
		validateImageLinks(md, b.manifest);
		assert.throws(() => validateImageLinks("![](images/other.png)", b.manifest), /unexpected image reference/);
		assert.throws(() => validateImageLinks("![](../x.png)", b.manifest), /unexpected image reference/);
		assert.throws(() => validateImageLinks("![](<p1/a b.png>)", b.manifest), /unexpected image reference/);
		assert.throws(() => validateImageLinks("<img src='images/other.png'>", b.manifest), /unexpected image reference/);
		assert.throws(() => validateImageLinks("<img src=images/other.png>", b.manifest), /unexpected image reference/);
		abortBundle(b);
		assert.ok(!existsSync(b.mdPath) && !existsSync(`${b.mdPath}.tmp`));
	} finally { rmSync(root, { recursive: true, force: true }); }
});


test("publishSheetImages: rendered views s<idx>.<fmt> and embedded s<idx>-<n>.<ext> both publish under the stem", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "book", false);
		writeFileSync(join(b.stagingDir, "s0.png"), "r"); writeFileSync(join(b.stagingDir, "s0-1.png"), "i"); writeFileSync(join(b.stagingDir, "junk.txt"), "x");
		publishSheetImages(b);
		assert.ok(existsSync(join(b.imagesDir, "book-s0.png")) && existsSync(join(b.imagesDir, "book-s0-1.png")));
		assert.deepStrictEqual([...b.manifest].sort(), ["book-s0-1.png", "book-s0.png"]);
		assert.equal(b.sourceMap.get("s0.png"), "images/book-s0.png");
		assert.ok(existsSync(join(b.stagingDir, "junk.txt")));
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishSheetCsvs: lazily created sheets/, csvManifest + sourceMap, imageCount unaffected; no staging dir is a no-op", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "book", false);
		assert.equal(b.sheetsDir, join(root, "sheets"));
		assert.ok(b.sheetsStagingDir.startsWith(join(b.sheetsDir, ".stage-")));
		assert.ok(!existsSync(b.sheetsDir));
		publishSheetCsvs(b);
		assert.ok(!existsSync(b.sheetsDir) && b.csvManifest.size === 0);
		mkdirSync(b.sheetsStagingDir, { recursive: true });
		writeFileSync(join(b.sheetsStagingDir, "s0-data.csv"), "a,b\r\n"); writeFileSync(join(b.sheetsStagingDir, "s2-a-b.csv"), "x\r\n");
		publishSheetCsvs(b);
		assert.deepStrictEqual([...b.csvManifest].sort(), ["book-s0-data.csv", "book-s2-a-b.csv"]);
		assert.equal(b.manifest.size, 0);
		assert.equal(b.sourceMap.get("sheets/s0-data.csv"), "sheets/book-s0-data.csv");
		assert.ok(existsSync(join(b.sheetsDir, "book-s0-data.csv")));
		const md = rewriteLinks("Data: [sheets/s0-data.csv](sheets/s0-data.csv)\n", b.sourceMap);
		assert.equal(md, "Data: [sheets/book-s0-data.csv](sheets/book-s0-data.csv)\n");
		validateImageLinks(md, b.manifest, b.csvManifest);
		assert.throws(() => validateImageLinks("[x](sheets/book-s9-nope.csv)", b.manifest, b.csvManifest), /unexpected sheet reference in output: sheets\/book-s9-nope\.csv/);
		commitBundle(b, md);
		assert.ok(!existsSync(b.sheetsStagingDir) && existsSync(join(b.sheetsDir, "book-s0-data.csv")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("abortBundle removes staged + published CSVs; overwrite cleans only this stem's sheets/ and images/", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "book", false);
		mkdirSync(b.sheetsStagingDir, { recursive: true });
		writeFileSync(join(b.sheetsStagingDir, "s0-data.csv"), "a\r\n");
		publishSheetCsvs(b);
		writeFileSync(join(b.sheetsDir, "other-s0-data.csv"), "keep");
		abortBundle(b);
		assert.ok(!existsSync(join(b.sheetsDir, "book-s0-data.csv")) && existsSync(join(b.sheetsDir, "other-s0-data.csv")) && !existsSync(b.sheetsStagingDir));
		writeFileSync(join(root, "book.md"), "[book](sheets/book-custom.csv) [other](sheets/other-s1-x.csv)\n![](images/book-custom.png) ![](images/other-s0.png)\n");
		writeFileSync(join(b.sheetsDir, "book-custom.csv"), "x"); writeFileSync(join(b.sheetsDir, "book-s7-owned.csv"), "x"); writeFileSync(join(b.sheetsDir, "other-s1-x.csv"), "keep");
		mkdirSync(join(root, "images"), { recursive: true }); writeFileSync(join(root, "images", "book-custom.png"), "x"); writeFileSync(join(root, "images", "book-s0.png"), "x"); writeFileSync(join(root, "images", "other-s0.png"), "keep");
		const b2 = openBundle(root, "book", true);
		assert.ok(existsSync(join(b2.sheetsDir, "book-custom.csv")) && !existsSync(join(b2.sheetsDir, "book-s7-owned.csv")));
		assert.ok(existsSync(join(b2.sheetsDir, "other-s0-data.csv")) && existsSync(join(b2.sheetsDir, "other-s1-x.csv")));
		assert.ok(existsSync(join(root, "images", "book-custom.png")) && !existsSync(join(root, "images", "book-s0.png")) && existsSync(join(root, "images", "other-s0.png")));
		abortBundle(b2);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

function stageSidecar(b: { ocrStagingDir: string; stem: string }, page: number, done: boolean, body = "text") {
	const tag = `p${String(page).padStart(3, "0")}`;
	const d = join(b.ocrStagingDir, tag); mkdirSync(d, { recursive: true });
	writeFileSync(join(d, `${b.stem}-${tag}.md`), `<!-- OCR of page ${page} (tesseract eng); recognized text, not the text layer -->\n\n${body}\n\n--- end of page.page_number=${page} ---\n`);
	if (done) writeFileSync(join(d, ".done"), "");
}

test("ownedOcrPattern: exact stem, p + digits + .md or .words.json", () => {
	assert.ok(ownedOcrPattern("manual").test("manual-p002.words.json"));
	assert.ok(!ownedOcrPattern("manual").test("manual-2-p002.words.json"));
	const re = ownedOcrPattern("x");
	assert.ok(re.test("x-p002.md") && re.test("x-p1234.md"));
	assert.ok(!re.test("x-2-p002.md") && !re.test("xx-p002.md") && !re.test("x-p002.txt") && !re.test("x-p2-1.png"));
});

test("writePageStats + publishSidecars: stats beside the Markdown, only .done sidecars move, manifest + map, staging removed", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		assert.strictEqual(b.pageStatsPath, join(root, "manual.pages.json"));
		assert.strictEqual(b.ocrDir, join(root, "ocr"));
		assert.ok(b.ocrStagingDir.startsWith(join(root, "ocr", ".stage-")));
		writePageStats(b, [{ page: 1, chars: 12, images: 0, imageCoverage: 0 }, { page: 2, error: "RuntimeError: x" }]);
		assert.deepStrictEqual(JSON.parse(readFileSync(b.pageStatsPath, "utf8")), [{ page: 1, chars: 12, images: 0, imageCoverage: 0 }, { page: 2, error: "RuntimeError: x" }]);
		stageSidecar(b, 2, true); stageSidecar(b, 7, true); stageSidecar(b, 9, false);
		writeFileSync(join(b.ocrStagingDir, "active"), "9");
		const { sidecars, wordSidecars } = publishSidecars(b);
		assert.deepStrictEqual([...wordSidecars], []);
		assert.deepStrictEqual([...sidecars.entries()], [[2, join(root, "ocr", "manual-p002.md")], [7, join(root, "ocr", "manual-p007.md")]]);
		assert.deepStrictEqual([...b.ocrManifest].sort(), ["manual-p002.md", "manual-p007.md"]);
		assert.deepStrictEqual(readdirSync(join(root, "ocr")).sort(), ["manual-p002.md", "manual-p007.md"]);
		assert.ok(!existsSync(b.ocrStagingDir));
		stageSidecar(b, 10, false);
		commitBundle(b, "x\n");
		assert.ok(!existsSync(b.ocrStagingDir));
		assert.ok(existsSync(b.pageStatsPath) && existsSync(join(root, "ocr", "manual-p002.md")) && !existsSync(b.lockPath));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishSidecars: no staging dir is a no-op; abortBundle removes published sidecars, staging and the stats file", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		const { sidecars, wordSidecars } = publishSidecars(b);
		assert.deepStrictEqual([...sidecars], []);
		assert.deepStrictEqual([...wordSidecars], []);
		writePageStats(b, []);
		stageSidecar(b, 1, true);
		writeFileSync(join(b.ocrStagingDir, "p001", "manual-p001.words.json"), "{}");
		publishSidecars(b);
		stageSidecar(b, 2, false);
		mkdirSync(join(root, "ocr"), { recursive: true }); writeFileSync(join(root, "ocr", "other-p001.md"), "foreign");
		abortBundle(b);
		assert.ok(!existsSync(b.pageStatsPath) && !existsSync(join(root, "ocr", "manual-p001.md")) && !existsSync(b.lockPath));
		assert.ok(existsSync(join(root, "ocr", "other-p001.md")));
		assert.ok(!existsSync(b.ocrStagingDir));
		assert.ok(!existsSync(join(root, "ocr", "manual-p001.words.json")));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle: two stems keep separate stats files; overwrite removes only this stem's pages.json and ocr/ files; held lock refuses overwrite", () => {
	const root = tmp();
	try {
		const a = openBundle(root, "report", false); writePageStats(a, [{ page: 1, chars: 1, images: 0, imageCoverage: 0 }]); stageSidecar(a, 1, true); publishSidecars(a); commitBundle(a, "a\n");
		writeFileSync(join(root, "report.words.json"), "original words");
		const b2 = openBundle(root, "report", false);
		assert.strictEqual(b2.stem, "report-2");
		assert.strictEqual(b2.pageStatsPath, join(root, "report-2.pages.json"));
		assert.strictEqual(b2.wordsPath, join(root, "report-2.words.json"));
		writeFileSync(join(b2.stagingDir, "words.json"), '{"unit":"pt","pages":[]}\n');
		assert.strictEqual(publishWords(b2), null);
		assert.strictEqual(readFileSync(join(root, "report-2.words.json"), "utf8"), '{"unit":"pt","pages":[]}\n');
		assert.strictEqual(readFileSync(join(root, "report.words.json"), "utf8"), "original words");
		writePageStats(b2, []); stageSidecar(b2, 1, true); publishSidecars(b2); commitBundle(b2, "b\n");
		assert.deepStrictEqual(readdirSync(join(root, "ocr")).sort(), ["report-2-p001.md", "report-p001.md"]);
		writeFileSync(join(root, "report.words.json"), "{}");
		const again = openBundle(root, "report", true);
		assert.ok(!existsSync(join(root, "report.words.json")));
		assert.ok(!existsSync(join(root, "report.pages.json")) && !existsSync(join(root, "ocr", "report-p001.md")));
		assert.ok(existsSync(join(root, "report-2.pages.json")) && existsSync(join(root, "ocr", "report-2-p001.md")));
		assert.throws(() => openBundle(root, "report", true), /Another conversion owns .*report\.md/);
		abortBundle(again);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishWords: renames staged words.json beside pages.json; missing stage -> write failed reason; abort removes it", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		assert.strictEqual(b.wordsPath, join(root, "manual.words.json"));
		writeFileSync(b.wordsPath, "partial target");
		assert.strictEqual(publishWords(b), "write failed - child staged no words.json");
		assert.ok(!existsSync(b.wordsPath));
		writeFileSync(join(b.stagingDir, "words.json"), '{"unit":"pt","pages":[]}\n');
		assert.strictEqual(publishWords(b), null);
		assert.deepStrictEqual(JSON.parse(readFileSync(b.wordsPath, "utf8")), { unit: "pt", pages: [] });
		assert.ok(!existsSync(join(b.stagingDir, "words.json")));
		abortBundle(b);
		assert.ok(!existsSync(b.wordsPath));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishSidecars: completed pages publish both sidecars, killed and .failed pages publish neither; overwrite removes stale sidecars", () => {
	const root = tmp();
	try {
		const b = openBundle(root, "manual", false);
		for (const [n, done] of [[1, true], [2, false]] as const) {
			stageSidecar(b, n, done);
			writeFileSync(join(b.ocrStagingDir, `p00${n}`, `manual-p00${n}.words.json`), "{}");
		}
		const failedDir = join(b.ocrStagingDir, "p003");
		mkdirSync(failedDir);
		writeFileSync(join(failedDir, ".failed"), "RuntimeError: tesseract exploded");
		writeFileSync(join(failedDir, "manual-p003.words.json"), "{}");
		writeFileSync(join(b.ocrStagingDir, "active"), "2");
		const { sidecars, wordSidecars } = publishSidecars(b);
		assert.ok(existsSync(join(b.ocrDir, "manual-p001.md")));
		assert.strictEqual(readFileSync(join(b.ocrDir, "manual-p001.words.json"), "utf8"), "{}");
		assert.deepStrictEqual([...sidecars], [[1, join(b.ocrDir, "manual-p001.md")]]);
		assert.deepStrictEqual([...wordSidecars], [[1, join(b.ocrDir, "manual-p001.words.json")]]);
		assert.deepStrictEqual([...b.ocrManifest].sort(), ["manual-p001.md", "manual-p001.words.json"]);
		assert.ok(!existsSync(join(b.ocrDir, "manual-p002.md")));
		assert.ok(!existsSync(join(b.ocrDir, "manual-p002.words.json")));
		assert.ok(!existsSync(join(b.ocrDir, "manual-p003.md")));
		assert.ok(!existsSync(join(b.ocrDir, "manual-p003.words.json")));
		assert.ok(!existsSync(b.ocrStagingDir));
		commitBundle(b, "md\n");
		const b2 = openBundle(root, "manual", true);
		assert.ok(!existsSync(join(root, "ocr", "manual-p001.words.json")) && !existsSync(join(root, "ocr", "manual-p001.md")));
		abortBundle(b2);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
