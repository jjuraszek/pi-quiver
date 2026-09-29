import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapped, scriptPath, uvChildArgs } from "../lib/doc-to-md-core.ts";
import { TUNABLE_DEFAULTS } from "../lib/doc-to-md-options.ts";

const HAS_UV = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
const T = { timeout: 300_000, skip: !HAS_UV && "uv not on PATH" } as const;
const fx = (n: string) => fileURLToPath(new URL(`../test/fixtures/${n}`, import.meta.url));
const CFG = { pymupdfVersion: TUNABLE_DEFAULTS.pymupdfVersion, warmTimeoutMs: 0 };
const LOAD = [
	"import contextlib, importlib.util, json, os, sys",
	`spec = importlib.util.spec_from_file_location("doc_to_md", ${JSON.stringify(scriptPath())})`,
	"m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
].join("\n");
// body runs with stdout redirected to stderr and must assign OUT; OUT is printed as JSON.
async function py(body: string, env: NodeJS.ProcessEnv = process.env): Promise<any> {
	const program = `${LOAD}\nwith contextlib.redirect_stdout(sys.stderr):\n${body.split("\n").map((l) => `    ${l}`).join("\n")}\nprint(json.dumps(OUT))`;
	const r = await runCapped("uv", uvChildArgs(CFG, "-c", program), { timeoutMs: 240_000, capBytes: 20_000_000, env });
	assert.equal(r.code, 0, r.stderr.slice(-2000));
	return JSON.parse(r.stdout);
}

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

