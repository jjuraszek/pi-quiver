#!/usr/bin/env python3
"""Regenerate the doc_to_md fixtures. Run from the repo root:
uv run --with pymupdf==1.27.2.3 --with pymupdf4llm==1.27.2.3 --with openpyxl==3.1.5 --with xlwt --with python-docx --with python-pptx --with pillow --python 3.14 python test/fixtures/generate.py [generator ...]
Pass generator names to regenerate a subset (e.g. charts charts_zero_extent).
pre_ocr_pdf runs only when explicitly named; the default run skips it.
Requires soffice on PATH (workbook.xlsx round-trip populates cached formula values).
sample.msg is a committed copy (see README.md in this directory)."""
import base64, io, os, random, shutil, subprocess, tempfile, zipfile, re
import pymupdf
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

def png_bytes(color):
    buf = io.BytesIO(); Image.new("RGB", (40, 30), color).save(buf, "PNG"); return buf.getvalue()

def multipage_pdf():
    doc = pymupdf.open()
    for n in range(1, 7):
        page = doc.new_page()
        if n == 4:
            continue  # blank page
        page.insert_text((72, 72), f"Chapter {n}" if n % 2 else f"Section {n}", fontsize=20 if n % 2 else 16)
        page.insert_text((72, 110), f"This paragraph belongs to PAGE-{n} and has non-trivial content about wiring.", fontsize=11)
        if n == 2:
            y = 150
            for row in [["Pin", "Color", "Function"], ["1", "Red", "VCC"], ["2", "Black", "GND"]]:
                for i, cell in enumerate(row):
                    page.insert_text((72 + i * 120, y), cell, fontsize=11)
                y += 18
        if n in (3, 5):
            page.insert_image(pymupdf.Rect(72, 200, 272, 350), stream=png_bytes("red" if n == 3 else "blue"))
        if n == 5:  # Add a true inline image (xref 0) alongside the embedded XObject raster.
            raw_image = bytes([0, 255, 0]) * (8 * 6)
            inline_image = b"\nq 60 0 0 45 300 200 cm BI /W 8 /H 6 /CS /RGB /BPC 8 ID\n" + raw_image + b"\nEI Q\n"
            contents = page.get_contents()[0]
            doc.update_stream(contents, doc.xref_stream(contents) + inline_image)
    doc.set_toc([[1, "Chapter 1", 1], [2, "Section 2", 2]])
    doc.set_metadata({"title": "Multipage Fixture", "author": "pi-quiver tests"})
    doc.save(os.path.join(HERE, "multipage.pdf"))
    enc = pymupdf.open(os.path.join(HERE, "multipage.pdf"))
    enc.save(os.path.join(HERE, "encrypted.pdf"), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="secret")

def shared_resources_pdf():
    doc = pymupdf.open()
    p1 = doc.new_page(); p1.insert_text((72, 72), "PAGE-1 draws the image")
    xref = p1.insert_image(pymupdf.Rect(72, 100, 172, 175), stream=png_bytes("orange"))
    p2 = doc.new_page(); p2.insert_text((72, 72), "PAGE-2 shares the resource but does not draw it")
    # Give page 2 an image resource, then remove its Do operator.
    p2 = doc[1]
    p2.insert_image(pymupdf.Rect(72, 100, 172, 175), stream=png_bytes("orange"))
    for contents in p2.get_contents():
        data = doc.xref_stream(contents)
        doc.update_stream(contents, re.sub(rb"/\S+\s+Do", b"", data))
    doc.save(os.path.join(HERE, "shared-resources.pdf"))

def office():
    from docx import Document
    from docx.enum.text import WD_BREAK
    from pptx import Presentation
    from pptx.util import Inches
    d = Document()
    for n in range(1, 6):
        d.add_heading(f"Heading {n}", level=1)
        d.add_paragraph(f"Body text for PAGE-{n}.")
        if n == 2:
            img = os.path.join(tempfile.gettempdir(), "fx.png"); open(img, "wb").write(png_bytes("purple")); d.add_picture(img)
        if n < 5:
            d.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    d.save(os.path.join(HERE, "multipage.docx"))
    prs = Presentation()
    for n in range(1, 5):
        s = prs.slides.add_slide(prs.slide_layouts[5]); s.shapes.title.text = f"SLIDE-{n}"
        if n == 2:
            img = os.path.join(tempfile.gettempdir(), "fx2.png"); open(img, "wb").write(png_bytes("teal")); s.shapes.add_picture(img, Inches(1), Inches(2))
    prs.save(os.path.join(HERE, "multislide.pptx"))

