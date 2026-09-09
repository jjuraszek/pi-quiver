import { mock, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { abortBundle, commitBundle, openBundle, ownedPattern, publishStaged, rewriteImageLinks, validateImageLinks } from "../lib/doc-to-md-bundle.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "quiver-bundle-"));

test("ownedPattern: exact stem, p/s, two numbers, extension", () => {
	const re = ownedPattern("manual");
	assert.ok(re.test("manual-p3-1.png") && re.test("manual-s2-10.jpeg"));
	assert.ok(!re.test("manual-v2-p1-1.png") && !re.test("manual-p3-1") && !re.test("xmanual-p3-1.png"));
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

test("openBundle overwrite: deletes <stem>.md, linked files and owned-pattern files only", () => {
	const root = tmp();
	try {
		mkdirSync(join(root, "images"), { recursive: true });
		writeFileSync(join(root, "manual.md"), "![](images/manual-p1-1.png) ![](images/custom.png)");
		for (const f of ["manual-p1-1.png", "custom.png", "manual-p2-1.png", "manual-v2-p1-1.png", "foreign.png"]) writeFileSync(join(root, "images", f), "x");
		const b = openBundle(root, "manual", true);
		assert.ok(!existsSync(join(root, "manual.md")));
		for (const gone of ["manual-p1-1.png", "custom.png", "manual-p2-1.png"]) assert.ok(!existsSync(join(root, "images", gone)), gone);
		for (const kept of ["manual-v2-p1-1.png", "foreign.png"]) assert.ok(existsSync(join(root, "images", kept)), kept);
		abortBundle(b);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("openBundle overwrite: ignores nested and traversal image link targets", () => {
	const parent = tmp();
	const root = join(parent, "bundle");
	try {
		mkdirSync(join(root, "images", "sub"), { recursive: true });
		writeFileSync(join(root, "manual.md"), "![](images/../../victim.txt) ![](images/sub/x.png) ![](images/custom.png)");
		writeFileSync(join(parent, "victim.txt"), "victim");
		writeFileSync(join(root, "images", "sub", "x.png"), "nested");
		writeFileSync(join(root, "images", "custom.png"), "linked");
		const b = openBundle(root, "manual", true);
		assert.ok(existsSync(join(parent, "victim.txt")));
		assert.ok(existsSync(join(root, "images", "sub", "x.png")));
		assert.ok(!existsSync(join(root, "images", "custom.png")));
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
		const md = rewriteImageLinks("![](<p1/a b.png>)", b.sourceMap);
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
		const md = rewriteImageLinks("![](p1/img.png) ![x](p1/img.png)", b.sourceMap);
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
