import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCliArgs } from "../bin/pi-quiver.ts";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/pi-quiver.ts", import.meta.url));
const CORE = new URL("../lib/doc-to-md-core.ts", import.meta.url).href;
const FIXTURE_PDF = fileURLToPath(new URL("../test/fixtures/sample.pdf", import.meta.url));
const FIXTURE_DOCX = fileURLToPath(new URL("../test/fixtures/sample.docx", import.meta.url));

// Spec hard rule: no network, no uv/pip, never the real cache dir.
// PATH = node dir only (uv/python/soffice all ENOENT); cache env -> temp dir.
function scrubbedEnv(tmp: string): NodeJS.ProcessEnv {
	return { ...process.env, PATH: dirname(process.execPath), HOME: tmp, XDG_CACHE_HOME: join(tmp, "xdg"), LOCALAPPDATA: join(tmp, "lad") };
}

test("parseCliArgs: doc-to-md happy path", () => {
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "a.pdf"]), { ok: true, cmd: "doc-to-md", path: "a.pdf" });
});

test("parseCliArgs: doc-to-md usage errors", () => {
	for (const argv of [["doc-to-md"], ["doc-to-md", "a.pdf", "b.pdf"], ["doc-to-md", "--raw"]]) {
		const r = parseCliArgs(argv);
		assert.strictEqual(r.ok, false, JSON.stringify(argv));
	}
});

test("CLI subprocess: degraded unpdf conversion, exit 0", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-cli-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", FIXTURE_PDF], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /Engine: unpdf \(degraded fallback\)/);
		assert.match(stdout, /Fallback-Reason: uv not found; no python >= 3\.12 on PATH - install uv, or Python 3\.12\+/);
		assert.match(stdout, /degraded extraction via unpdf/);
		assert.ok(stdout.endsWith("\n") && !stdout.endsWith("\n\n"));
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

// spec: exact byte equality between `convertDocument().output + "\n"` and the CLI's stdout
test("CLI subprocess: stdout is convertDocument().output + newline, byte-identical", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-eq-"));
	try {
		const env = scrubbedEnv(tmp);
		const script = `const { convertDocument, parseConfig } = await import(${JSON.stringify(CORE)});
const r = await convertDocument(${JSON.stringify(FIXTURE_PDF)}, parseConfig(process.env));
process.stdout.write(r.output + "\\n");`;
		const [cli, direct] = await Promise.all([
			execFileAsync(process.execPath, [BIN, "doc-to-md", FIXTURE_PDF], { env }),
			execFileAsync(process.execPath, ["--input-type=module", "-e", script], { env }),
		]);
		assert.strictEqual(cli.stdout, direct.stdout);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: missing file -> exit 1, no stack trace", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-miss-"));
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [BIN, "doc-to-md", "/nope/absent.pdf"], { env: scrubbedEnv(tmp) }),
			(err: { code?: number; stderr?: string }) =>
				err.code === 1 && /doc-to-md failed: Not a readable file/.test(err.stderr ?? "") && !/\n\s+at /.test(err.stderr ?? ""),
		);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: docx without soffice -> exit 1 naming LibreOffice", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-soff-"));
	try {
		await assert.rejects(
			execFileAsync(process.execPath, [BIN, "doc-to-md", FIXTURE_DOCX], { env: scrubbedEnv(tmp) }),
			(err: { code?: number; stderr?: string }) => err.code === 1 && /LibreOffice/.test(err.stderr ?? ""),
		);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: usage error -> exit 2", async () => {
	await assert.rejects(
		execFileAsync(process.execPath, [BIN, "doc-to-md"]),
		(err: { code?: number; stderr?: string }) => err.code === 2 && /Usage:/.test(err.stderr ?? ""),
	);
});