FOOTNOTES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>'
    '<w:r><w:t xml:space="preserve"> FOOTNOTE-TEXT about provenance.</w:t></w:r></w:p></w:footnote>'
    '</w:footnotes>'
).encode()

def _add_hyperlink(paragraph, url, text):
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    r_id = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink"); link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r"); t = OxmlElement("w:t"); t.text = text; run.append(t); link.append(run)
    paragraph._p.append(link)

def _add_footnote(document, paragraph):
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.opc.packuri import PackURI
    from docx.opc.part import Part
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    part = Part(PackURI("/word/footnotes.xml"),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
                FOOTNOTES_XML, document.part.package)
    document.part.relate_to(part, RT.FOOTNOTES)
    run = paragraph.add_run(); ref = OxmlElement("w:footnoteReference"); ref.set(qn("w:id"), "1"); run._r.append(ref)

def headings_docx():
    """Segment 1: H1/H2/H3, hyperlink, footnote ref, body PNG. Break 1 sits inside a Heading 1 paragraph.
    Segment 2: the heading remainder + a bullet list whose second item carries break 2.
    Segment 3: the remaining bullet, a table with a PNG in a cell, closing text. explicitBreaks=2, segments=3."""
    from docx import Document
    from docx.enum.text import WD_BREAK
    d = Document()
    d.core_properties.title = "Headings Fixture"; d.core_properties.author = "pi-quiver tests"
    d.add_heading("Chapter One", level=1)
    p = d.add_paragraph("Read more at "); _add_hyperlink(p, "https://github.com/jjuraszek/pi-quiver", "pi-quiver")
    p = d.add_paragraph("A claim with a note"); _add_footnote(d, p)
    d.add_heading("Section A", level=2)
    d.add_heading("Detail A1", level=3)
    img = os.path.join(tempfile.gettempdir(), "fx5.png"); open(img, "wb").write(png_bytes("green")); d.add_picture(img)
    h = d.add_heading("Chapter Two", level=1); h.add_run().add_break(WD_BREAK.PAGE); h.add_run("Continued")
    d.add_paragraph("alpha", style="List Bullet")
    b = d.add_paragraph("beta", style="List Bullet"); b.add_run().add_break(WD_BREAK.PAGE)
    d.add_paragraph("gamma", style="List Bullet")
    t = d.add_table(rows=1, cols=2); t.cell(0, 0).text = "Cell A"
    img2 = os.path.join(tempfile.gettempdir(), "fx6.png"); open(img2, "wb").write(png_bytes("brown"))
    t.cell(0, 1).paragraphs[0].add_run().add_picture(img2)
    d.add_paragraph("Last words in the final segment.")
    d.save(os.path.join(HERE, "headings.docx"))

def bold_headings_docx():
    from docx import Document
    d = Document()
    for title in ("Intro", "Method", "Results"):
        d.add_paragraph().add_run(title).bold = True
        d.add_paragraph(f"Body text under the bold paragraph {title}.")
    d.save(os.path.join(HERE, "bold-headings.docx"))

