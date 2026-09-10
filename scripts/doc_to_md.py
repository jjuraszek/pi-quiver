#!/usr/bin/env python3
"""doc_to_md child. argv[1] = mode (info | pdf-primary | pdf-fallback | xlsx); options JSON on stdin;
one JSON result on stdout. Exit 0 ok, 1 conversion failure (traceback on stderr), 3 user error
({"error", "pageCount"} on stdout). Library chatter is redirected to stderr so stdout is the result only.
Imports `pymupdf` / `pymupdf4llm` (never the deprecated `fitz` alias)."""
import contextlib
import json
import os
import re
import shutil
import sys
import tempfile
import traceback
import warnings

SEP = "\n\n--- end of page.page_number={n} ---\n\n"
DEGRADED_NOTE = "degraded: PyMuPDF text extraction - layout/tables not preserved"
MARKDOWN_IMAGE_RE = re.compile(r"(!\[[^\]]*\]\(\s*)(?:<([^>]+)>|([^)]*?))(\s*\))")
HTML_IMAGE_RE = re.compile(
    r"(<img\b[^>]*?\bsrc\s*=\s*)(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+))", re.IGNORECASE
)


def image_source_map(source, target, filename):
    real = os.path.realpath(source)
    return {source: target, source.replace("\\", "/"): target,
            real: target, real.replace("\\", "/"): target, filename: target}


def rewrite_image_destinations(md, sources):
    def markdown(match):
        dest = match.group(2) if match.group(2) is not None else match.group(3)
        target = sources.get(dest)
        if target is None:
            return match.group(0)
        if match.group(2) is not None:
            return f"{match.group(1)}<{target}>{match.group(4)}"
        return f"{match.group(1)}{target}{match.group(4)}"

    def html(match):
        dest = next(value for value in match.groups()[1:] if value is not None)
        target = sources.get(dest)
        if target is None:
            return match.group(0)
        quote = '"' if match.group(2) is not None else "'" if match.group(3) is not None else ""
        return f"{match.group(1)}{quote}{target}{quote}"

    return HTML_IMAGE_RE.sub(html, MARKDOWN_IMAGE_RE.sub(markdown, md))


def user_error(msg, page_count=None):
    json.dump({"error": msg, **({"pageCount": page_count} if page_count is not None else {})}, sys.stdout)
    return 3


def check_pages(pages, page_count):
    if pages is None:
        return list(range(1, page_count + 1))
    bad = [p for p in pages if p < 1 or p > page_count]
    if bad:
        raise UserError(f"pages out of range: {', '.join(map(str, bad))} (document has {page_count} pages)", page_count)
    return pages


class UserError(Exception):
    def __init__(self, msg, page_count=None):
        super().__init__(msg)
        self.page_count = page_count


def open_pdf(path):
    import pymupdf
    doc = pymupdf.open(path)
    if doc.needs_pass:
        raise UserError("Password-protected PDF", doc.page_count)
    return doc


def page_dir(staging, n):
    d = os.path.join(staging, f"p{n}")
    os.makedirs(d, exist_ok=True)
    return d


def mark_done(d):
    open(os.path.join(d, ".done"), "w").close()


def mode_info(o):
    import pymupdf  # noqa: F401
    doc = open_pdf(o["path"])
    meta = {k: v for k, v in (doc.metadata or {}).items() if v}
    toc = [[lvl, title, page] for lvl, title, page in doc.get_toc()]
    return {"pageCount": doc.page_count, "metadata": meta, "toc": toc}