test("html child: pipe escaping, code language, definition list, hr stays ---", T, async () => {
	const d = dirs();
	try {
		const html = `<h1>T</h1><table><thead><tr><th>Plant</th><th>Note</th></tr></thead><tbody><tr><td>Rose | red</td><td>Sun</td></tr></tbody></table><pre><code class="language-py">print("hi")</code></pre><pre class="lang-js"><code>x()</code></pre><pre><code class="language-a\`\`\`b">z</code></pre><table><tr><td><table><tr><td>x|y</td></tr></table></td></tr></table><dl><dt>Mulch</dt><dd>A protective layer.</dd></dl><p>before</p><hr class="pagebreak"><p>after</p>`;
		const r = await child("html", { html, stagingDir: d.stagingDir });
		assert.equal(r.engine, "markdownify");
		const md: string = r.markdown;
		assert.match(md, /^# T$/m);
		assert.match(md, /\| Rose \\\| red \| Sun \|/);
		assert.ok(md.includes("```py\nprint(\"hi\")\n```"), md);
		assert.ok(md.includes("```js\nx()\n```"), md);
		assert.ok(!md.includes("```a```b"), md);
		assert.ok(!md.includes("\\\\|"), md);
		assert.ok(md.includes("Mulch\n:   A protective layer."), md);
		assert.match(md, /before\n\n---\n\nafter/);
		assert.ok(!md.includes("\x00"));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx child: a | inside a table cell is escaped (shared converter)", T, async () => {
	const d = dirs();
	try {
		const out = join(d.root, "pipe.docx");
		const python = `import docx, sys\nd = docx.Document()\nt = d.add_table(rows=2, cols=2)\nt.cell(0,0).text='Plant'; t.cell(0,1).text='Note'; t.cell(1,0).text='Rose | red'; t.cell(1,1).text='Sun'\nd.save(sys.argv[1])`;
		const g = spawnSync("uv", ["run", "--with", "python-docx==1.2.0", "--python", "3.14", "python", "-c", python, out], { encoding: "utf8" });
		assert.equal(g.status, 0, g.stderr);
		mkdirSync(d.stagingDir, { recursive: true });
		const r = await child("docx", { path: out, stagingDir: d.stagingDir });
		assert.match(r.markdown, /\| Rose \\\| red \| Sun \|/);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

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

const imgOpts = (path: string, stagingDir: string, ocr: boolean) => ({ path, stagingDir, stem: "ocr", ocr, ocrLanguage: "eng", ocrBudgetMs: 60000, imageFormat: "png", imageDpi: 150 });

test("image child: original copied and linked, status off with the tesseract hint", T, async () => {
 const d = dirs();
 try {
  const r = await child("image", imgOpts(fx("ocr.png"), d.stagingDir, false));
  assert.equal(r.markdown, "![ocr](p1/original.png)\n");
  assert.ok(readFileSync(join(d.stagingDir, "p1", "original.png")).equals(readFileSync(fx("ocr.png"))));
  assert.ok(existsSync(join(d.stagingDir, "p1", ".done")));
  assert.equal(r.pageCount, 1); assert.equal(r.ocr.status, "off"); assert.equal(typeof r.ocr.tesseract, "boolean");
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("image child: no Pillow needed when OCR is off; corrupt ready image keeps copied original", T, async () => {
 const d = dirs();
 try {
  const corrupt = join(d.root, "broken.png"); writeFileSync(corrupt, Buffer.from("not an image"));
  const out = await py([
   "sys.modules['PIL'] = None",
   `off = m.mode_image(${JSON.stringify(imgOpts(fx("ocr.png"), join(d.root, "off"), false))})`,
   `m.ocr_status = lambda ocr, lang: {"status": "ready", "reason": None, "tesseract": None}`,
   `broken = m.mode_image(${JSON.stringify(imgOpts(corrupt, join(d.root, "broken"), true))})`,
   "OUT = [off, broken]",
  ].join("\n").replaceAll("true", "True").replaceAll("false", "False"));
  assert.equal(out[0].ocr.status, "off");
  assert.equal(out[0].markdown, "![ocr](p1/original.png)\n");
  assert.ok(readFileSync(join(d.root, "off", "p1", "original.png")).equals(readFileSync(fx("ocr.png"))));
  assert.equal(out[1].ocr.status, "ran"); assert.deepEqual(out[1].ocr.ocrFailed, [1]);
  assert.equal(out[1].markdown, "![ocr](p1/original.png)\n");
  assert.ok(readFileSync(join(d.root, "broken", "p1", "original.png")).equals(Buffer.from("not an image")));
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("image child: too-small skip, native ocr_dpi, OCR exception keeps the image", T, async () => {
 const d = dirs();
 try {
  const fake = join(d.root, "tess"); mkdirSync(fake); writeFileSync(join(fake, "eng.traineddata"), "");
  const out = await py([
   "import pymupdf4llm", "seen = []",
   "def tm(*a, **k):", "    seen.append(k.get('ocr_dpi'))", "    raise RuntimeError('tesseract exploded')",
   "pymupdf4llm.to_markdown = tm",
   `small = m.mode_image(${JSON.stringify(imgOpts(fx("strip.png"), join(d.root, "s1"), true))})`,
   `boom = m.mode_image(${JSON.stringify(imgOpts(fx("ocr.png"), join(d.root, "s2"), true))})`,
   "import pymupdf", `src = pymupdf.open(${JSON.stringify(fx("ocr.png"))}); pdf = pymupdf.open("pdf", src.convert_to_pdf())`,
   `w_px = pymupdf.Pixmap(${JSON.stringify(fx("ocr.png"))}).width`,
   "OUT = [small['ocr'], small['markdown'], boom['ocr'], boom['markdown'], seen, m.image_ocr_dpi(w_px, pdf[0].rect.width, pdf[0].rect.height), m.image_ocr_dpi(8000, 576, 576), m.image_ocr_dpi(600, 216, 43.2)]",
  ].join("\n").replaceAll("true", "True").replaceAll("false", "False"), { ...process.env, TESSDATA_PREFIX: fake });
  assert.deepEqual([out[0].status, out[0].reason], ["skipped", "image too small"]);
  assert.equal(out[1], "![ocr](p1/original.png)\n");
  assert.equal(out[2].status, "ran"); assert.deepEqual(out[2].ocrFailed, [1]); assert.deepEqual(out[2].pages, []);
  assert.equal(out[3], "![ocr](p1/original.png)\n");
  assert.deepEqual(out[4], [out[5]]);
  assert.equal(out[6], 500); assert.equal(out[7], 200);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("real OCR: image mode labels text recognized in the original", T, async (t) => {
 if ((await py(`OUT = m.ocr_status(True, "eng")["status"]`)) !== "ready") { t.skip("no Tesseract language data"); return; }
 const d = dirs();
 try {
  const r = await child("image", imgOpts(fx("ocr.png"), d.stagingDir, true));
  assert.ok(r.markdown.startsWith("![ocr](p1/original.png)\n\n\x00OCR p1/original.png\x00\n>\n> "), r.markdown);
  assert.match(r.markdown, /Hello OCR world 12345/);
  assert.deepEqual(r.ocr.pages, [1]);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

const READY = `m.ocr_status = lambda ocr, lang: {"status": "ready", "reason": None, "tesseract": None}`;

test("ocr_status: off, missing language, ready exports TESSDATA_PREFIX", T, async () => {
 const root = mkdtempSync(join(tmpdir(), "quiver-tess-"));
 try {
  const empty = join(root, "empty"); mkdirSync(empty);
  const fake = join(root, "fake"); mkdirSync(fake); writeFileSync(join(fake, "eng.traineddata"), "");
  const e = await py(`os.environ["TESSDATA_PREFIX"] = ${JSON.stringify(empty)}\nOUT = [m.ocr_status(False, "eng"), m.ocr_status(True, "eng")]`);
  assert.deepEqual(e, [{ status: "off", reason: null, tesseract: false }, { status: "unavailable", reason: "language data for eng not installed", tesseract: null }]);
  const f = await py(`os.environ["TESSDATA_PREFIX"] = ${JSON.stringify(fake)}\nOUT = [m.ocr_status(True, "eng"), m.ocr_status(True, "deu+eng"), os.environ["TESSDATA_PREFIX"]]`);
  assert.deepEqual(f, [{ status: "ready", reason: null, tesseract: null }, { status: "unavailable", reason: "language data for deu not installed", tesseract: null }, fake]);
  const n = await py(`import pymupdf\ndef boom(): raise RuntimeError("x")\npymupdf.get_tessdata = boom\nOUT = m.ocr_status(True, "eng")`);
  assert.deepEqual(n, { status: "unavailable", reason: "Tesseract language data not found", tesseract: null });
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OCR off: text-only PDF does not probe status or analyze", T, async () => {
 const d = dirs();
 try {
  const out = await py([
   "import pymupdf4llm.helpers.utils as U", "calls = {'a': 0, 's': 0}", "orig = m.ocr_status",
   "def s(*a): calls['s'] += 1; return orig(*a)",
   "def an(*a, **k): calls['a'] += 1; raise RuntimeError('no')",
   "m.ocr_status = s; U.analyze_page = an",
   `r = m.mode_pdf_primary({"path": ${JSON.stringify(fx("multipage.pdf"))}, "pages": [1, 2, 3, 5], "stagingDir": ${JSON.stringify(d.stagingDir)}, "imageFormat": "png", "imageDpi": 72, "ocr": False, "ocrLanguage": "eng", "ocrBudgetMs": 60000})`,
   "OUT = [calls, r['ocr']]",
  ].join("\n"));
  assert.deepEqual(out[0], { a: 0, s: 0 }); assert.deepEqual(out[1].textless, []);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("textless page keeps one picture in both PDF tiers", T, async () => {
 const d = dirs();
 try {
  const p = await child("pdf-primary", { path: fx("scan.pdf"), stagingDir: d.stagingDir, imageFormat: "png", imageDpi: 72, ocr: false });
  assert.ok(p.markdown.includes("![page 1](p1/page.png)"), p.markdown);
  assert.deepEqual(readdirSync(join(d.stagingDir, "p1")).sort(), [".done", "page.png"]);
  assert.deepEqual(p.emptyPages, [1]); assert.deepEqual(p.ocr.textless, [1]); assert.equal(p.ocr.status, "off");
  const off = await child("pdf-fallback", { path: fx("scan.pdf"), stagingDir: join(d.root, "off"), imageFormat: "png", imageDpi: 72, ocr: false });
  assert.equal(off.ocr.status, "off"); assert.equal(typeof off.ocr.tesseract, "boolean");
  const fb = join(d.root, "fb");
  const f = await child("pdf-fallback", { path: fx("scan.pdf"), stagingDir: fb, imageFormat: "png", imageDpi: 72, ocr: true });
  assert.ok(f.markdown.includes("![page 1](p1/page.png)"), f.markdown);
  assert.deepEqual(readdirSync(join(fb, "p1")).sort(), [".done", "page.png"]);
  assert.deepEqual(f.emptyPages, p.emptyPages); assert.deepEqual([f.ocr.status, f.ocr.reason, f.ocr.textless], ["unavailable", "fallback tier", [1]]);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("clamped render, budget, small-image gate and analyze failure", T, async () => {
 const out = await py([
  "import pymupdf, pymupdf4llm.helpers.utils as U",
  `logo = pymupdf.open(${JSON.stringify(fx("logo.pdf"))})[0]`,
  `text = pymupdf.open(${JSON.stringify(fx("multipage.pdf"))})[0]`,
  "a = [m.clamped_dpi(612, 792, 150), m.clamped_dpi(3000, 3000, 150), m.clamped_dpi(14400, 14400, 150), m.clamped_dpi(40, 40, 150)]",
  "b = [m.ocr_admit(0, 4000, 0, 250, 60000), m.ocr_admit(50, 4000, 0, 250, 10000), m.ocr_admit(0, 4000, 0, 250, 8000), m.ocr_admit(40000, 4000, 10, 250, 60000), m.ocr_admit(52000, 4000, 10, 250, 60000)]",
  "c = [m.page_ocr_kwargs(logo, False, 'eng'), m.page_ocr_kwargs(text, False, 'eng'), m.page_ocr_kwargs(text, True, 'deu')]",
  "def boom(*a, **k): raise AttributeError('gone')", "U.analyze_page = boom",
  "OUT = [a, b, c, m.page_ocr_kwargs(logo, False, 'eng')]",
 ].join("\n"));
 assert.deepEqual(out[0], [150, 96, null, null]); assert.deepEqual(out[1], [true, true, false, true, false]);
 assert.deepEqual(out[2], [{ use_ocr: false }, { use_ocr: true, ocr_language: "eng" }, { use_ocr: true, force_ocr: true, ocr_language: "deu" }]);
 assert.deepEqual(out[3], { use_ocr: true, ocr_language: "eng" });
});

test("OCR budget stop and per-page OCR failure retry", T, async () => {
 const d = dirs();
 try {
  const opts = (budget: number, staging: string) => `{"path": ${JSON.stringify(fx("scan.pdf"))}, "stagingDir": ${JSON.stringify(staging)}, "imageFormat": "png", "imageDpi": 72, "ocr": True, "ocrLanguage": "eng", "ocrBudgetMs": ${budget}}`;
  const out = await py(["import pymupdf4llm", READY, "seen = []", "orig = pymupdf4llm.to_markdown",
   "def tm(*a, **k):", "    seen.append(bool(k.get('use_ocr')))", "    if k.get('use_ocr'): raise RuntimeError('tesseract exploded')", "    return orig(*a, **k)",
   "pymupdf4llm.to_markdown = tm", `stopped = m.mode_pdf_primary(${opts(8000, join(d.root, "s1"))})`,
   "s1 = list(seen); seen.clear()", `failed = m.mode_pdf_primary(${opts(60000, join(d.root, "s2"))})`,
   "OUT = [stopped['ocr'], s1, failed['ocr'], list(seen), failed['failedPages'], failed['markdown']]"].join("\n"));
  assert.equal(out[0].status, "ran"); assert.deepEqual(out[0].budgetStopped, [1]); assert.deepEqual(out[1], [false]);
  assert.deepEqual(out[2].ocrFailed, [1]); assert.deepEqual(out[3], [true, true, false]); assert.deepEqual(out[4], []);
  assert.ok(out[5].includes("![page 1](p1/page.png)") && out[5].includes("PAGE-2"));
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("PDF OCR budget admits all, some, or no textless pages with a controlled clock", T, async () => {
 const d = dirs();
 try {
  const path = join(d.root, "three-scans.pdf");
  const out = await py([
   "import pymupdf, pymupdf4llm, time",
   `doc = pymupdf.open(); image = open(${JSON.stringify(fx("ocr.png"))}, 'rb').read()`,
   "for _ in range(3):",
   "    page = doc.new_page(); page.insert_image(page.rect, stream=image)",
   `doc.save(${JSON.stringify(path)}); doc.close()`,
   READY,
   "clock = [0.0]; calls = []",
   "time.monotonic = lambda: clock[0]",
   "def tm(*a, **k):",
   "    assert k.get('use_ocr') and k.get('force_ocr')",
   "    calls.append(k['pages'][0] + 1)",
   "    clock[0] += 4.0",
   "    return 'recognized text'",
   "pymupdf4llm.to_markdown = tm",
   "results = []",
   "for budget in (60000, 14000, 8000):",
   "    clock[0] = 0.0; calls.clear()",
   `    r = m.mode_pdf_primary({'path': ${JSON.stringify(path)}, 'stagingDir': os.path.join(${JSON.stringify(d.root)}, str(budget)), 'imageFormat': 'png', 'imageDpi': 72, 'ocr': True, 'ocrLanguage': 'eng', 'ocrBudgetMs': budget})`,
   "    results.append([r, list(calls)])",
   "OUT = results",
  ].join("\n"));
  const expected: [number, number[], number[]][] = [
   [0, [1, 2, 3], []],
   [1, [1, 2], [3]],
   [2, [], [1, 2, 3]],
  ];
  for (const [index, pages, stopped] of expected) {
   const [result, calls] = out[index];
   assert.deepEqual(calls, pages);
   assert.equal(result.ocr.status, "ran");
   assert.deepEqual(result.ocr.textless, [1, 2, 3]);
   assert.deepEqual(result.ocr.pages, pages);
   assert.deepEqual(result.ocr.budgetStopped, stopped);
   assert.deepEqual(result.emptyPages, stopped);
   for (const n of [1, 2, 3]) {
    assert.ok(result.markdown.includes(`![page ${n}](p${n}/page.png)`));
    assert.equal(result.markdown.includes(`\x00OCR p${n}/page.png\x00`), pages.includes(n));
   }
  }
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("forced OCR with no recognized text stays empty", T, async () => {
 const d = dirs();
 try {
  const out = await py(["import pymupdf4llm", READY,
   "orig = pymupdf4llm.to_markdown",
   "def tm(*a, **k): return '' if k.get('use_ocr') else orig(*a, **k)",
   "pymupdf4llm.to_markdown = tm",
   `OUT = m.mode_pdf_primary({"path": ${JSON.stringify(fx("scan.pdf"))}, "pages": [1], "stagingDir": ${JSON.stringify(d.stagingDir)}, "imageFormat": "png", "imageDpi": 72, "ocr": True, "ocrLanguage": "eng", "ocrBudgetMs": 60000})`,
  ].join("\n"));
  assert.deepEqual(out.ocr.noText, [1]); assert.deepEqual(out.ocr.pages, []); assert.ok(out.emptyPages.includes(1));
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("failed OCR and failed retry count only as failed page", T, async () => {
 const d = dirs();
 try {
  const out = await py(["import pymupdf4llm", READY,
   "orig = pymupdf4llm.to_markdown",
   "def tm(*a, **k):",
   "    if k.get('pages') == [0]: raise RuntimeError('page 1 failed')",
   "    return orig(*a, **k)",
   "pymupdf4llm.to_markdown = tm",
   `OUT = m.mode_pdf_primary({"path": ${JSON.stringify(fx("multipage.pdf"))}, "pages": [1, 2], "stagingDir": ${JSON.stringify(d.stagingDir)}, "imageFormat": "png", "imageDpi": 72, "ocr": True, "ocrLanguage": "eng", "ocrBudgetMs": 60000})`,
  ].join("\n"));
  assert.ok(out.failedPages.some((p: { page: number }) => p.page === 1)); assert.ok(!out.ocr.ocrFailed.includes(1));
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("real OCR labels text recognized on scan", T, async (t) => {
 if ((await py(`OUT = m.ocr_status(True, "eng")["status"]`)) !== "ready") { t.skip("no Tesseract language data"); return; }
 const d = dirs();
 try {
  const r = await child("pdf-primary", { path: fx("scan.pdf"), stagingDir: d.stagingDir, imageFormat: "png", imageDpi: 72, ocr: true, ocrLanguage: "eng", ocrBudgetMs: 60000 });
  assert.ok(r.markdown.includes("![page 1](p1/page.png)\n\n\x00OCR p1/page.png\x00\n>\n> "), r.markdown);
  assert.match(r.markdown, /> .*Hello OCR world 12345/);
  assert.equal(r.ocr.status, "ran"); assert.deepEqual(r.ocr.pages, [1]); assert.deepEqual(r.emptyPages, []);
 } finally { rmSync(d.root, { recursive: true, force: true }); }
});