def workbook_source():
    import openpyxl, datetime
    from openpyxl.drawing.image import Image as XLImage
    wb = openpyxl.Workbook()
    ws = wb.active; ws.title = "Data"
    ws["A1"] = "Quarterly Data"; ws.merge_cells("A1:C1")
    for r in range(2, 21):
        ws.cell(r, 1, r); ws.cell(r, 2, r * 1.5); ws.cell(r, 3, f"row {r}")
    ws["D17"] = 21; ws["D18"] = "=D17*2"; ws["D19"] = "=SUM(A2:A20)"; ws["E2"] = "pipe|in|text"
    ws["E3"] = datetime.date(2026, 9, 9); ws["E4"] = True; ws["G2"] = "=1/0"
    ws.row_dimensions[4].hidden = True; ws.column_dimensions["F"].hidden = True
    img = os.path.join(tempfile.gettempdir(), "fx3.png"); open(img, "wb").write(png_bytes("gold")); ws.add_image(XLImage(img), "H2")
    st = wb.create_sheet("Settings"); st["C17"] = "threshold"; st["D17"] = 42
    for title in ("A B", "A_B"):
        s = wb.create_sheet(title); s["A1"] = title; s.add_image(XLImage(img), "B2")
    h = wb.create_sheet("Hidden"); h["A1"] = "secret"; h.sheet_state = "hidden"
    return wb

def workbook():
    wb = workbook_source()
    raw = os.path.join(tempfile.gettempdir(), "workbook-raw.xlsx"); wb.save(raw)
    out = tempfile.mkdtemp()
    subprocess.run(["soffice", "--headless", "--convert-to", "xlsx", "--outdir", out, raw], check=True, capture_output=True, timeout=180)
    conv = os.path.join(out, "workbook-raw.xlsx")
    # strip the cached <v> of D19 so one formula has no cached result
    target = os.path.join(HERE, "workbook.xlsx")
    with zipfile.ZipFile(conv) as zin, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                data = re.sub(rb'(<c r="D19"[^>]*>\s*<f[^>]*>[^<]*</f>)\s*<v>[^<]*</v>', rb"\1", data)
            zout.writestr(item, data)

def legacy_xls():
    import xlwt
    wb = xlwt.Workbook(); ws = wb.add_sheet("Legacy")
    ws.write_merge(0, 0, 0, 2, "Legacy Title")
    for r in range(1, 6):
        for c in range(3):
            ws.write(r, c, f"r{r}c{c}")
    ws.write(1, 3, xlwt.Formula("1/0"))
    ws.row(3).hidden = True; ws.col(1).hidden = True
    target = os.path.join(HERE, "legacy.xls")
    with tempfile.TemporaryDirectory() as rawdir, tempfile.TemporaryDirectory() as outdir:
        raw = os.path.join(rawdir, "legacy.xls")
        wb.save(raw)
        subprocess.run(["soffice", "--headless", "--convert-to", "xls", "--outdir", outdir, raw], check=True, capture_output=True, timeout=180)
        shutil.move(os.path.join(outdir, "legacy.xls"), target)

ZERO_EXT = re.compile(rb'<(\w+:)?ext cx="0" cy="0"\s*/>')