def mode_pdf_primary(o):
    import pymupdf4llm
    doc = open_pdf(o["path"])
    pages = check_pages(o.get("pages"), doc.page_count)
    staging, out, empty, failed, notes = o["stagingDir"], [], [], [], []
    for n in pages:
        d = page_dir(staging, n)
        try:
            # Space-free temp dir: pymupdf4llm's md_path() mangles paths containing spaces/parens.
            with tempfile.TemporaryDirectory() as tmp:
                md = pymupdf4llm.to_markdown(doc, pages=[n - 1], write_images=True, image_path=tmp,
                                               image_format=o["imageFormat"], dpi=o["imageDpi"],
                                               use_ocr=False, page_separators=False)
                sources = {}
                for i, f in enumerate(sorted(os.listdir(tmp)), 1):
                    dest = f"img{i}{os.path.splitext(f)[1].lower()}"
                    source = os.path.join(tmp, f)
                    target = f"p{n}/{dest}"
                    sources.update(image_source_map(source, target, f))
                    os.replace(source, os.path.join(d, dest))
                md = rewrite_image_destinations(md, sources)
            if not md.strip():
                empty.append(n)
            out.append(md.rstrip())
            mark_done(d)
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(d, ignore_errors=True)
            failed.append({"page": n, "error": f"{type(exc).__name__}: {exc}"[:300]})
            empty.append(n)
            out.append("")
        out.append(SEP.format(n=n).strip("\n"))
    if failed and len(failed) == len(pages):
        raise RuntimeError("every selected page failed: " + failed[0]["error"])
    return {"markdown": "\n\n".join(out) + "\n", "pages": pages, "pageCount": doc.page_count,
            "emptyPages": empty, "failedPages": failed, "notes": notes}


def mode_pdf_fallback(o):
    import pymupdf
    doc = open_pdf(o["path"])
    pages = check_pages(o.get("pages"), doc.page_count)
    keep = {int(k): v for k, v in (o.get("keepPages") or {}).items()}
    staging, out, empty, failed = o["stagingDir"], [], [], []
    for n in pages:
        links = [f"![](images/{f})" for f in keep.get(n, [])]
        text = ""
        try:
            page = doc[n - 1]
            text = page.get_text("text").strip()
            if n not in keep:
                d = page_dir(staging, n)
                i = 0
                for info in page.get_image_info(xrefs=True):
                    i += 1
                    xref = info.get("xref", 0)
                    if xref > 0:
                        img = doc.extract_image(xref)
                        name = f"img{i}.{img['ext'].lower()}"
                        with open(os.path.join(d, name), "wb") as fh:
                            fh.write(img["image"])
                    else:
                        name = f"img{i}.{o['imageFormat']}"
                        page.get_pixmap(clip=pymupdf.Rect(info["bbox"]), dpi=o["imageDpi"]).save(os.path.join(d, name))
                    links.append(f"![](p{n}/{name})")
                mark_done(d)
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(os.path.join(staging, f"p{n}"), ignore_errors=True)
            text = ""
            links = [f"![](images/{f})" for f in keep.get(n, [])]
            failed.append({"page": n, "error": f"{type(exc).__name__}: {exc}"[:300]})
        if not text:
            empty.append(n)
        out.append("\n\n".join(x for x in [text, "\n".join(links)] if x))
        out.append(SEP.format(n=n).strip("\n"))
    if failed and len(failed) == len(pages):
        raise RuntimeError("every selected page failed: " + failed[0]["error"])
    return {"markdown": "\n\n".join(out) + "\n", "pages": pages, "pageCount": doc.page_count,
            "emptyPages": empty, "failedPages": failed, "notes": [DEGRADED_NOTE]}


