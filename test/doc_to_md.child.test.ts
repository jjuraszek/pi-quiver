import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

async function childRaw(mode: string, options: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
	return runCapped("uv", uvChildArgs(CFG, scriptPath(), mode), { timeoutMs: 240_000, capBytes: 20_000_000, env, stdin: JSON.stringify({ maxOutputBytes: 20_000_000, pymupdfVersion: CFG.pymupdfVersion, ...options }) });
}
const markers = (md: string) => [...md.matchAll(/--- end of page\.page_number=(\d+) ---/g)].map((m) => Number(m[1]));

test("docx child: headings.docx -> headings, hyperlink, footnote, hoisted breaks, staged images, segments", T, async () => {
	const d = dirs();
	try {
		mkdirSync(d.stagingDir, { recursive: true });
		const r = await child("docx", { path: fx("headings.docx"), stagingDir: d.stagingDir });
		assert.equal(r.engine, "mammoth"); assert.equal(r.degraded, false); assert.equal(r.explicitBreaks, 2); assert.equal(r.pageCount, 3);
		const md: string = r.markdown;
		assert.deepEqual(markers(md), [1, 2, 3]);
		assert.match(md, /^# Chapter One$/m); assert.match(md, /^## Section A$/m); assert.match(md, /^### Detail A1$/m);
		assert.ok(md.includes("[pi-quiver](https://github.com/jjuraszek/pi-quiver)"));
		assert.ok(md.includes("FOOTNOTE-TEXT about provenance"));
		assert.match(md, /^# Chapter Two$\n\n--- end of page\.page_number=1 ---\n\n# Continued$/m);
		assert.match(md, /- beta\n\n--- end of page\.page_number=2 ---\n\n- gamma/);
		assert.ok(md.includes("![](p1/img1.png)") && md.includes("![](p3/img1.png)"));
		assert.ok(!md.includes("\x00") && !md.includes("data:"));
		for (const p of ["p1", "p2", "p3"]) assert.ok(existsSync(join(d.stagingDir, p, ".done")), p);
		for (const p of ["p1", "p3"]) assert.ok(existsSync(join(d.stagingDir, p, "img1.png")), p);
		assert.ok(!existsSync(join(d.stagingDir, "p2", "img1.png")));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: assembly failure removes staged segment directories", { ...T, skip: process.platform === "win32" || T.skip }, async () => {
	const d = dirs();
	try {
		mkdirSync(d.stagingDir, { recursive: true });
		writeFileSync(join(d.stagingDir, "p3"), "block image placement");
		const r = await childRaw("docx", { path: fx("headings.docx"), stagingDir: d.stagingDir });
		assert.equal(r.code, 1, r.stderr);
		assert.match(r.stderr, /FileExistsError/);
		assert.ok(!existsSync(join(d.stagingDir, "p1")));
		assert.ok(!existsSync(join(d.stagingDir, "p2")));
		assert.ok(statSync(join(d.stagingDir, "p3")).isFile());
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: pages selects segments, keeps original marker numbers, carries referenced footnotes only", T, async () => {
	const d = dirs();
	try {
		mkdirSync(d.stagingDir, { recursive: true });
		const one = await child("docx", { path: fx("headings.docx"), stagingDir: d.stagingDir, pages: [1] });
		assert.deepEqual(markers(one.markdown), [1]); assert.ok(one.markdown.includes("FOOTNOTE-TEXT"));
		const three = await child("docx", { path: fx("headings.docx"), stagingDir: join(d.root, "s3"), pages: [3] });
		assert.deepEqual(markers(three.markdown), [3]); assert.ok(!three.markdown.includes("FOOTNOTE-TEXT")); assert.ok(three.markdown.includes("Cell A"));
		const two = await child("docx", { path: fx("multipage.docx"), stagingDir: join(d.root, "mp"), pages: [2, 3] });
		assert.deepEqual(markers(two.markdown), [2, 3]); assert.equal(two.pageCount, 5); assert.equal(two.explicitBreaks, 4);
		assert.ok(two.markdown.includes("PAGE-2") && two.markdown.includes("PAGE-3") && !two.markdown.includes("PAGE-1"));

	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: user errors - no explicit breaks, out of range segments", T, async () => {
 const d = dirs();
 try {
  mkdirSync(d.stagingDir, { recursive: true });
		const none = await childRaw("docx", { path: fx("sample.docx"), stagingDir: d.stagingDir, pages: [1] });
		assert.equal(none.code, 3, none.stderr); assert.equal(JSON.parse(none.stdout).error, "--pages does not apply to this DOCX: it has no explicit page breaks; read the .md by Outline line offsets instead");
		const oor = await childRaw("docx", { path: fx("multipage.docx"), stagingDir: d.stagingDir, pages: [9] });
		assert.equal(oor.code, 3); assert.deepEqual(JSON.parse(oor.stdout), { error: "pages out of range: 9 (document has 5 segments)", pageCount: 5 });
		const whole = await child("docx", { path: fx("sample.docx"), stagingDir: d.stagingDir });
		assert.equal(whole.pageCount, 1); assert.equal(whole.explicitBreaks, 0); assert.deepEqual(markers(whole.markdown), []);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: forced python-docx fallback keeps headings, tables and markers; degraded flag set", T, async () => {
	const d = dirs();
	try {
		mkdirSync(d.stagingDir, { recursive: true });
		const r = await childRaw("docx", { path: fx("headings.docx"), stagingDir: d.stagingDir }, { ...process.env, DOC_TO_MD_FORCE_DOCX_FALLBACK: "1" });
		assert.equal(r.code, 0, r.stderr);
		const j = JSON.parse(r.stdout);
		assert.equal(j.engine, "python-docx"); assert.equal(j.degraded, true); assert.match(j.fallbackReason, /^mammoth RuntimeError: forced/);
		assert.deepEqual(markers(j.markdown), [1, 2, 3]); assert.match(j.markdown, /^# Chapter One$/m); assert.match(j.markdown, /^# Continued$/m);
		assert.ok(j.markdown.includes("| Cell A |")); assert.ok(!j.markdown.includes("![") && !j.markdown.includes("FOOTNOTE-TEXT"));

	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("info child: .docx branch - core properties, ISO dates, heading TOC with segment pages, bold-only -> empty TOC", T, async () => {
		const h = await child("info", { path: fx("headings.docx") });
		assert.equal(h.pageCount, 3); assert.equal(h.explicitBreaks, 2);
		assert.equal(h.metadata.title, "Headings Fixture"); assert.equal(h.metadata.author, "pi-quiver tests");
		if (h.metadata.created !== undefined) assert.match(h.metadata.created, /^\d{4}-\d{2}-\d{2}T/);
		assert.deepEqual(h.toc, [[1, "Chapter One", 1], [2, "Section A", 1], [3, "Detail A1", 1], [1, "Chapter Two", 1], [1, "Continued", 2]]);
		const b = await child("info", { path: fx("bold-headings.docx") });
		assert.deepEqual(b.toc, []); assert.equal(b.pageCount, 1); assert.equal(b.explicitBreaks, 0);
		const s = await child("info", { path: fx("sample.docx") }); assert.deepEqual(s.toc, []);
		const m = await child("info", { path: fx("multipage.docx") });
		assert.equal(m.pageCount, 5); assert.deepEqual(m.toc.map((t: [number, string, number]) => t[2]), [1, 2, 3, 4, 5]);
 for (const name of ["headings.docx", "multipage.docx", "sample.docx", "bold-headings.docx"]) {
  const d = dirs();
  try {
   mkdirSync(d.stagingDir, { recursive: true });
   const info = await child("info", { path: fx(name) });
   const converted = await child("docx", { path: fx(name), stagingDir: d.stagingDir });
   assert.equal(info.pageCount, converted.pageCount, name);
  } finally { rmSync(d.root, { recursive: true, force: true }); }
 }
});

test("docx child: Heading 7, trailing break and table-cell break", T, async () => {
 const d = dirs();
 try {
  const path = join(d.root, "edge.docx");
  const python = `from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
D=Document()
if 'Heading 7' not in D.styles: D.styles.add_style('Heading 7', WD_STYLE_TYPE.PARAGRAPH)
D.add_paragraph('Deep', style='Heading 7')
t=D.add_table(rows=1, cols=1)
p=t.cell(0,0).paragraphs[0]
p.add_run('Cell')
b=OxmlElement('w:br'); b.set(qn('w:type'),'page'); p.add_run()._r.append(b)
D.add_paragraph('After')
D.save(${JSON.stringify(path)})`;
  const generated = spawnSync("uv", ["run", "--with", "python-docx==1.2.0", "--python", "3.14", "python", "-c", python], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  mkdirSync(d.stagingDir, { recursive: true });
  const result = await child("docx", { path, stagingDir: d.stagingDir });
  const info = await child("info", { path });
  assert.equal(result.explicitBreaks, 1);
  assert.equal(result.pageCount, 2);
  assert.equal(info.pageCount, result.pageCount);
  assert.match(result.markdown, /^###### Deep$/m);
  assert.match(result.markdown, /\| Cell \|[\s\S]*--- end of page\.page_number=1 ---\n\nAfter/);
  const fallback = await childRaw("docx", { path, stagingDir: d.stagingDir }, { ...process.env, DOC_TO_MD_FORCE_DOCX_FALLBACK: "1" });
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.match(JSON.parse(fallback.stdout).markdown, /^###### Deep$/m);
  const trailing = DocumentTrailingBreakPython(path);
  const g2 = spawnSync("uv", ["run", "--with", "python-docx==1.2.0", "--python", "3.14", "python", "-c", trailing], { encoding: "utf8" });
  assert.equal(g2.status, 0, g2.stderr);
  const end = await child("docx", { path, stagingDir: d.stagingDir, pages: [1] });
  const endInfo = await child("info", { path });
  assert.equal(end.explicitBreaks, 1); assert.equal(end.pageCount, 1); assert.deepEqual(end.pages, [1]);
  assert.deepEqual(markers(end.markdown), []); assert.equal(endInfo.pageCount, 1);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: consecutive page breaks keep all segments and contiguous markers", T, async () => {
 const d = dirs();
 try {
  const path = join(d.root, "consecutive.docx");
  const python = `from docx import Document
from docx.enum.text import WD_BREAK
d=Document()
p=d.add_paragraph()
p.add_run('alpha')
r=p.add_run()
r.add_break(WD_BREAK.PAGE)
r.add_break(WD_BREAK.PAGE)
d.add_paragraph('omega')
d.save(${JSON.stringify(path)})`;
  const generated = spawnSync("uv", ["run", "--with", "python-docx==1.2.0", "--python", "3.14", "python", "-c", python], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  mkdirSync(d.stagingDir, { recursive: true });
  const info = await child("info", { path });
  const converted = await child("docx", { path, stagingDir: d.stagingDir });
  const fallbackRaw = await childRaw("docx", { path, stagingDir: d.stagingDir }, { ...process.env, DOC_TO_MD_FORCE_DOCX_FALLBACK: "1" });
  assert.equal(fallbackRaw.code, 0, fallbackRaw.stderr);
  const fallback = JSON.parse(fallbackRaw.stdout);
  assert.equal(converted.engine, "mammoth");
  assert.equal(info.pageCount, 3);
  assert.equal(converted.pageCount, info.pageCount);
  assert.equal(converted.pageCount, fallback.pageCount);
  assert.deepEqual(markers(converted.markdown), [1, 2, 3]);
  assert.deepEqual(markers(fallback.markdown), [1, 2, 3]);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: content control after break counts as a segment in info and fallback", T, async () => {
 const d = dirs();
 try {
  const path = join(d.root, "content-control.docx");
  const python = `from docx import Document
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
D=Document()
D.add_paragraph('Before')
D.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
sdt=OxmlElement('w:sdt')
content=OxmlElement('w:sdtContent')
p=D.add_paragraph('Inside control', style='Heading 1')
D.element.body.remove(p._p)
content.append(p._p)
sdt.append(content)
D.element.body.insert(-1, sdt)
D.save(${JSON.stringify(path)})`;
  const generated = spawnSync("uv", ["run", "--with", "python-docx==1.2.0", "--python", "3.14", "python", "-c", python], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  mkdirSync(d.stagingDir, { recursive: true });
  const info = await child("info", { path });
  const converted = await child("docx", { path, stagingDir: d.stagingDir });
  const fallbackRaw = await childRaw("docx", { path, stagingDir: d.stagingDir }, { ...process.env, DOC_TO_MD_FORCE_DOCX_FALLBACK: "1" });
  assert.equal(fallbackRaw.code, 0, fallbackRaw.stderr);
  const fallback = JSON.parse(fallbackRaw.stdout);
  assert.equal(converted.engine, "mammoth");
  assert.equal(info.pageCount, converted.pageCount);
  assert.equal(info.pageCount, fallback.pageCount);
  assert.equal(info.pageCount, 2);
  assert.match(fallback.markdown, /^# Inside control$/m);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

function DocumentTrailingBreakPython(path: string) {
 return `from docx import Document\nfrom docx.enum.text import WD_BREAK\nd=Document()\nd.add_paragraph('Content')\np=d.add_paragraph()\np.add_run().add_break(WD_BREAK.PAGE)\nd.save(${JSON.stringify(path)})`;
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