def patch_chartsheet_extents(src, dst):
    """openpyxl writes chartsheet drawings with a zero-size absoluteAnchor extent, which LibreOffice honors
    as an empty page. Rewrite the extent at the zip level; never soffice round-trip (LO drops chartsheet drawings)."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if re.fullmatch(r"xl/drawings/drawing\d+\.xml", item.filename):
                data = ZERO_EXT.sub(rb'<\1ext cx="9144000" cy="6858000"/>', data)
            zout.writestr(item, data)

def charts():
    import openpyxl, datetime
    from openpyxl.chart import BarChart, LineChart, Reference
    from openpyxl.drawing.image import Image as XLImage
    wb = openpyxl.Workbook()
    ws = wb.active; ws.title = "Data"
    ws.append(["Step", "North", "Double"])
    for r in range(2, 201):
        ws.cell(r, 1, r - 1); ws.cell(r, 2, round((r - 1) * 0.5, 1)); ws.cell(r, 3, f"=A{r}*2")
    line = LineChart(); line.title = "Data trend"; line.add_data(Reference(ws, min_col=2, min_row=1, max_row=200), titles_from_data=True); ws.add_chart(line, "E2")
    img = os.path.join(tempfile.gettempdir(), "fx4.png"); open(img, "wb").write(png_bytes("navy")); ws.add_image(XLImage(img), "E20")
    wb.create_sheet("Empty")
    aux = wb.create_sheet("Aux"); aux.sheet_state = "hidden"
    for r in range(1, 11):
        aux.cell(r, 1, r); aux.cell(r, 2, f"aux {r}")
    cs = wb.create_chartsheet("Trends"); ch = LineChart(); ch.title = "Synthetic trends"
    ch.add_data(Reference(ws, min_col=2, min_row=2, max_row=200)); cs.add_chart(ch)
    cs2 = wb.create_chartsheet("Bars"); bar = BarChart(); bar.title = "Bars"
    bar.add_data(Reference(ws, min_col=1, min_row=2, max_row=200)); cs2.add_chart(bar)
    wide = wb.create_sheet("Wide")
    wide.append([f"C{c}" for c in range(1, 81)])
    words = ["alpha", "beta", "gamma", "delta"]
    for r in range(2, 301):
        row = [r - 1, round((r - 1) / 7, 3), words[r % 4], datetime.date(2026, 1, 1) + datetime.timedelta(days=r)]
        row += [(r * c) % 97 for c in range(5, 81)]
        wide.append(row)
    raw = os.path.join(tempfile.gettempdir(), "charts-raw.xlsx"); wb.save(raw)
    patch_chartsheet_extents(raw, os.path.join(HERE, "charts.xlsx"))

def charts_zero_extent():
    import openpyxl
    from openpyxl.chart import LineChart, Reference
    wb = openpyxl.Workbook()
    ws = wb.active; ws.title = "Data"
    for r in range(1, 4):
        ws.cell(r, 1, r); ws.cell(r, 2, r * 2)
    cs = wb.create_chartsheet("Chart"); ch = LineChart(); ch.add_data(Reference(ws, min_col=2, min_row=1, max_row=3)); cs.add_chart(ch)
    wb.save(os.path.join(HERE, "charts-zero-extent.xlsx"))  # deliberately unpatched: exercises the degenerate-page guard

OCR_TEXT = "Hello OCR world 12345"

def text_png(text, w_pt=420, h_pt=80, dpi=200):
    doc = pymupdf.open(); page = doc.new_page(width=w_pt, height=h_pt)
    page.insert_text((12, h_pt / 2 + 8), text, fontsize=24)
    return page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY).tobytes("png")

def noise_png(seed, size=64):
    rnd = random.Random(seed); im = Image.new("RGB", (size, size))
    im.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(size * size)])
    buf = io.BytesIO(); im.save(buf, "PNG"); return buf.getvalue()

def scan_pdf():
    doc = pymupdf.open()
    doc.new_page().insert_image(pymupdf.Rect(36, 72, 576, 175), stream=text_png(OCR_TEXT))
    doc.new_page().insert_text((72, 72), "PAGE-2 has a text layer", fontsize=12)
    doc.save(os.path.join(HERE, "scan.pdf"))

def ocr_images():
    open(os.path.join(HERE, "ocr.png"), "wb").write(text_png(OCR_TEXT))
    Image.new("L", (200, 10), 255).save(os.path.join(HERE, "strip.png"))  # shorter side 10 px < 16

def html_fixtures():
    d = os.path.join(HERE, "html"); os.makedirs(os.path.join(d, "page_files"), exist_ok=True)
    open(os.path.join(d, "page_files", "fig.png"), "wb").write(png_bytes("green"))
    data_uri = "data:image/png;base64," + base64.b64encode(png_bytes("yellow")).decode()
    prose = "".join(f"<p>Paragraph {i}: Zolw notes - mulch keeps soil moist and roots cool through summer.</p>" for i in range(6))
    page = ("<!doctype html><html><head><title>Garden notes</title><style>p { color: red }</style><script>var x = 1;</script></head><body>"
            "<nav>NAV-TEXT <a href=\"/\">home</a></nav><article><h1>Garden notes</h1><p>\u017b\u00f3\u0142w and mulch.</p>" + prose +
            "<table><thead><tr><th>Plant</th><th>Note</th></tr></thead><tbody><tr><td>Rose | red</td><td>Sun</td></tr></tbody></table>"
            "<pre><code class=\"language-py\">print(\"hi\")</code></pre><dl><dt>Mulch</dt><dd>A protective layer.</dd></dl>"
            f"<p><img src=\"page_files/fig.png\" alt=\"local figure\"> <img src=\"{data_uri}\" alt=\"inline figure\"> "
            "<img src=\"https://example.com/remote.png\" alt=\"remote figure\"> <img src=\"page_files/missing.png\" alt=\"missing figure\"></p>"
            "</article><footer>FOOTER-TEXT contact us</footer></body></html>")
    open(os.path.join(d, "page.html"), "w", encoding="utf-8").write(page)  # UTF-8 without <meta charset>
    open(os.path.join(d, "title-only.html"), "w", encoding="utf-8").write("<html><head><title>Only a title</title></head><body><p>Body without a heading.</p></body></html>")
    open(os.path.join(d, "pagebreak.html"), "w", encoding="utf-8").write("<html><body><p>before</p><hr class=\"pagebreak\"><p>after</p></body></html>")
    cp = "<html><head><meta charset=\"windows-1250\"><title>Kodowanie</title></head><body><p>Za\u017c\u00f3\u0142\u0107 g\u0119\u015bl\u0105 ja\u017a\u0144</p></body></html>"
    open(os.path.join(d, "cp1250.html"), "wb").write(cp.encode("cp1250"))

def mixed_images_pdf():
    doc = pymupdf.open(); page = doc.new_page()
    page.insert_text((72, 72), "PAGE-1 has a text layer and two pictures", fontsize=12)
    page.insert_image(pymupdf.Rect(72, 120, 272, 270), stream=png_bytes("red"))
    page.insert_image(pymupdf.Rect(300, 120, 500, 270), stream=png_bytes("blue"))
    doc.save(os.path.join(HERE, "mixed-images.pdf"))

def jpeg_bytes(size):
    im = Image.radial_gradient("L").resize(size).convert("RGB")
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=85); return buf.getvalue()

def page_image_pdfs():
    full = jpeg_bytes((2000, 2800))
    def full_page(path, pages=1, after=None, **kw):
        doc = pymupdf.open()
        for _ in range(pages):
            page = doc.new_page(width=500, height=700)
            xref = page.insert_image(page.rect, stream=full, **kw)
            doc.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
            if after: after(page)
        doc.save(os.path.join(HERE, path))
    full_page("single-image-page.pdf")
    full_page("annotated-scan.pdf", after=lambda page: page.add_text_annot((60, 50), "Check this"))
    full_page("textless-3.pdf", pages=3)
    full_page("overlay-page.pdf", after=lambda page: page.draw_line((0, 0), (500, 700), color=(1, 0, 0), width=4))
    full_page("rotated-page.pdf", rotate=180)
    doc = pymupdf.open(); doc.new_page().insert_image(pymupdf.Rect(72, 72, 172, 172), stream=jpeg_bytes((200, 200)))
    doc.save(os.path.join(HERE, "logo-page.pdf"))
    doc = pymupdf.open(); page = doc.new_page(width=1398, height=6874)
    page.insert_image(pymupdf.Rect(100, 100, 1298, 3300), stream=png_bytes("red")); page.insert_image(pymupdf.Rect(100, 3500, 1298, 6774), stream=png_bytes("blue"))
    doc.save(os.path.join(HERE, "tall-page.pdf"))
    for name, annotate in (("annotated.pdf", True), ("annotated-clean.pdf", False)):
        doc = pymupdf.open(); page = doc.new_page()
        page.insert_text((72, 72), "Disable the breaker before servicing the panel.", fontsize=14)
        if annotate:
            page.add_text_annot((72, 60), "Check this step")
        doc.save(os.path.join(HERE, name))

def _lvl(i, fmt, text, start=1, restart=None, pstyle=None):
    extra = (f'<w:lvlRestart w:val="{restart}"/>' if restart is not None else "") + (f'<w:pStyle w:val="{pstyle}"/>' if pstyle else "")
    return f'<w:lvl w:ilvl="{i}"><w:start w:val="{start}"/><w:numFmt w:val="{fmt}"/>{extra}<w:lvlText w:val="{text}"/></w:lvl>'

def _numbered(d, abstracts, nums):
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls
    numbering = d.part.numbering_part.element
    for c in list(numbering): numbering.remove(c)
    for aid, levels in abstracts.items():
        numbering.append(parse_xml(f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{aid}">' + "".join(levels) + "</w:abstractNum>"))
    for nid, (aid, override) in nums.items():
        numbering.append(parse_xml(f'<w:num {nsdecls("w")} w:numId="{nid}"><w:abstractNumId w:val="{aid}"/>{override}</w:num>'))
    def numbered(text, nid, ilvl, style=None):
        p = d.add_paragraph(text, style=style) if style else d.add_paragraph(text)
        p._p.get_or_add_pPr().append(parse_xml(f'<w:numPr {nsdecls("w")}><w:ilvl w:val="{ilvl}"/><w:numId w:val="{nid}"/></w:numPr>'))
    return numbered

def numbered_docx():
    from docx import Document
    d = Document()
    abstracts = {
        "0": [_lvl(0, "decimal", "%1."), _lvl(1, "decimal", "%1.%2"), _lvl(2, "decimal", "%1.%2.%3")],
        "1": [_lvl(0, "decimal", "%1.", pstyle="Heading1"), _lvl(1, "decimal", "%1.%2", pstyle="Heading2")],
        "2": [_lvl(0, "decimal", "%1."), _lvl(1, "decimal", "%1.%2", restart=0)],
        "3": [_lvl(0, "bullet", "\u2022")],
    }
    nums = {"1": ("0", ""), "2": ("0", '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>'), "3": ("1", ""), "4": ("2", ""), "5": ("3", "")}
    numbered = _numbered(d, abstracts, nums)
    d.add_heading("Introduction", 1); d.add_heading("Scope", 2); d.add_heading("Design", 1); d.add_heading("Interfaces", 2)
    d.add_paragraph("See 3.2.1 for trip settings.")
    for text, lvl in [("Alpha", 0), ("Alpha one", 1), ("Beta", 0), ("Beta one", 1), ("Beta two", 1), ("Gamma", 0), ("Gamma one", 1), ("Gamma two", 1), ("Trip settings", 2)]:
        numbered(text, "1", lvl)
    numbered("Delta restarts", "2", 0)
    for text, lvl in [("Ex", 0), ("Ex sub", 1), ("Why", 0), ("Why sub", 1)]:
        numbered(text, "4", lvl)
    numbered("Bullet item", "5", 0)
    d.save(os.path.join(HERE, "numbered.docx"))
    d = Document(); numbered = _numbered(d, {"0": [_lvl(0, "decimal", "%1.")]}, {"1": ("0", "")})
    numbered("Points nowhere", "9", 0); d.add_paragraph("plain"); d.save(os.path.join(HERE, "missing-num.docx"))
    d = Document(); numbered = _numbered(d, {"0": [_lvl(0, "chicago", "%1.")]}, {"1": ("0", "")})
    numbered("Chicago style", "1", 0); d.save(os.path.join(HERE, "unknown-numfmt.docx"))

def macros_xlsm():
    workbook_source().save(os.path.join(HERE, "macros.xlsm"))

def tall_xlsx():
    import openpyxl
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Tall"
    for r in range(1, 151): ws.append([r, f"item {r}", r * 1.5])
    wide = wb.create_sheet("Wide")
    for r in range(1, 121): wide.append([f"r{r}c{c}" for c in range(1, 61)])
    wb.create_sheet("Small").append(["a", "b"])
    wb.save(os.path.join(HERE, "tall.xlsx"))

def tall_xls():
    import xlwt
    wb = xlwt.Workbook(); ws = wb.add_sheet("Tall")
    for r in range(150):
        for c in range(3):
            ws.write(r, c, f"r{r + 1}c{c + 1}")
    wb.save(os.path.join(HERE, "tall.xls"))

def sample_eml():
    from email.message import EmailMessage
    m = EmailMessage()
    m["From"] = "Ann Sender <ann@example.com>"; m["To"] = "Bob Reader <bob@example.com>"; m["Cc"] = "cc@example.com"
    m["Date"] = "Mon, 02 Mar 2026 10:00:00 +0100"; m["Subject"] = "Fixture: relay | settings"
    cid = "<fig1@example.com>"
    m.set_content("Plain text alternative with TX-101.")
    m.add_alternative(f'<html><body><h1>Relay settings</h1><p>TX-101 trips at <b>85%</b>.</p><img src="cid:{cid[1:-1]}" alt="figure"></body></html>', subtype="html")
    m.get_payload()[1].add_related(png_bytes("green"), maintype="image", subtype="png", cid=cid, disposition="inline")
    m.add_attachment(b"notes body\n", maintype="text", subtype="plain", filename="notes.txt")
    m.add_attachment(b"evil\n", maintype="text", subtype="plain", filename="../evil.txt")
    for i, part in enumerate((part for part in m.walk() if part.is_multipart()), 1):
        part.set_boundary(f"==b{i}==")
    open(os.path.join(HERE, "sample.eml"), "wb").write(m.as_bytes())

def short_text_ocr_pdf():
    doc = pymupdf.open()
    page = doc.new_page()
    body = " ".join(f"Line {i}: the quick brown fox jumps over the lazy dog." for i in range(1, 7))
    page.insert_textbox(pymupdf.Rect(72, 72, 540, 720), body, fontsize=11)
    scan = doc.new_page(width=612, height=792)
    scan.insert_image(scan.rect, stream=text_png(OCR_TEXT, w_pt=612, h_pt=792))
    scan.insert_text((72, 60), "3", fontsize=12)
    doc.save(os.path.join(HERE, "short-text-ocr.pdf"), deflate=True, garbage=4)

def rotated_pdf():
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), "NORTH", fontsize=12)  # unrotated coordinates: rotation is set afterwards
    page.set_rotation(90)
    doc.save(os.path.join(HERE, "rotated.pdf"))

def blank_pdf():
    doc = pymupdf.open()
    doc.new_page()
    doc.save(os.path.join(HERE, "blank.pdf"))

def pre_ocr_pdf():
    """scan.pdf page 1 with a Tesseract text layer baked in (GlyphLessFont spans).
    Needs Tesseract; the committed file is reused otherwise."""
    if not shutil.which("tesseract"):
        print("tesseract not on PATH; pre-ocr.pdf not regenerated")
        return
    import pymupdf4llm
    doc = pymupdf.open()
    doc.insert_pdf(pymupdf.open(os.path.join(HERE, "scan.pdf")), from_page=0, to_page=0)
    pymupdf4llm.to_markdown(doc, pages=[0], write_images=False, use_ocr=True, force_ocr=True, ocr_language="eng", page_separators=False)
    doc.save(os.path.join(HERE, "pre-ocr.pdf"))

def legacy_doc():
    if not shutil.which("soffice"):
        print("soffice not on PATH; sample.doc not regenerated"); return
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(["soffice", "--headless", "--convert-to", "doc", "--outdir", out, os.path.join(HERE, "headings.docx")], check=True, stdout=subprocess.DEVNULL)
        shutil.copyfile(os.path.join(out, "headings.doc"), os.path.join(HERE, "sample.doc"))

GENERATORS = {"rotated_pdf": rotated_pdf, "blank_pdf": blank_pdf, "pre_ocr_pdf": pre_ocr_pdf, "short_text_ocr_pdf": short_text_ocr_pdf, "scan_pdf": scan_pdf, "ocr_images": ocr_images, "html_fixtures": html_fixtures, "multipage_pdf": multipage_pdf, "shared_resources_pdf": shared_resources_pdf, "office": office, "headings_docx": headings_docx, "bold_headings_docx": bold_headings_docx, "workbook": workbook, "legacy_xls": legacy_xls, "charts": charts, "charts_zero_extent": charts_zero_extent, "mixed_images_pdf": mixed_images_pdf, "page_image_pdfs": page_image_pdfs, "numbered_docx": numbered_docx, "macros_xlsm": macros_xlsm, "tall_xlsx": tall_xlsx, "tall_xls": tall_xls, "sample_eml": sample_eml, "legacy_doc": legacy_doc}

OPT_IN = {"pre_ocr_pdf"}

if __name__ == "__main__":
    import sys
    for name in sys.argv[1:] or [name for name in GENERATORS if name not in OPT_IN]:
        GENERATORS[name]()
    print("fixtures written to", HERE)