def esc(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return repr(v)
    import datetime
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    return str(v).replace("\\", "\\\\").replace("|", "\\|").replace("\r\n", "<br>").replace("\n", "<br>")


def col_letter(i):
    from openpyxl.utils import get_column_letter
    return get_column_letter(i)


def mode_xlsx(o):
    path, staging, budget = o["path"], o["stagingDir"], o["maxCellsPerSheet"]
    notes, images = [], []
    if path.lower().endswith(".xls"):
        return mode_xls(o)
    import openpyxl
    wb_f = openpyxl.load_workbook(path, data_only=False)
    wb_v = openpyxl.load_workbook(path, data_only=True)
    inventory, sections = [], []
    for idx, ws in enumerate(wb_f.worksheets, 1):
        wv = wb_v[ws.title]
        rows, cols = ws.max_row, ws.max_column
        r_lim, c_lim, truncated = rows, cols, False
        if rows * cols > budget:
            truncated = True
            r_lim = max(1, budget // cols)
            if r_lim == 1 and cols > budget:
                c_lim = budget
        hidden = ws.sheet_state != "visible"
        inventory.append(f"- {idx}. {ws.title}{' hidden' if hidden else ''} - {rows} x {cols}{' truncated' if truncated else ''}")
        lines = [f"## {ws.title}"]
        if hidden:
            lines.append("Hidden sheet")
        merged = [str(r) for r in ws.merged_cells.ranges]
        if merged:
            lines.append("Merged: " + ", ".join(merged))
        hr = [str(r) for r, dim in ws.row_dimensions.items() if dim.hidden]
        if hr:
            lines.append("Hidden rows: " + ",".join(hr))
        hc = []
        for dim in ws.column_dimensions.values():
            if dim.hidden:
                hc += [col_letter(i) for i in range(dim.min, dim.max + 1)]
        if hc:
            lines.append("Hidden cols: " + ",".join(hc))
        if truncated:
            lines.append(f"Truncated: showing rows 1-{r_lim} of {rows}, cols A-{col_letter(c_lim)} of {cols}")
        continuation = set()
        for rng in ws.merged_cells.ranges:
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    if (r, c) != (rng.min_row, rng.min_col):
                        continuation.add((r, c))
        header = "| | " + " | ".join(col_letter(c) for c in range(1, c_lim + 1)) + " |"
        lines += [header, "|---|" + "---|" * c_lim]
        for r in range(1, r_lim + 1):
            cells = []
            for c in range(1, c_lim + 1):
                if (r, c) in continuation:
                    cells.append("")
                    continue
                f, v = ws.cell(r, c).value, wv.cell(r, c).value
                if isinstance(f, str) and f.startswith("="):
                    cells.append(f"{esc(v) if v is not None else '(no cached result)'} ({esc(f)})")
                else:
                    cells.append(esc(f))
            lines.append(f"| {r} | " + " | ".join(cells) + " |")
        for i, img in enumerate(getattr(ws, "_images", []), 1):
            try:
                fmt = (getattr(img, "format", None) or "png").lower()
                name = f"s{idx}-{i}.{fmt}"
                data = img._data() if callable(getattr(img, "_data", None)) else img.ref.getvalue()
                with open(os.path.join(staging, name), "wb") as fh:
                    fh.write(data)
                images.append({"sheetIndex": idx, "file": name})
                lines.append(f"![]({name})")
            except Exception as exc:  # noqa: BLE001
                notes.append(f"sheet {ws.title}: image {i} not extracted ({type(exc).__name__})")
        if not hasattr(ws, "_images"):
            notes.append("Images: unavailable")
        sections.append("\n".join(lines))
    md = "## Sheets\n" + "\n".join(inventory) + "\n\n" + "\n\n".join(sections) + "\n"
    return {"markdown": md, "images": images, "notes": notes}


def mode_xls(o):
    import xlrd
    path, budget = o["path"], o["maxCellsPerSheet"]
    book = xlrd.open_workbook(path, formatting_info=True, logfile=sys.stderr)
    inventory, sections = [], []
    for idx in range(book.nsheets):
        sh = book.sheet_by_index(idx)
        rows, cols = sh.nrows, sh.ncols
        r_lim, c_lim, truncated = rows, cols, False
        if rows * cols > budget:
            truncated = True
            r_lim = max(1, budget // max(cols, 1))
            if r_lim == 1 and cols > budget:
                c_lim = budget
        hidden = sh.visibility != 0
        inventory.append(f"- {idx + 1}. {sh.name}{' hidden' if hidden else ''} - {rows} x {cols}{' truncated' if truncated else ''}")
        lines = [f"## {sh.name}", "Formulas: unavailable (.xls via xlrd); Images: unavailable"]
        if hidden:
            lines.append("Hidden sheet")
        merged = [f"{col_letter(c0 + 1)}{r0 + 1}:{col_letter(c1)}{r1}" for r0, r1, c0, c1 in sh.merged_cells]
        if merged:
            lines.append("Merged: " + ", ".join(merged))
        hr = [str(r + 1) for r, info in sh.rowinfo_map.items() if info.hidden]
        if hr:
            lines.append("Hidden rows: " + ",".join(hr))
        hc = [col_letter(c + 1) for c, info in sh.colinfo_map.items() if info.hidden]
        if hc:
            lines.append("Hidden cols: " + ",".join(hc))
        if truncated:
            lines.append(f"Truncated: showing rows 1-{r_lim} of {rows}, cols A-{col_letter(c_lim)} of {cols}")
        continuation = {(r, c) for r0, r1, c0, c1 in sh.merged_cells for r in range(r0, r1) for c in range(c0, c1) if (r, c) != (r0, c0)}
        lines += ["| | " + " | ".join(col_letter(c + 1) for c in range(c_lim)) + " |", "|---|" + "---|" * c_lim]
        for r in range(r_lim):
            cells = []
            for c in range(c_lim):
                if (r, c) in continuation:
                    cells.append("")
                    continue
                cell = sh.cell(r, c)
                v = cell.value
                if cell.ctype == xlrd.XL_CELL_DATE:
                    v = xlrd.xldate_as_datetime(v, book.datemode).isoformat()
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    v = bool(v)
                elif cell.ctype == xlrd.XL_CELL_ERROR:
                    v = xlrd.error_text_from_code.get(int(v), f"#ERR{int(v)}")
                elif cell.ctype == xlrd.XL_CELL_EMPTY:
                    v = None
                cells.append(esc(v))
            lines.append(f"| {r + 1} | " + " | ".join(cells) + " |")
        sections.append("\n".join(lines))
    md = "## Sheets\n" + "\n".join(inventory) + "\n\n" + "\n\n".join(sections) + "\n"
    return {"markdown": md, "images": [], "notes": []}


def mode_info_excel(o):
    path = o["path"]
    sheets = []
    if path.lower().endswith(".xls"):
        import xlrd
        book = xlrd.open_workbook(path, formatting_info=True, logfile=sys.stderr)
        for idx in range(book.nsheets):
            sh = book.sheet_by_index(idx)
            sheets.append({"name": sh.name, "index": idx + 1, "hidden": sh.visibility != 0, "rows": sh.nrows, "cols": sh.ncols,
                           "hiddenRows": sum(1 for i in sh.rowinfo_map.values() if i.hidden),
                           "hiddenCols": sum(1 for i in sh.colinfo_map.values() if i.hidden)})
    else:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        for idx, ws in enumerate(wb.worksheets, 1):
            hc = sum(d.max - d.min + 1 for d in ws.column_dimensions.values() if d.hidden)
            sheets.append({"name": ws.title, "index": idx, "hidden": ws.sheet_state != "visible", "rows": ws.max_row, "cols": ws.max_column,
                           "hiddenRows": sum(1 for d in ws.row_dimensions.values() if d.hidden), "hiddenCols": hc})
    return {"sheets": sheets}


MODES = {"info": None, "pdf-primary": mode_pdf_primary, "pdf-fallback": mode_pdf_fallback, "xlsx": mode_xlsx}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in MODES:
        print("usage: doc_to_md.py <info|pdf-primary|pdf-fallback|xlsx>  (options JSON on stdin)", file=sys.stderr)
        return 1
    mode = sys.argv[1]
    o = json.loads(sys.stdin.read() or "{}")
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with contextlib.redirect_stdout(sys.stderr):
                if mode == "info":
                    result = mode_info_excel(o) if o["path"].lower().endswith((".xlsx", ".xls")) else mode_info(o)
                else:
                    result = MODES[mode](o)
        if "notes" in result:
            result["notes"] += sorted({str(w.message) for w in caught})
    except UserError as ue:
        return user_error(str(ue), ue.page_count)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return 1
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
