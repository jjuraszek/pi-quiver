import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapped, scriptPath, uvChildArgs } from "../lib/doc-to-md-core.ts";
import { TUNABLE_DEFAULTS } from "../lib/doc-to-md-options.ts";

const HAS_UV = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
const T = { timeout: 300_000, skip: !HAS_UV && "uv not on PATH" } as const;
const fx = (n: string) => fileURLToPath(new URL(`../test/fixtures/${n}`, import.meta.url));
const CFG = { pymupdfVersion: TUNABLE_DEFAULTS.pymupdfVersion, warmTimeoutMs: 0 };

async function child(mode: string, options: Record<string, unknown>): Promise<Record<string, any>> {
	const r = await runCapped("uv", uvChildArgs(CFG, scriptPath(), mode), { timeoutMs: 240_000, capBytes: 20_000_000, stdin: JSON.stringify({ maxOutputBytes: 20_000_000, pymupdfVersion: CFG.pymupdfVersion, ...options }) });
	assert.equal(r.code, 0, r.stderr.slice(-2000));
	return JSON.parse(r.stdout);
}

function dirs() {
	const root = mkdtempSync(join(tmpdir(), "quiver-child-"));
	return { root, stagingDir: join(root, "images", ".stage-x"), sheetsStagingDir: join(root, "sheets", ".stage-x") };
}

