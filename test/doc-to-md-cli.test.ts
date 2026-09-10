import { test } from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliAgentDir, parseCliArgs, readCliSettings } from "../bin/pi-quiver.ts";
import { DOC_TO_MD_OPTIONS } from "../lib/doc-to-md-core.ts";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/pi-quiver.ts", import.meta.url));
const MULTIPAGE = fileURLToPath(new URL("../test/fixtures/multipage.pdf", import.meta.url));
const FIXTURE_DOCX = fileURLToPath(new URL("../test/fixtures/sample.docx", import.meta.url));

// Spec hard rule: no network, no uv/pip, never the real cache dir.
// PATH = node dir only (uv/python/soffice all ENOENT); cache env -> temp dir.
function scrubbedEnv(tmp: string): NodeJS.ProcessEnv {
	return { ...process.env, PATH: dirname(process.execPath), HOME: tmp, XDG_CACHE_HOME: join(tmp, "xdg"), LOCALAPPDATA: join(tmp, "lad") };
}

test("parseCliArgs: doc-to-md flags map to per-call input", () => {
	const r = parseCliArgs(["doc-to-md", "--pages", "2-3", "--output-dir", "out", "--overwrite", "--primary-timeout", "5000", "--image-format", "jpg", "a.pdf"]);
	assert.deepStrictEqual(r, { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", pages: "2-3", outputDir: "out", overwrite: true, primaryTimeoutMs: 5000, imageFormat: "jpg" } });
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--info", "a.pdf"]), { ok: true, cmd: "doc-to-md", perCall: { path: "a.pdf", info: true } });
	assert.deepStrictEqual(parseCliArgs(["doc-to-md", "--help"]), { ok: true, cmd: "doc-to-md-help" });
});

test("parseCliArgs: every doc-to-md descriptor flag round-trips", () => {
	for (const d of DOC_TO_MD_OPTIONS) {
		if (!d.flag) continue;
		const value = d.type === "int" ? "7"
			: d.type === "enum" ? d.enumValues![0]
			: d.type === "version" ? "1.27.2.3"
			: d.type === "pages" ? "1-2"
			: "x";
		const r = parseCliArgs(["doc-to-md", d.flag, ...(d.type === "bool" ? [] : [value]), "a.pdf"]);
		assert.deepStrictEqual({ ok: r.ok, cmd: r.ok ? r.cmd : undefined }, { ok: true, cmd: "doc-to-md" }, d.flag);
		if (!r.ok || r.cmd !== "doc-to-md") continue;
		assert.strictEqual(r.perCall[d.key], d.type === "int" ? 7 : d.type === "bool" ? true : value, d.flag);
		if (d.type === "int") assert.strictEqual(parseCliArgs(["doc-to-md", d.flag, "not-a-number", "a.pdf"]).ok, false, d.flag);
	}
});

test("parseCliArgs: doc-to-md usage errors", () => {
	for (const argv of [["doc-to-md"], ["doc-to-md", "a.pdf", "b.pdf"], ["doc-to-md", "--raw", "a.pdf"], ["doc-to-md", "--pages"], ["doc-to-md", "--primary-timeout", "x", "a.pdf"]]) {
		assert.strictEqual(parseCliArgs(argv).ok, false, JSON.stringify(argv));
	}
});

test("readCliSettings: agent dir from PI_CODING_AGENT_DIR (tilde expanded, empty = unset), project wins", () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-cli-set-"));
	try {
		mkdirSync(join(tmp, "agent")); writeFileSync(join(tmp, "agent", "settings.json"), JSON.stringify({ quiver: { docToMd: { primaryTimeoutMs: 111, imageDpi: 72 } } }));
		mkdirSync(join(tmp, "proj", ".pi"), { recursive: true }); writeFileSync(join(tmp, "proj", ".pi", "settings.json"), JSON.stringify({ quiver: { docToMd: { primaryTimeoutMs: 222, bogus: 1, bogus2: 2 } } }));
		const warnings: string[] = [];
		const s = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: join(tmp, "agent") }, (m) => warnings.push(m));
		assert.deepStrictEqual(s, { primaryTimeoutMs: 222, imageDpi: 72 });
		const unknownWarnings = warnings.filter((w) => w.includes("not tunable"));
		assert.strictEqual(unknownWarnings.length, 1);
		assert.deepStrictEqual(unknownWarnings[0].split("ignored: ")[1].split(", "), ["bogus", "bogus2"]);
		const home = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: "", HOME: tmp }, () => {});
		assert.deepStrictEqual(home, { primaryTimeoutMs: 222 }); // ~/.pi/agent/settings.json absent -> project only
		const tilde = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: "~/agent", HOME: tmp }, () => {});
		assert.deepStrictEqual(tilde, { primaryTimeoutMs: 222, imageDpi: 72 });
		assert.strictEqual(cliAgentDir({ PI_CODING_AGENT_DIR: "~other", HOME: tmp }), "~other");
		const otherUser = readCliSettings(join(tmp, "proj"), { PI_CODING_AGENT_DIR: "~other", HOME: tmp }, () => {});
		assert.deepStrictEqual(otherUser, { primaryTimeoutMs: 222 }); // literal ~other/settings.json absent -> project only
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: flagless call prints a handle (degraded unpdf), exit 0", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-cli-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /^Saved-To: .*multipage\.md$/m);
		assert.match(stdout, /^Type: pdf   Engine: unpdf   Tier: unpdf$/m);
		assert.match(stdout, /^Page-Count: 6   Pages: all/m);
		assert.match(stdout, /^Degraded: unpdf text extraction - structure not preserved$/m);
		assert.ok(stdout.endsWith("\n") && !stdout.endsWith("\n\n"));
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --info prints the info handle", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-info-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--info", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /^Type: pdf   Page-Count: 6   Backend: none$/m);
	} finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("CLI subprocess: --help exit 0 lists every flag", async () => {
	const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--help"]);
	for (const f of ["--info", "--pages", "--output-dir", "--overwrite", "--primary-timeout", "--fallback-timeout", "--soffice-timeout", "--excel-timeout", "--warm-timeout", "--pymupdf-version", "--image-dpi", "--image-format", "--max-cells-per-sheet", "--max-output-bytes", "--outline-max-entries"]) assert.ok(stdout.includes(f), f);
});

