import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapped, uvChildArgs } from "../lib/doc-to-md-core.ts";
import { TUNABLE_DEFAULTS } from "../lib/doc-to-md-options.ts";

const T = { timeout: 300_000, skip: spawnSync("uv", ["--version"], { stdio: "ignore" }).status !== 0 && "uv not on PATH" } as const;
const CFG = { pymupdfVersion: TUNABLE_DEFAULTS.pymupdfVersion, warmTimeoutMs: 0 };
const MODULE = fileURLToPath(new URL("../scripts/docx_numbering.py", import.meta.url));
const BUILD = `
from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
def lvl(i, fmt, text, start=1, restart=None, pstyle=None, extra=""):
    extra += (f'<w:lvlRestart w:val="{restart}"/>' if restart is not None else "") + (f'<w:pStyle w:val="{pstyle}"/>' if pstyle else "")
    return f'<w:lvl w:ilvl="{i}"><w:start w:val="{start}"/><w:numFmt w:val="{fmt}"/>{extra}<w:lvlText w:val="{text}"/></w:lvl>'
def build(path, abstracts, nums, paragraphs):
    d = Document(); numbering = d.part.numbering_part.element
    for c in list(numbering): numbering.remove(c)
    for aid, levels in abstracts.items():
        numbering.append(parse_xml(f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{aid}">' + "".join(levels) + '</w:abstractNum>'))
    for nid, (aid, override) in nums.items():
        numbering.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{nid}"><w:abstractNumId w:val="{aid}"/>{override}</w:num>'))
    for text, style, num in paragraphs:
        p = d.add_paragraph(text, style=style) if style else d.add_paragraph(text)
        if num: p._p.get_or_add_pPr().append(parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'))
    d.save(path)
`;
async function py(body: string) {
	const dir = mkdtempSync(join(tmpdir(), "docx-numbering-"));
	try {
		const program = `import importlib.util, json\nspec = importlib.util.spec_from_file_location("docx_numbering", ${JSON.stringify(MODULE)})\nm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\npath = ${JSON.stringify(join(dir, "input.docx"))}\n${BUILD}\n${body}\nprint(json.dumps(OUT))`;
		const r = await runCapped("uv", uvChildArgs(CFG, "-c", program), { timeoutMs: 240_000, capBytes: 20_000_000 });
		assert.equal(r.code, 0, r.stderr.slice(-2000));
		return JSON.parse(r.stdout);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
const para = (levels: number[], nid = 1) => `json.loads(${JSON.stringify(JSON.stringify(levels.map((i) => ["item", null, [nid, i]])))})`;

test("decimal levels, plain paragraphs, independent numId and restart rules", T, async () => {
	const levels = `[lvl(0,'decimal','%1.'),lvl(1,'decimal','%1.%2'),lvl(2,'decimal','%1.%2.%3')]`;
	assert.deepEqual(await py(`build(path,{0:${levels}},{1:(0,'')},json.loads(${JSON.stringify(JSON.stringify([["item",null,[1,0]],["item",null,[1,1]],["plain",null,null],...([0,1,1,0,1,1,2] as const).map((i) => ["item",null,[1,i]] as const)]))}))\nOUT=m.compute_labels(path)`), ["1.","1.1",null,"2.","2.1","2.2","3.","3.1","3.2","3.2.1"]);
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.')]},{1:(0,''),2:(0,'<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>')},json.loads(${JSON.stringify(JSON.stringify([["a",null,[1,0]],["plain",null,null],["b",null,[1,0]],["c",null,[1,0]],["d",null,[2,0]]]))}))\nOUT=m.compute_labels(path)`), ["1.",null,"2.","3.","1."]);
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.'),lvl(1,'decimal','%1.%2',restart=0)]},{1:(0,'')},${para([0,1,0,1])})\nOUT=m.compute_labels(path)`), ["1.","1.1","2.","2.2"]);
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.'),lvl(1,'decimal','%1.%2'),lvl(2,'decimal','%1.%2.%3',restart=2)]},{1:(0,'')},${para([0,1,2,1,2])})\nOUT=m.compute_labels(path)`), ["1.","1.1","1.1.1","1.2","1.2.1"]);
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.'),lvl(1,'decimal','%1.%2'),lvl(2,'decimal','%1.%3',restart=1)]},{1:(0,'')},${para([0,2,0,2])})\nOUT=m.compute_labels(path)`), ["1.","1.1","2.","2.1"]);
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.'),lvl(1,'decimal','%1.%2'),lvl(2,'decimal','%1.%3',restart=1)]},{1:(0,'')},${para([0,2,1,2])})\nOUT=m.compute_labels(path)`), ["1.","1.1","1.1","1.2"]);
});

test("numbering instances share abstract counters and startOverride resets only once", T, async () => {
	const levels = "{0:[lvl(0,'decimal','%1.')]}";
	const paragraphs = (ids: number[]) => `json.loads(${JSON.stringify(JSON.stringify(ids.map((nid) => ["item", null, [nid, 0]])))})`;
	assert.deepEqual(await py(`build(path,${levels},{1:(0,''),2:(0,'')},${paragraphs([1,1,2,2,1])})\nOUT=m.compute_labels(path)`), ["1.","2.","3.","4.","5."]);
	assert.deepEqual(await py(`build(path,${levels},{1:(0,''),2:(0,'<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>')},${paragraphs([1,1,1,2,2])})\nOUT=m.compute_labels(path)`), ["1.","2.","3.","1.","2."]);
});

test("later numbering instance adds a level to shared abstract counters", T, async () => {
	const override = '<w:lvlOverride w:ilvl="1">' + `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl>` + '</w:lvlOverride>';
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.')]},{1:(0,''),2:(0,${JSON.stringify(override)})},[['first',None,(1,0)],['second',None,(2,1)]])\nOUT=m.compute_labels(path)`), ["1.","1.1"]);
});

test("style levels, legal numbers and formats", T, async () => {
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'decimal','%1.',pstyle='Heading1'),lvl(1,'decimal','%1.%2',pstyle='Heading2')]},{1:(0,'')},[['one','Heading 1',None],['two','Heading 2',None]])\nOUT=m.compute_labels(path)`), ["1.","1.1"]);
	assert.deepEqual(await py(`build(path,{0:[lvl(0,'upperRoman','%1.'),lvl(1,'decimal','%1.%2',extra='<w:isLgl/>')]},{1:(0,'')},${para([0,1])})\nOUT=m.compute_labels(path)`), ["I.","1.1"]);
	for (const [fmt, expected] of [["lowerLetter","a."],["upperLetter","A."],["lowerRoman","i."],["decimalZero","01."],["bullet","-"]] ) {
		assert.deepEqual(await py(`build(path,{0:[lvl(0,${JSON.stringify(fmt)},${JSON.stringify(fmt === "bullet" ? "•" : "%1.")})]},{1:(0,'')},${para([0])})\nOUT=m.compute_labels(path)`), [expected]);
	}
});

test("unsupported numbering raises rather than guessing", T, async () => {
	assert.equal(await py(`build(path,{0:[lvl(0,'decimal','%1.')]},{1:(0,'')},[['item',None,None]])\nd=Document(path)\np=d.paragraphs[0]\np._p.get_or_add_pPr().append(parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="0"/></w:numPr>'))\nd.save(path)\nOUT='not raised'\ntry: m.compute_labels(path)\nexcept Exception as exc: OUT=str(exc)`), "numPr without numId");
	assert.equal(await py(`OUT='not raised'\ntry: m._roman(0)\nexcept Exception as exc: OUT=str(exc)`), "roman counter 0");
	for (const [level, nums] of [["lvl(0,'chicago','%1.')","{1:(0,'')}"],["lvl(0,'decimal','Item')","{1:(0,'')}"],["lvl(0,'decimal','%1.')","{}"]]) {
		assert.equal(await py(`build(path,{0:[${level}]},${nums},${para([0])})\ntry: m.compute_labels(path)\nexcept Exception as exc: OUT=type(exc).__name__`), "Unsupported");
	}
});

test("table cell paragraphs retain body document order", T, async () => {
	const body = `build(path,{0:[lvl(0,'decimal','%1.')]},{1:(0,'')},[['before',None,(1,0)]])\nd=Document(path)\nt=d.add_table(rows=1,cols=1)\np=t.cell(0,0).add_paragraph('inside')\np._p.get_or_add_pPr().append(parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'))\na=d.add_paragraph('after')\na._p.get_or_add_pPr().append(parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'))\nd.save(path)\nimport zipfile, xml.etree.ElementTree as ET\nwith zipfile.ZipFile(path) as zf:\n    doc_body = ET.fromstring(zf.read('word/document.xml')).find(m.W+'body')\nN = len(list(doc_body.iter(m.W+'p')))\nOUT = m.compute_labels(path)\nOUT = {'labels': OUT, 'count': len(OUT), 'paragraphs': N}`;
	const result = await py(body);
	assert.deepEqual(result.labels, ["1.",null,"2.","3."]);
	assert.equal(result.count, result.paragraphs);
});