test("xlsx child: charts.xlsx inventory, CSVs, preview, profile, charts, markers", T, async () => {
	const d = dirs();
	try {
		const { mkdirSync } = await import("node:fs"); mkdirSync(d.stagingDir, { recursive: true });
		const j = await child("xlsx", { path: fx("charts.xlsx"), stagingDir: d.stagingDir, sheetsStagingDir: d.sheetsStagingDir, imageDpi: 150, imageFormat: "png" });
		const md: string = j.markdown;
		assert.ok(md.startsWith("# charts\n\n## Sheets\n| # | name | kind | size | hidden | charts | images | rendered | data |\n|---|---|---|---|---|---|---|---|---|\n"));
		assert.ok(md.includes("| 0 | Data | worksheet | 200 x 3 | no | 1 | 1 | <!--rvs:0--> | [sheets/s0-data.csv](sheets/s0-data.csv) |"));
		assert.ok(md.includes("| 1 | Empty | worksheet | 0 x 0 | no | 0 | 0 | - | - |"));
		assert.ok(md.includes("| 2 | Aux | worksheet | 10 x 2 | yes | 0 | 0 | - | [sheets/s2-aux.csv](sheets/s2-aux.csv) |"));
		assert.ok(md.includes("| 3 | Trends | chartsheet | - | no | 1 | 0 | <!--rvs:3--> | - |"));
		assert.ok(md.includes("| 4 | Bars | chartsheet | - | no | 1 | 0 | <!--rvs:4--> | - |"));
		assert.ok(md.includes("| 5 | Wide | worksheet | 300 x 80 | no | 0 | 0 | - | [sheets/s5-wide.csv](sheets/s5-wide.csv) |"));
		assert.deepStrictEqual(j.renderPages, [0, 3, 4]);
		assert.equal(j.sheetCount, 6);
		assert.ok(md.includes("## Data\nData: [sheets/s0-data.csv](sheets/s0-data.csv) - 200 rows x 3 cols, 199 formulas\nCharts:\n- LineChart \"Data trend\" - 1 series ('Data'!$B$2:$B$200)\nImages:\n- ![Data image 1](s0-1.png)\n<!--rv:0-->\n\nPreview (rows 1-100 of 200, cols A-C of 3) - full data in the CSV above:\n| | A | B | C |\n|---|---|---|---|\n| 1 | Step | North | Double |\n| 2 | 1 | 0.5 | (no cached result) (=A2*2) |"));
		assert.ok(md.includes("## Empty\nData: none\n"));
		assert.ok(md.includes("## Aux\nHidden sheet\nData: [sheets/s2-aux.csv](sheets/s2-aux.csv) - 10 rows x 2 cols\n\nContent (10 rows x 2 cols):\n"));
		assert.ok(!/## Aux[\s\S]*?Columns:[\s\S]*?## Trends/.test(md));
		assert.ok(md.includes("## Trends (chartsheet)\nCharts:\n- LineChart \"Synthetic trends\" - 1 series ('Data'!$B$2:$B$200)\n<!--rv:3-->"));
		assert.ok(md.includes("## Bars (chartsheet)\nCharts:\n- BarChart \"Bars\" - 1 series ('Data'!$A$2:$A$200)\n<!--rv:4-->"));
		assert.ok(md.includes("Preview (rows 1-100 of 300, cols A-AX of 80) - full data in the CSV above:"));
		assert.ok(md.includes("Columns:\n| col | header | type | non-empty | min | max | distinct |\n|---|---|---|---|---|---|---|\n| A | C1 | int | 300 | 1 | 299 | >50 |\n"));
		assert.ok(md.includes("| C | C3 | str | 300 | - | - | 5 |"));
		assert.match(md, /\| D \| C4 \| date \| 300 \| 2026-01-03T00:00:00 \| 2026-10-28T00:00:00 \| >50 \|/);
		assert.ok(md.includes("| CB | C80 | int | 300 |"));
		const wideColumns = md.match(/## Wide[\s\S]*?Columns:\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
		assert.equal(wideColumns.split("\n").filter((line) => /^\| [A-Z]+ \| /.test(line)).length, 80);
		assert.ok(existsSync(join(d.stagingDir, "s0-1.png")));
		const csv = readFileSync(join(d.sheetsStagingDir, "s0-data.csv"), "utf8");
		assert.ok(csv.startsWith("Step,North,Double\r\n1,0.5,=A2*2\r\n"));
		assert.equal(csv.split("\r\n").length, 201);
		assert.ok(existsSync(join(d.sheetsStagingDir, "s2-aux.csv")) && existsSync(join(d.sheetsStagingDir, "s5-wide.csv")));
		assert.ok(!existsSync(join(d.sheetsStagingDir, "s1-empty.csv")));
		assert.equal(readFileSync(join(d.sheetsStagingDir, "s5-wide.csv"), "utf8").split("\r\n").length, 301);
		assert.equal(j.sheets.length, 6);
		assert.deepStrictEqual(j.sheets[3], { index: 3, name: "Trends", kind: "chartsheet", hidden: false, rows: null, cols: null, hiddenRows: 0, hiddenCols: 0, charts: 1, images: 0, rendered: false, csv: null });
		assert.deepStrictEqual(j.sheets[0], { index: 0, name: "Data", kind: "worksheet", hidden: false, rows: 200, cols: 3, hiddenRows: 0, hiddenCols: 0, charts: 1, images: 1, rendered: false, csv: "sheets/s0-data.csv" });
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("xlsx child: workbook.xlsx keeps #13 dual formula display and disclosures; 0-based image names", T, async () => {
	const d = dirs();
	try {
		const { mkdirSync } = await import("node:fs"); mkdirSync(d.stagingDir, { recursive: true });
		const j = await child("xlsx", { path: fx("workbook.xlsx"), stagingDir: d.stagingDir, sheetsStagingDir: d.sheetsStagingDir, imageDpi: 150, imageFormat: "png" });
		const md: string = j.markdown;
		assert.match(md, /\| 18 \|.*42 \(=D17\*2\)/);
		assert.match(md, /\(no cached result\) \(=SUM\(A2:A20\)\)/);
		assert.ok(md.includes("Merged: A1:C1") && md.includes("Hidden rows: 4") && md.includes("Hidden cols: F"));
		assert.ok(md.includes("- ![Data image 1](s0-1.png)") && md.includes("<!--rv:0-->"));
		assert.ok(existsSync(join(d.stagingDir, "s0-1.png")) && existsSync(join(d.stagingDir, "s2-1.png")) && existsSync(join(d.stagingDir, "s3-1.png")));
		assert.deepStrictEqual(j.renderPages, [0, 2, 3]);
		assert.ok(existsSync(join(d.sheetsStagingDir, "s2-a-b.csv")) && existsSync(join(d.sheetsStagingDir, "s3-a-b.csv")));
		const data = readFileSync(join(d.sheetsStagingDir, "s0-data.csv"), "utf8").split("\r\n");
		assert.ok(data[17].startsWith("18,27,row 18,42,"), data[17]);
		assert.ok(data[18].includes(",=SUM(A2:A20),"), data[18]);
		assert.ok(data[2].includes("2026-09-09") && data[3].includes("TRUE"));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("xls child: preamble, CSV, workbook-level unavailable line, no markers", T, async () => {
	const d = dirs();
	try {
		const j = await child("xlsx", { path: fx("legacy.xls"), stagingDir: d.stagingDir, sheetsStagingDir: d.sheetsStagingDir, imageDpi: 150, imageFormat: "png" });
		const md: string = j.markdown;
		assert.ok(md.startsWith("# legacy\n\n## Sheets\n"));
		assert.ok(md.includes("| 0 | Legacy | worksheet | 6 x 4 | no | 0 | 0 | - | [sheets/s0-legacy.csv](sheets/s0-legacy.csv) |\n\nRendered views: unavailable (visual detection not supported for .xls)\n"));
		assert.ok(!md.includes("<!--rv") && md.includes("#DIV/0!"));
		assert.deepStrictEqual(j.notes, ["Rendered views: unavailable (visual detection not supported for .xls)"]);
		assert.deepStrictEqual(j.renderPages, []);
		assert.equal(j.sheetCount, 1);
		assert.ok(readFileSync(join(d.sheetsStagingDir, "s0-legacy.csv"), "utf8").includes("#DIV/0!"));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("info child: charts.xlsx lists chartsheets with kind and counts, 0-based", T, async () => {
	const j = await child("info", { path: fx("charts.xlsx") });
	assert.equal(j.sheets.length, 6);
	assert.deepStrictEqual(j.sheets.map((s: { index: number; kind: string }) => [s.index, s.kind]), [[0, "worksheet"], [1, "worksheet"], [2, "worksheet"], [3, "chartsheet"], [4, "chartsheet"], [5, "worksheet"]]);
	assert.deepStrictEqual(j.sheets[3], { index: 3, name: "Trends", kind: "chartsheet", hidden: false, rows: null, cols: null, hiddenRows: 0, hiddenCols: 0, charts: 1, images: 0, rendered: false, csv: null });
	assert.equal(j.sheets[0].charts, 1); assert.equal(j.sheets[0].images, 1); assert.equal(j.sheets[2].hidden, true);
});

test("render-pages child: renders only requested pages, applies pixel budget, reports mismatch", T, async () => {
	const d = dirs();
	try {
		const { mkdirSync } = await import("node:fs"); mkdirSync(d.stagingDir, { recursive: true });
		const ok = await child("render-pages", { path: fx("multipage.pdf"), sheetIndices: [1, 3], expectedPages: 6, imageDpi: 600, imageFormat: "png", stagingDir: d.stagingDir });
		assert.equal(ok.ok, true);
		assert.deepStrictEqual(ok.failed, []);
		assert.deepStrictEqual(ok.rendered.map((r: { idx: number; file: string }) => [r.idx, r.file]), [[1, "s1.png"], [3, "s3.png"]]);
		assert.ok(ok.rendered[0].dpi < 600 && ok.rendered[0].dpi >= 36, "16 Mpx budget caps a 600 dpi request");
		assert.ok(existsSync(join(d.stagingDir, "s1.png")) && existsSync(join(d.stagingDir, "s3.png")) && !existsSync(join(d.stagingDir, "s0.png")));
		const bad = await child("render-pages", { path: fx("multipage.pdf"), sheetIndices: [0], expectedPages: 5, imageDpi: 150, imageFormat: "png", stagingDir: d.stagingDir });
		assert.deepStrictEqual(bad, { ok: false, reason: "page-count mismatch (6 vs 5)" });
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});
