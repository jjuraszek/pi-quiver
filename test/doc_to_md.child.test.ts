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

test("xls child: truncated preview note precedes the unavailable render note", T, async () => {
	const d = dirs();
	try {
		const r = await child("xlsx", { path: fx("tall.xls"), stagingDir: d.stagingDir, sheetsStagingDir: d.sheetsStagingDir });
		assert.deepStrictEqual(r.notes, ["preview truncated: Tall (100 of 150 rows); full data: sheets/s0-tall.csv", "Rendered views: unavailable (visual detection not supported for .xls)"]);
		assert.match(r.markdown, /Preview \(rows 1-100 of 150/);
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

test("clamped render and OCR budget", T, async () => {
	const out = await py([
		"a = [m.clamped_dpi(612, 792, 150), m.clamped_dpi(3000, 3000, 150), m.clamped_dpi(14400, 14400, 150), m.clamped_dpi(40, 40, 150)]",
		"b = [m.ocr_admit(0, 4000, 0, 250, 60000), m.ocr_admit(50, 4000, 0, 250, 10000), m.ocr_admit(0, 4000, 0, 250, 8000), m.ocr_admit(40000, 4000, 10, 250, 60000), m.ocr_admit(52000, 4000, 10, 250, 60000)]",
		"OUT = [a, b]",
	].join("\n"));
	assert.deepEqual(out[0], [150, 96, null, null]); assert.deepEqual(out[1], [true, true, false, true, false]);
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
		assert.deepEqual(out[2].ocrFailed, [1]); assert.deepEqual(out[3], [true, false]); assert.deepEqual(out[4], []);
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

test("OCR on a text page passes use_ocr False and keeps both embedded images", T, async () => {
	const d = dirs();
	try {
		const seen = await py(`calls = []
real = m.primary_page_markdown
def spy(doc, n, d, o, kw, write_images):
				calls.append(dict(kw)); return real(doc, n, d, o, kw, write_images)
m.primary_page_markdown = spy
r = m.mode_pdf_primary({"path": ${JSON.stringify(fx("mixed-images.pdf"))}, "stagingDir": ${JSON.stringify(d.stagingDir)}, "imageDpi": 150, "imageFormat": "png", "ocr": True, "ocrLanguage": "eng", "ocrBudgetMs": 60000})
OUT = {"calls": calls, "files": sorted(os.listdir(os.path.join(${JSON.stringify(d.stagingDir)}, "p1"))), "md": r["markdown"], "ocr": r["ocr"]}`);
		assert.deepStrictEqual(seen.calls, [{ use_ocr: false }]);
		assert.deepStrictEqual(seen.files.filter((f: string) => f !== ".done").length, 2);
		assert.strictEqual((seen.md.match(/!\[[^\]]*\]\(p1\/img\d\.png\)/g) ?? []).length, 2);
		assert.deepStrictEqual(seen.ocr.pages, []);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("page_ocr_kwargs: textless -> force OCR, text -> use_ocr False", T, async () => {
	const r = await py(`OUT = [m.page_ocr_kwargs(True, "deu"), m.page_ocr_kwargs(False, "deu"), hasattr(m, "small_image_gate"), hasattr(m, "SMALL_IMAGE_FRACTION")]`);
	assert.deepStrictEqual(r, [{ use_ocr: true, force_ocr: true, ocr_language: "deu" }, { use_ocr: false }, false, false]);
});

test("pageImages: primary and fallback tiers render selected pages before markers", T, async () => {
	const d = dirs(); const pages = join(d.root, "pages", ".stage-x");
	try {
		for (const mode of ["pdf-primary", "pdf-fallback"]) {
			rmSync(pages, { recursive: true, force: true });
			const r = await child(mode, { path: fx("multipage.pdf"), pages: [1, 2, 4], stagingDir: d.stagingDir, pagesStagingDir: pages, pageImages: true, imageDpi: 50, imageFormat: "png" });
			assert.deepStrictEqual(r.pageImages, [{ page: 1, file: "p1.png" }, { page: 2, file: "p2.png" }, { page: 4, file: "p4.png" }]);
			assert.deepStrictEqual(readdirSync(pages).sort(), ["p1.png", "p2.png", "p4.png"]);
			assert.match(r.markdown, /!\[page 2\]\(pages\/p2\.png\)\n\n--- end of page\.page_number=2 ---/);
			assert.strictEqual((r.markdown.match(/!\[page 4\]/g) ?? []).length, 1);
		}
		const all = await child("pdf-primary", { path: fx("multipage.pdf"), stagingDir: d.stagingDir, pagesStagingDir: pages, pageImages: true, imageDpi: 50, imageFormat: "png" });
		assert.strictEqual(all.pageImages.length, 6);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("pageImages: a failed primary page does not leave an orphan render", T, async () => {
	const d = dirs(); const pages = join(d.root, "pages", ".stage-x");
	try {
		const r = await py(`
real = m.mark_done
def fail_second(d):
    if os.path.basename(d) == 'p2': raise RuntimeError('page body failed')
    return real(d)
m.mark_done = fail_second
OUT = m.mode_pdf_primary({"path": ${JSON.stringify(fx("multipage.pdf"))}, "pages": [1, 2], "stagingDir": ${JSON.stringify(d.stagingDir)}, "pagesStagingDir": ${JSON.stringify(pages)}, "pageImages": True, "imageDpi": 50, "imageFormat": "png", "ocr": False})`);
		assert.deepStrictEqual(r.pageImages, [{ page: 1, file: "p1.png" }]);
		assert.ok(!existsSync(join(pages, "p2.png")));
		assert.deepStrictEqual(r.failedPages, [{ page: 2, error: "RuntimeError: page body failed" }]);
		assert.ok(r.notes.includes("Page images: 1 of 2 unavailable"));
		assert.match(r.markdown, /!\[page 1\]\(pages\/p1\.png\)\n\n--- end of page\.page_number=1 ---/);
		assert.ok(!r.markdown.includes("pages/p2.png"));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("page render failures leave PDF text intact and count unavailable images in both tiers", T, async () => {
	const d = dirs();
	try {
		for (const mode of ["primary", "fallback"]) {
			const r = await py(`
import pymupdf
real = pymupdf.Page.get_pixmap
def broken(self, *args, **kwargs):
				if self.number == 1 and "dpi" in kwargs and kwargs["dpi"] == 50:
								raise RuntimeError("render failed")
				return real(self, *args, **kwargs)
pymupdf.Page.get_pixmap = broken
OUT = m.mode_pdf_${mode}({"path": ${JSON.stringify(fx("multipage.pdf"))}, "pages": [1, 2], "stagingDir": ${JSON.stringify(d.stagingDir)}, "pagesStagingDir": ${JSON.stringify(join(d.root, "pages"))}, "pageImages": True, "imageDpi": 50, "imageFormat": "png", "ocr": False})`);
			assert.match(r.markdown, /PAGE-2/);
			assert.match(r.markdown, /--- end of page\.page_number=2 ---/);
			assert.deepStrictEqual(r.pageImages, [{ page: 1, file: "p1.png" }]);
			assert.ok(r.notes.includes("Page images: 1 of 2 unavailable"), JSON.stringify(r.notes));
			assert.deepStrictEqual(r.failedPages, []);
		}
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx numbering detects trailing unnumbered labels as drift", T, async () => {
	const d = dirs();
	try {
		const r = await py(`
import docx_numbering
real = docx_numbering.compute_labels
docx_numbering.compute_labels = lambda path: real(path) + [None]
OUT = m.mode_docx({"path": ${JSON.stringify(fx("numbered.docx"))}, "stagingDir": ${JSON.stringify(d.stagingDir)}})`);
		assert.ok(r.notes.includes("Numbering: labels unavailable (paragraph sequence differs from mammoth's)"), JSON.stringify(r.notes));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("xlsm converts like xlsx with a macros note; truncated previews produce one aggregated note first", T, async () => {
	const d = dirs();
	try {
		const x = await child("xlsx", { path: fx("macros.xlsm"), stagingDir: d.stagingDir, sheetsStagingDir: d.sheetsStagingDir });
		assert.ok(x.notes.includes("macros ignored (VBA project not converted)"), JSON.stringify(x.notes));
		assert.ok(x.markdown.includes("## Data"));
		const t = await child("xlsx", { path: fx("tall.xlsx"), stagingDir: d.stagingDir, sheetsStagingDir: d.sheetsStagingDir });
		assert.strictEqual(t.notes[0], "preview truncated: Tall (100 of 150 rows); Wide (100 of 120 rows, 50 of 60 columns); full data: sheets/s0-tall.csv, sheets/s1-wide.csv");
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx numbering: literal labels on headings and lists, restart, lvlRestart=0, bullets, typed text untouched", T, async () => {
	const d = dirs();
	try {
		const r = await child("docx", { path: fx("numbered.docx"), stagingDir: d.stagingDir });
		const md: string = r.markdown;
		for (const line of ["# 1. Introduction", "## 1.1 Scope", "# 2. Design", "## 2.1 Interfaces", "See 3.2.1 for trip settings.", "1. Alpha", "1.1 Alpha one", "2.2 Beta two", "3.2 Gamma two", "3.2.1 Trip settings", "1. Delta restarts", "1. Ex", "1.1 Ex sub", "2. Why", "2.2 Why sub", "- Bullet item"]) assert.ok(md.includes(`\n${line}\n`) || md.startsWith(`${line}\n`), `${line}\n---\n${md}`);
		assert.ok(!/^\d+\. 1\. /m.test(md));
		assert.deepStrictEqual(r.notes.filter((n: string) => n.startsWith("Numbering:")), []);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx numbering inherited through basedOn trusts the module label", T, async () => {
	const d = dirs();
	try {
		const out = join(d.root, "inherited.docx");
		const python = `import docx, sys
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def element(tag, val):
    node = OxmlElement('w:' + tag)
    node.set(qn('w:val'), str(val))
    return node

d = docx.Document()
numbering = d.part.numbering_part.element
abstract_id = max([int(n.get(qn('w:abstractNumId'))) for n in numbering.findall(qn('w:abstractNum'))], default=-1) + 1
num_id = max([int(n.get(qn('w:numId'))) for n in numbering.findall(qn('w:num'))], default=0) + 1
abstract = OxmlElement('w:abstractNum')
abstract.set(qn('w:abstractNumId'), str(abstract_id))
lvl = OxmlElement('w:lvl')
lvl.set(qn('w:ilvl'), '0')
for tag, val in [('start', 3), ('numFmt', 'decimal'), ('lvlText', '%1.')]:
    lvl.append(element(tag, val))
abstract.append(lvl)
numbering.append(abstract)
num = OxmlElement('w:num')
num.set(qn('w:numId'), str(num_id))
num.append(element('abstractNumId', abstract_id))
numbering.append(num)
base = d.styles.add_style('BaseNumbered', WD_STYLE_TYPE.PARAGRAPH)
ppr = base.element.get_or_add_pPr()
numpr = OxmlElement('w:numPr')
numpr.append(element('ilvl', 0))
numpr.append(element('numId', num_id))
ppr.append(numpr)
derived = d.styles.add_style('DerivedNumbered', WD_STYLE_TYPE.PARAGRAPH)
derived.base_style = base
d.add_paragraph('Inherited item', style=derived)
d.save(sys.argv[1])`;
		const g = spawnSync("uv", ["run", "--with", "python-docx==1.2.0", "--python", "3.14", "python", "-c", python, out], { encoding: "utf8" });
		assert.equal(g.status, 0, g.stderr);
		const r = await child("docx", { path: out, stagingDir: d.stagingDir });
		assert.match(r.markdown, /3\. Inherited item/);
		assert.deepStrictEqual(r.notes.filter((n: string) => n.startsWith("Numbering:")), []);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("docx numbering fallback: missing numId, unknown numFmt and python-docx route carry the Numbering note, exit 0", T, async () => {
	const d = dirs();
	try {
		const a = await child("docx", { path: fx("missing-num.docx"), stagingDir: d.stagingDir });
		assert.match(a.notes.join("\n"), /^Numbering: labels unavailable \(.*numId 9.*\)$/m);
		assert.ok(a.markdown.includes("Points nowhere"));
		const b = await child("docx", { path: fx("unknown-numfmt.docx"), stagingDir: d.stagingDir });
		assert.match(b.notes.join("\n"), /^Numbering: labels unavailable \(.*numFmt chicago.*\)$/m);
		assert.ok(b.markdown.includes("Chicago style"));
		const c = await childRaw("docx", { path: fx("numbered.docx"), stagingDir: d.stagingDir }, { ...process.env, DOC_TO_MD_FORCE_DOCX_FALLBACK: "1" });
		assert.strictEqual(c.code, 0);
		assert.ok(JSON.parse(c.stdout).notes.includes("Numbering: labels unavailable (python-docx fallback)"));
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("page stats: both PDF tiers return chars, images and clamped coverage per selected page", T, async () => {
	const d = dirs();
	try {
		const p = await child("pdf-primary", { path: fx("scan.pdf"), stagingDir: d.stagingDir, imageFormat: "png", imageDpi: 72, ocr: false });
		assert.deepEqual(p.pageStats.map((s: { page: number }) => s.page), [1, 2]);
		assert.deepEqual(p.pageStats[0], { page: 1, chars: 0, images: 1, imageCoverage: 0.11 });
		assert.deepEqual(p.pageStats[1], { page: 2, chars: 23, images: 0, imageCoverage: 0 });
		const f = await child("pdf-fallback", { path: fx("scan.pdf"), pages: [2], stagingDir: join(d.root, "fb"), imageFormat: "png", imageDpi: 72, ocr: false });
		assert.deepEqual(f.pageStats, [{ page: 2, chars: 23, images: 0, imageCoverage: 0 }]);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("page stats: coverage clamps to 1.0 and a stats-only exception keeps the page's Markdown", T, async () => {
	const d = dirs();
	try {
		const out = await py([
			"import pymupdf",
			`doc = pymupdf.open(); image = open(${JSON.stringify(fx("ocr.png"))}, 'rb').read()`,
			"page = doc.new_page(); page.insert_image(page.rect, stream=image, keep_proportion=False); page.insert_image(page.rect, stream=image, keep_proportion=False)",
			`path = os.path.join(${JSON.stringify(d.root)}, 'double.pdf'); doc.save(path); doc.close()`,
			"full = m.page_stats(pymupdf.open(path), 1)",
			"orig = pymupdf.Page.get_image_info",
			"def boom(self, *a, **k): raise RuntimeError('bomb')",
			"pymupdf.Page.get_image_info = boom",
			`r = m.mode_pdf_primary({"path": ${JSON.stringify(fx("scan.pdf"))}, "pages": [2], "stagingDir": ${JSON.stringify(d.stagingDir)}, "imageFormat": "png", "imageDpi": 72, "ocr": False, "ocrLanguage": "eng", "ocrBudgetMs": 60000})`,
			`f = m.mode_pdf_fallback({"path": ${JSON.stringify(fx("scan.pdf"))}, "pages": [2], "keepPages": {2: []}, "stagingDir": ${JSON.stringify(join(d.root, "fb"))}, "imageFormat": "png", "imageDpi": 72, "ocr": False})`,
			"pymupdf.Page.get_image_info = orig",
			"OUT = [full, r['pageStats'], r['failedPages'], r['markdown'], f['pageStats'], f['failedPages'], f['markdown']]",
		].join("\n"));
		assert.deepEqual(out[0], { page: 1, chars: 0, images: 2, imageCoverage: 1 });
		for (const index of [1, 4]) {
			assert.deepEqual(out[index], [{ page: 2, error: "RuntimeError: bomb" }]);
			assert.deepEqual(out[index + 1], []);
			assert.ok(out[index + 2].includes("PAGE-2"), out[index + 2]);
		}
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

const ocrPagesOpts = (staging: string, pages: number[], budget = 60000) => `{"path": ${JSON.stringify(fx("scan.pdf"))}, "pages": ${JSON.stringify(pages)}, "stem": "scan", "stagingDir": ${JSON.stringify(staging)}, "ocrLanguage": "eng", "ocrBudgetMs": ${budget}, "dpi": 72}`;
const FAKE_OCR = [
	"import pymupdf",
	"def fake(self, flags=3, language='eng', dpi=72, full=False, tessdata=None):",
	"    if self.number == 0: raise RuntimeError('tesseract exploded')",
	"    return self.get_textpage()",
	"pymupdf.Page.get_textpage_ocr = fake",
].join("\n");

test("ocr-pages child: per-page failure writes .failed, success writes the sidecar and .done, active is cleared", T, async () => {
	const d = dirs();
	try {
		const staging = join(d.root, "ocr", ".stage-x");
		const out = await py([READY, FAKE_OCR,
			`r = m.mode_ocr_pages(${ocrPagesOpts(staging, [1, 2])})`,
			`p1 = sorted(os.listdir(os.path.join(${JSON.stringify(staging)}, 'p001')))`,
			`p2 = sorted(os.listdir(os.path.join(${JSON.stringify(staging)}, 'p002')))`,
			`failed = open(os.path.join(${JSON.stringify(staging)}, 'p001', '.failed')).read()`,
			`side = open(os.path.join(${JSON.stringify(staging)}, 'p002', 'scan-p002.md')).read()`,
			"import time", "clock = [0.0]", "time.monotonic = lambda: clock[0]",
			"def slow(self, **k):", "    clock[0] += 4.0", "    raise RuntimeError('x' * 400)",
			"pymupdf.Page.get_textpage_ocr = slow",
			`b = m.mode_ocr_pages(${ocrPagesOpts(join(d.root, "budget"), [1, 2], 12000)})`,
			`long_failed = open(os.path.join(${JSON.stringify(join(d.root, "budget"))}, f"p{b['ocrFailed'][0]:03d}", '.failed')).read()`,
			`OUT = [r, p1, p2, failed, side, os.path.exists(os.path.join(${JSON.stringify(staging)}, 'active')), b, long_failed]`].join("\n"));
		assert.deepEqual(out[0], { status: "ran", written: [2], noText: [], ocrFailed: [1], ocrErrors: { "1": "RuntimeError: tesseract exploded" }, budgetStopped: [] });
		assert.deepEqual(out[1], [".failed"]); assert.deepEqual(out[2], [".done", "scan-p002.md"]);
		assert.equal(out[3], "RuntimeError: tesseract exploded");
		assert.ok(out[4].startsWith("<!-- OCR of page 2 (tesseract eng); recognized text, not the text layer -->\n\nPAGE-2 has a text layer"), out[4]);
		assert.ok(out[4].endsWith("\n\n--- end of page.page_number=2 ---\n"), out[4]);
		assert.equal(out[5], false);
		assert.deepEqual(out[6].budgetStopped, [2]);
		assert.equal(out[6].ocrErrors[1], `RuntimeError: ${"x".repeat(400)}`);
		assert.equal(out[7], out[6].ocrErrors[1]);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("ocr-pages child: empty recognized text is a header-only sidecar in noText; unavailable Tesseract returns status only", T, async () => {
	const d = dirs();
	try {
		const staging = join(d.root, "ocr", ".stage-x");
		const out = await py([READY, "import pymupdf",
			"pymupdf.Page.get_textpage_ocr = lambda self, **k: self.get_textpage()",
			`r = m.mode_ocr_pages(${ocrPagesOpts(staging, [1])})`,
			`side = open(os.path.join(${JSON.stringify(staging)}, 'p001', 'scan-p001.md')).read()`,
			`m.ocr_status = lambda ocr, lang: {"status": "unavailable", "reason": "language data for eng not installed", "tesseract": None}`,
			`u = m.mode_ocr_pages(${ocrPagesOpts(join(d.root, "u"), [1])})`,
			`OUT = [r, side, u, os.path.exists(os.path.join(${JSON.stringify(join(d.root, "u"))}, 'p001'))]`].join("\n"));
		assert.deepEqual(out[0], { status: "ran", written: [], noText: [1], ocrFailed: [], ocrErrors: {}, budgetStopped: [] });
		assert.equal(out[1], "<!-- OCR of page 1 (tesseract eng); recognized text, not the text layer -->\n\n--- end of page.page_number=1 ---\n");
		assert.deepEqual(out[2], { status: "unavailable", reason: "language data for eng not installed" });
		assert.equal(out[3], false);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("ocr-pages child: budget stop lists the current and remaining pages with a controlled clock", T, async () => {
	const d = dirs();
	try {
		const out = await py([READY, "import pymupdf, time", "clock = [0.0]", "time.monotonic = lambda: clock[0]",
			"def slow(self, **k):", "    clock[0] += 4.0", "    return self.get_textpage()",
			"pymupdf.Page.get_textpage_ocr = slow",
			`a = m.mode_ocr_pages(${ocrPagesOpts(join(d.root, "a"), [1, 2], 12000)})`,
			"clock[0] = 0.0",
			`b = m.mode_ocr_pages(${ocrPagesOpts(join(d.root, "b"), [1, 2], 8000)})`,
			`OUT = [a, b, os.path.exists(os.path.join(${JSON.stringify(join(d.root, "b"))}, 'active'))]`].join("\n"));
		assert.deepEqual([out[0].noText, out[0].budgetStopped], [[1], [2]]);
		assert.deepEqual([out[1].written, out[1].noText, out[1].budgetStopped], [[], [], [1, 2]]);
		assert.equal(out[2], false);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

const emailDirs = () => { const d = dirs(); return { ...d, attachmentsStagingDir: join(d.root, "attachments", ".stage-x") }; };

test("email child: .eml HTML, headers, inline image, safe attachments", T, async () => {
	const d = emailDirs();
	try {
		const r = await child("email", { path: fx("sample.eml"), stem: "sample", stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		const md: string = r.markdown;
		assert.equal(r.engine, "email");
		assert.ok(md.startsWith("# Fixture: relay \\| settings\n\n| Header | Value |\n|---|---|\n| From | Ann Sender <ann@example.com> |\n| To | Bob Reader <bob@example.com> |\n| Cc | cc@example.com |\n| Date | 2026-03-02T10:00:00+01:00 |\n| Subject | Fixture: relay \\| settings |"), md);
		assert.ok(md.includes("# Relay settings") && md.includes("TX-101 trips at **85%**"));
		assert.match(md, /!\[figure\]\(p1\/img1\.png\)/);
		assert.ok(existsSync(join(d.stagingDir, "p1", "img1.png")) && existsSync(join(d.stagingDir, "p1", ".done")));
		assert.deepEqual(readdirSync(d.attachmentsStagingDir).sort(), ["evil.txt", "notes.txt"]);
		assert.match(md, /## Attachments\n\n- \[`notes\.txt`\]\(attachments\/notes\.txt\) \(11B, text\/plain\)\n- \[`evil\.txt`\]\(attachments\/evil\.txt\) \(5B, text\/plain\)/);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("email child: .msg extract-msg header and TIFF attachments", T, async () => {
	const d = emailDirs();
	try {
		const r = await child("email", { path: fx("sample.msg"), stem: "sample", stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.equal(r.engine, "extract-msg");
		assert.ok(r.markdown.startsWith("# Test for TIF files\n"));
		assert.match(r.markdown, /\| From \| Brian Zhou <brizhou@gmail\.com> \|/);
		assert.match(r.markdown, /\| Cc \| Brian Zhou <brizhou@gmail\.com> \|/);
		assert.match(r.markdown, /\| Date \| 2013-11-18T09:26:24\+01:00 \|/);
		assert.deepEqual(readdirSync(d.attachmentsStagingDir).sort(), ["import_OleFileIO.tif", "raised_value_error.tif"]);
		assert.match(r.markdown, /- \[`import_OleFileIO\.tif`\]\(attachments\/import_OleFileIO\.tif\) \(946\.9KB, image\/tiff\)/);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("email child: embedded MSG attachments export raw bytes", T, async () => {
	const result = await py(`import types
class Embedded:
    def exportBytes(self): return b'embedded-msg'
class Attachment(Embedded):
    data = Embedded()
    longFilename = 'Fwd: status'
    shortFilename = None
class Message:
    htmlBody = None
    attachments = [Attachment()]
    sender = to = cc = subject = body = date = None
sys.modules['extract_msg'] = types.SimpleNamespace(openMsg=lambda path: Message(), attachments=types.SimpleNamespace(EmbeddedMsgAttachment=Embedded))
attachments = m.parse_msg('unused.msg')[-1]
OUT = [(name, data.decode() if data else None, ctype, reason) for name, data, ctype, reason in attachments]`);
	assert.deepEqual(result, [["Fwd: status.msg", "embedded-msg", "application/vnd.ms-outlook", null]]);
});

test("email child: unextractable MSG attachments are listed without files", T, async () => {
	const d = emailDirs();
	try {
		const out = await py(`import types
class Missing:
    longFilename = 'cloud.url'
    shortFilename = None
    @property
    def data(self): raise NotImplementedError('cloud reference')
class Unsupported:
    longFilename = 'unsupported.bin'
    shortFilename = None
    data = None
class Good:
    longFilename = 'good.txt'
    shortFilename = None
    data = b'good'
    cid = None
    mimetype = 'text/plain'
class Message:
    htmlBody = None
    attachments = [Missing(), Unsupported(), Good()]
    sender = to = cc = subject = body = date = None
sys.modules['extract_msg'] = types.SimpleNamespace(openMsg=lambda path: Message(), attachments=types.SimpleNamespace(EmbeddedMsgAttachment=type('Embedded', (), {})))
OUT = m.mode_email({'path': 'unused.msg', 'stagingDir': ${JSON.stringify(d.stagingDir)}, 'attachmentsStagingDir': ${JSON.stringify(d.attachmentsStagingDir)}})`);
		assert.match(out.markdown, /cloud\.url.*\(not extracted: cloud reference\)/);
		assert.match(out.markdown, /unsupported\.bin.*\(not extracted: data unavailable\)/);
		assert.match(out.markdown, /good\.txt.*attachments\/good\.txt/);
		assert.deepEqual(readdirSync(d.attachmentsStagingDir), ["good.txt"]);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("email child: attached rfc822 stays one raw attachment", T, async () => {
	const d = emailDirs();
	try {
		const path = join(d.root, "forward.eml");
		writeFileSync(path, 'From: outer@example.com\nSubject: Outer\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="outer"\n\n--outer\nContent-Type: text/plain\n\nOuter body\n--outer\nContent-Type: message/rfc822\nContent-Disposition: attachment; filename="forward.eml"\n\nFrom: inner@example.com\nSubject: Inner\nContent-Type: text/plain\n\nInner body\n--outer--\n');
		const result = await child("email", { path, stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.match(result.markdown, /Outer body/);
		assert.doesNotMatch(result.markdown, /Inner body/);
		assert.match(result.markdown, /attachments\/forward\.eml/);
		assert.match(readFileSync(join(d.attachmentsStagingDir, "forward.eml"), "utf8"), /Inner body/);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("email child: malformed Date retains raw header", T, async () => {
	const d = emailDirs();
	try {
		const path = join(d.root, "date.eml");
		writeFileSync(path, "From: x@example.com\nDate: impossible date\n\nbody\n");
		const result = await child("email", { path, stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.match(result.markdown, /\| Date \| impossible date \|/);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("email child: staging failure is not called a parse failure", T, async () => {
	const d = emailDirs();
	try {
		mkdirSync(join(d.root, "images"));
		writeFileSync(d.stagingDir, "blocked");
		const path = join(d.root, "valid.eml");
		writeFileSync(path, "From: x@example.com\n\nbody\n");
		const result = await childRaw("email", { path, stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.equal(result.code, 1);
		assert.doesNotMatch(result.stderr, /email parse failed:/);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});

test("email child: safe names, duplicates, bodiless and invalid message", T, async () => {
	assert.deepEqual(await py(`OUT = [m.safe_attachment_name(n, i) for i, n in enumerate(["../evil.txt", "", "Q3 report (final).PDF", "a/b\\\\c.tar.gz", "noext"])]`), ["evil.txt", "attachment-2", "Q3_report_final_.pdf", "c.tar.gz", "noext"]);
	assert.deepEqual(await py(`OUT = m.dedupe_names(["a.txt", "a.txt", "a.txt", "b", "Report.pdf", "report.pdf"])`), ["a.txt", "a-2.txt", "a-3.txt", "b", "Report.pdf", "report-2.pdf"]);
	assert.deepEqual(await py(`OUT = m.safe_attachment_name('报告.pdf', 2)`), "attachment-3.pdf");
	const d = emailDirs();
	try {
		writeFileSync(join(d.root, "bare.eml"), "From: x@example.com\nSubject: no body\n\n");
		const bare = await child("email", { path: join(d.root, "bare.eml"), stem: "bare", stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.ok(bare.markdown.includes("| To |  |") && bare.markdown.includes("\nBody: none\n") && !bare.markdown.includes("## Attachments"));
		assert.ok(!bare.markdown.includes("| Cc |"));
		writeFileSync(join(d.root, "plain.eml"), "From: x@example.com\nSubject: plain\nContent-Type: text/plain; charset=utf-8\n\n  indented  \n\n");
		const plain = await child("email", { path: join(d.root, "plain.eml"), stem: "plain", stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.ok(plain.markdown.includes("\n\n  indented  \n\n\n"), plain.markdown);
		writeFileSync(join(d.root, "bad.msg"), "not an ole file");
		const bad = await childRaw("email", { path: join(d.root, "bad.msg"), stem: "bad", stagingDir: d.stagingDir, attachmentsStagingDir: d.attachmentsStagingDir });
		assert.equal(bad.code, 1);
		assert.match(bad.stderr, /email parse failed: /);
	} finally { rmSync(d.root, { recursive: true, force: true }); }
});
