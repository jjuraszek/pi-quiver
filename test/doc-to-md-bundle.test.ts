import { mock, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { abortBundle, commitBundle, openBundle, ownedCsvPattern, ownedPattern, publishSheetCsvs, publishSheetImages, publishStaged, rewriteLinks, validateImageLinks } from "../lib/doc-to-md-bundle.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "quiver-bundle-"));

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
		for (const overwrite of [false, true]) {
			assert.throws(() => openBundle(root, "manual", overwrite), /Another conversion owns .*manual\.md \(lock: .*\); if no conversion is running, delete the lock/);
		}
		commitBundle(b, "# x\n");
		assert.ok(!existsSync(b.lockPath) && !existsSync(b.stagingDir));
		assert.strictEqual(readFileSync(b.mdPath, "utf8"), "# x\n");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle: existing <stem>.md without overwrite -> Output exists error, lock released", () => {
	const root = tmp();
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "manual.md"), "old");
		assert.throws(() => openBundle(root, "manual", false), /Output exists: .*manual\.md \(pass overwrite\)/);
		assert.ok(!existsSync(join(root, "manual.md.lock")));
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
		mkdirSync(join(b.stagingDir, "p3")); writeFileSync(join(b.stagingDir, "p3", "b.jpeg"), "1"); writeFileSync(join(b.stagingDir, "p3", "a.png"), "2"); writeFileSync(join(b.stagingDir, "p3", ".done"), "");
		mkdirSync(join(b.stagingDir, "p4")); writeFileSync(join(b.stagingDir, "p4", "z.png"), "3");
		const published = publishStaged(b);
		assert.deepStrictEqual([...published.entries()], [[3, ["manual-p3-1.png", "manual-p3-2.jpeg"]]]);
		assert.deepStrictEqual([...published.get(3)!.entries()], [[0, "manual-p3-1.png"], [1, "manual-p3-2.jpeg"]]);
		assert.ok(existsSync(join(b.imagesDir, "manual-p3-1.png")) && !existsSync(join(b.imagesDir, "manual-p4-1.png")));
		assert.deepStrictEqual([...b.manifest].sort(), ["manual-p3-1.png", "manual-p3-2.jpeg"]);
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