test("CLI subprocess: exit 2 on bad --pages, unknown flag, --info with --pages", async () => {
	for (const argv of [["--pages", "x", MULTIPAGE], ["--nope", MULTIPAGE], ["--info", "--pages", "1", MULTIPAGE]]) {
		await assert.rejects(execFileAsync(process.execPath, [BIN, "doc-to-md", ...argv]), (e: { code?: number; stderr?: string }) => e.code === 2 && /Usage:/.test(e.stderr ?? ""), JSON.stringify(argv));
	}
});

test("CLI subprocess: collision -> exit 1 with Output exists; --overwrite succeeds", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "quiver-doc-coll-"));
	try {
		await execFileAsync(process.execPath, [BIN, "doc-to-md", "--output-dir", tmp, MULTIPAGE], { env: scrubbedEnv(tmp) });
		await assert.rejects(execFileAsync(process.execPath, [BIN, "doc-to-md", "--output-dir", tmp, MULTIPAGE], { env: scrubbedEnv(tmp) }), (e: { code?: number; stderr?: string }) => e.code === 1 && /Output exists: .*multipage\.md \(pass overwrite\)/.test(e.stderr ?? ""));
		const { stdout } = await execFileAsync(process.execPath, [BIN, "doc-to-md", "--output-dir", tmp, "--overwrite", MULTIPAGE], { env: scrubbedEnv(tmp) });
		assert.match(stdout, /^Saved-To: /m);
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
