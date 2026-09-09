import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../lib/unpdf-worker.ts", import.meta.url));
const PDF = fileURLToPath(new URL("../test/fixtures/sample.pdf", import.meta.url));
const MULTIPAGE_PDF = fileURLToPath(new URL("../test/fixtures/multipage.pdf", import.meta.url));
const STALL_PAGE_HOOK = fileURLToPath(new URL("fixtures/stall-page-hook.mjs", import.meta.url));

function run(mode: string, opts: object) {
	const r = spawnSync(process.execPath, [WORKER, mode], { input: JSON.stringify(opts), encoding: "utf8" });
	return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test("unpdf-worker info: pageCount and metadata", () => {
	const r = run("info", { path: PDF });
	assert.strictEqual(r.code, 0, r.err);
	assert.ok(r.out.pageCount >= 1);
	assert.deepStrictEqual(r.out.toc, []);
	assert.strictEqual(typeof r.out.metadata, "object");
});

test("unpdf-worker pdf-text: selected page with canonical separator and no-images note", () => {
	const r = run("pdf-text", { path: PDF, pages: [1] });
	assert.strictEqual(r.code, 0, r.err);
	assert.ok(r.out.markdown.includes("--- end of page.page_number=1 ---"));
	assert.deepStrictEqual(r.out.pages, [1]);
	assert.deepStrictEqual(r.out.notes, ["No images: unpdf backend"]);
	assert.deepStrictEqual(r.out.failedPages, []);
});

function selectedPagePdf(): string {
	const content = "BT /F1 12 Tf 20 100 Td (PAGE-1) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 99 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 200 200] /Contents 4 0 R >>",
		`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
	const xref = Buffer.byteLength(pdf);
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	const dir = mkdtempSync(join(tmpdir(), "quiver-selected-page-pdf-"));
	const path = join(dir, "two-pages.pdf");
	writeFileSync(path, pdf);
	return path;
}

test("unpdf-worker pdf-text: pages [1] never requests toxic unselected page 2", () => {
	const path = selectedPagePdf();
	try {
		const selected = run("pdf-text", { path, pages: [1] });
		assert.strictEqual(selected.code, 0, selected.err);
		assert.deepStrictEqual(selected.out.pages, [1]);
		assert.deepStrictEqual(selected.out.failedPages, []);
		assert.strictEqual(selected.out.pageCount, 2);
		assert.match(selected.out.markdown, /PAGE-1/);

		const toxic = run("pdf-text", { path, pages: [2] });
		assert.strictEqual(toxic.code, 1, toxic.err);

		const info = run("info", { path });
		assert.strictEqual(info.code, 0, info.err);
		assert.strictEqual(info.out.pageCount, 2);
	} finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
});

test("unpdf-worker pdf-text: pages [1] never requests a stalled page 2", () => {
	const dir = mkdtempSync(join(tmpdir(), "quiver-unpdf-stall-page-"));
	const pageLog = join(dir, "pages.log");
	writeFileSync(pageLog, "");
	const env = { ...process.env, STALL_PAGE: "2", PAGE_LOG: pageLog };
	try {
		const selected = spawnSync(process.execPath, ["--import", STALL_PAGE_HOOK, WORKER, "pdf-text"], {
			input: JSON.stringify({ path: MULTIPAGE_PDF, pages: [1] }), encoding: "utf8", env, timeout: 10_000,
		});
		assert.strictEqual(selected.status, 0, selected.stderr);
		const selectedOut = JSON.parse(selected.stdout);
		assert.deepStrictEqual(selectedOut.pages, [1]);
		assert.match(selectedOut.markdown, /PAGE-1/);
		assert.deepStrictEqual(selectedOut.failedPages, []);
		assert.strictEqual(readFileSync(pageLog, "utf8"), "1\n");

		const stalled = spawnSync(process.execPath, ["--import", STALL_PAGE_HOOK, WORKER, "pdf-text"], {
			input: JSON.stringify({ path: MULTIPAGE_PDF, pages: [1, 2] }), encoding: "utf8", env, timeout: 3_000, killSignal: "SIGKILL",
		});
		assert.strictEqual((stalled.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
		assert.strictEqual(stalled.signal, "SIGKILL");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unpdf-worker pdf-text: out of range -> exit 3 with pageCount", () => {
	const r = run("pdf-text", { path: PDF, pages: [999] });
	assert.strictEqual(r.code, 3);
	assert.match(r.out.error, /pages out of range: 999 \(document has \d+ pages\)/);
	assert.ok(r.out.pageCount >= 1);
});

test("unpdf-worker: bad mode -> exit 1; unreadable file -> exit 1", () => {
	const badMode = spawnSync(process.execPath, [WORKER, "nope"], { input: "{}", encoding: "utf8" });
	assert.strictEqual(badMode.status, 1);
	assert.match(badMode.stderr, /usage: unpdf-worker <info\|pdf-text>/);
	assert.strictEqual(run("info", { path: "/nope/x.pdf" }).code, 1);
});
