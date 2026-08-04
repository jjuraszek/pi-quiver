import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, classifyInput, applyGate, withMarker, pagesToMarkdown, DEGRADED_MARKER, soffArgs, warmArgs, convertArgs, runCapped } from "../extensions/doc_to_md.ts";

test("parseConfig: defaults when env unset", () => {
	const c = parseConfig({});
	assert.equal(c.pymupdfVersion, "1.27.2.3");
	assert.equal(c.warmTimeoutMs, 120_000);
	assert.equal(c.convertTimeoutMs, 60_000);
	assert.equal(c.sofficeTimeoutMs, 120_000);
});

test("parseConfig: reads overrides", () => {
	const c = parseConfig({ PI_DOC_TO_MD_PYMUPDF_VERSION: "1.26.0", PI_DOC_TO_MD_CONVERT_TIMEOUT_MS: "5000" });
	assert.equal(c.pymupdfVersion, "1.26.0");
	assert.equal(c.convertTimeoutMs, 5000);
});

test("parseConfig: rejects bad version pin (injection guard)", () => {
	assert.throws(() => parseConfig({ PI_DOC_TO_MD_PYMUPDF_VERSION: "1.0; rm -rf /" }), /PI_DOC_TO_MD_PYMUPDF_VERSION/);
});

test("parseConfig: rejects non-positive / NaN timeout", () => {
	assert.throws(() => parseConfig({ PI_DOC_TO_MD_WARM_TIMEOUT_MS: "0" }), /PI_DOC_TO_MD_WARM_TIMEOUT_MS/);
	assert.throws(() => parseConfig({ PI_DOC_TO_MD_CONVERT_TIMEOUT_MS: "abc" }), /PI_DOC_TO_MD_CONVERT_TIMEOUT_MS/);
});

test("classifyInput: routes by extension, case-insensitive", () => {
	assert.equal(classifyInput("/a/b.pdf"), "pdf");
	assert.equal(classifyInput("/a/b.PDF"), "pdf");
	assert.equal(classifyInput("report.docx"), "docx");
	assert.equal(classifyInput("deck.pptx"), "pptx");
});

test("classifyInput: rejects unsupported", () => {
	assert.throws(() => classifyInput("data.xlsx"), /unsupported/i);
	assert.throws(() => classifyInput("notes.txt"), /unsupported/i);
});

test("applyGate: small inline, large spills", () => {
	assert.equal(applyGate("hi").spill, false);
	assert.equal(applyGate("x".repeat(33_000)).spill, true);
	assert.equal(applyGate(Array(1_001).fill("a").join("\n")).spill, true);
	assert.equal(applyGate("").spill, false);
});

test("withMarker: prepends exact marker only when degraded", () => {
	assert.equal(withMarker("body", false), "body");
	assert.equal(withMarker("body", true), `${DEGRADED_MARKER}\n\nbody`);
});

test("pagesToMarkdown: joins pages with separator, trims", () => {
	assert.equal(pagesToMarkdown(["a", "b"]), `a${"\n\n---\n\n"}b`);
	assert.equal(pagesToMarkdown(["  only  "]), "only");
});

test("warmArgs: pins version + python 3.14 + import probe", () => {
	const a = warmArgs(parseConfig({}));
	assert.deepEqual(a, ["run", "--with", "pymupdf4llm==1.27.2.3", "--python", "3.14", "python", "-c", "import pymupdf4llm"]);
});

test("convertArgs: pins version + runs the script with the pdf path", () => {
	const a = convertArgs(parseConfig({}), "/pkg/scripts/pdf_to_md.py", "/tmp/x.pdf");
	assert.deepEqual(a, ["run", "--with", "pymupdf4llm==1.27.2.3", "--python", "3.14", "python", "/pkg/scripts/pdf_to_md.py", "/tmp/x.pdf"]);
});

test("soffArgs: headless flags + isolated profile + convert-to pdf", () => {
	const a = soffArgs("/in/deck.pptx", "/tmp/prof", "/tmp/out");
	assert.ok(a.includes("--headless") && a.includes("--convert-to") && a.includes("pdf"));
	assert.ok(a.includes("-env:UserInstallation=file:///tmp/prof"));
	assert.equal(a[a.length - 1], "/in/deck.pptx");
	const oi = a.indexOf("--outdir");
	assert.equal(a[oi + 1], "/tmp/out");
});

test("runCapped: captures stdout + exit code", async () => {
	const r = await runCapped("printf", ["hello"], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.stdout, "hello");
	assert.equal(r.code, 0);
	assert.equal(r.timedOut, false);
	assert.equal(r.capped, false);
});

test("runCapped: non-zero exit captured", async () => {
	const r = await runCapped("sh", ["-c", "echo oops 1>&2; exit 3"], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.code, 3);
	assert.match(r.stderr, /oops/);
});

test("runCapped: timeout kills the child", async () => {
	const r = await runCapped("sh", ["-c", "sleep 5"], { timeoutMs: 200, capBytes: 1000 });
	assert.equal(r.timedOut, true);
});

test("runCapped: output cap trips and kills the child", async () => {
	const r = await runCapped("sh", ["-c", "yes x | head -c 100000"], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.capped, true);
	assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 1000 + 64);
});

test("runCapped: spawn error (ENOENT) resolves with code null, does not reject", async () => {
	const r = await runCapped("this_binary_does_not_exist_xyz", [], { timeoutMs: 5000, capBytes: 1000 });
	assert.equal(r.code, null);
	assert.equal(r.timedOut, false);
	assert.equal(r.capped, false);
	assert.match(r.stderr, /ENOENT/);
});
