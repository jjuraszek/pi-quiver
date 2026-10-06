#!/usr/bin/env python3
"""doc_to_md child. argv[1] = mode (info | pdf-primary | pdf-fallback | xlsx | render-pages | docx | html | image | email); options JSON on stdin;
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

sys.path.insert(0, os.path.dirname(__file__))

SEP = "\n\n--- end of page.page_number={n} ---\n\n"
PAGEBREAK_SENTINEL = "\x00PAGEBREAK\x00"
DOCX_NO_BREAKS = "--pages does not apply to this DOCX: it has no explicit page breaks; read the .md by Outline line offsets instead"
DOCX_STYLE_MAP = "\n".join(["br[type='page'] => hr.pagebreak:fresh"] + [f"p[style-name='Heading {n}'] => h6:fresh" for n in (7, 8, 9)] + [f"p.Heading{n} => h6:fresh" for n in (7, 8, 9)])
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
IMG_PLACEHOLDER_RE = re.compile(r"__docximg(\d+)__")
CODE_LANG_RE = re.compile(r"^(?:language|lang)-([\w+#.-]+)$")
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


def check_pages(pages, page_count, noun="pages"):
    if pages is None:
        return list(range(1, page_count + 1))
    bad = [p for p in pages if p < 1 or p > page_count]
    if bad:
        raise UserError(f"pages out of range: {', '.join(map(str, bad))} (document has {page_count} {noun})", page_count)
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


def mark_done(d, meta=None):
    with open(os.path.join(d, ".done"), "w", encoding="utf-8") as fh:
        json.dump(meta or {}, fh)


OCR_SENTINEL = "\x00OCR {}\x00"
MIN_OCR_SIDE_PX = 16
OCR_BUDGET_RESERVE_MS, OCR_EST_INITIAL_MS, PAGE_EST_INITIAL_MS = 5000, 4000, 250


def new_ocr(lang):
    return {"status": "off", "lang": lang, "textless": [], "pages": [], "noText": [], "ocrFailed": [],
            "budgetStopped": [], "ceilingStopped": [], "reason": None, "tesseract": None}


def apply_status(info, st):
    info["status"] = "ran" if st["status"] == "ready" else st["status"]
    info["reason"], info["tesseract"] = st["reason"], st["tesseract"]


def ocr_status(ocr, lang):
    import pymupdf
    try:
        td = pymupdf.get_tessdata()
    except Exception:  # noqa: BLE001
        td = None
    missing = None
    if not td or not os.path.isdir(td):
        missing = "Tesseract language data not found"
    else:
        for part in lang.split("+"):
            if not os.path.isfile(os.path.join(td, f"{part}.traineddata")):
                missing = f"language data for {part} not installed"
                break
    if missing is None:
        # Repeated library lookups avoid spawning tesseract when the directory is exported.
        os.environ["TESSDATA_PREFIX"] = td
    if not ocr:
        return {"status": "off", "reason": None, "tesseract": missing is None}
    if missing:
        return {"status": "unavailable", "reason": missing, "tesseract": None}
    return {"status": "ready", "reason": None, "tesseract": None}


def ocr_block(target, text):
    quoted = "\n".join(f"> {line}" if line.strip() else ">" for line in text.splitlines())
    return f"{OCR_SENTINEL.format(target)}\n>\n{quoted}"


def ocr_admit(elapsed_ms, est_ocr_ms, remaining, est_page_ms, budget_ms):
    return elapsed_ms + est_ocr_ms + remaining * est_page_ms + OCR_BUDGET_RESERVE_MS <= budget_ms


def clamped_dpi(w, h, dpi):
    import math
    if w < MIN_PAGE_PT or h < MIN_PAGE_PT:
        return None
    eff = min(dpi, math.floor(math.sqrt(MAX_RENDER_PX / (w * h / 72 ** 2))))
    return eff if eff >= MIN_RENDER_DPI else None


RASTER_BUDGET_S, OCR_JOB_BUDGET_S, OCR_DPI = 20, 30, 300
RASTER_SPAWN_BUDGET_S = 30
MIN_OCR_JOB_S = 1
NATIVE_MIN_COVERAGE, NATIVE_MAX_COVERAGE = 0.9, 1.1
NATIVE_EXTS = ("png", "jpeg", "jpg")
JOB_VERB = {"native": "render", "render": "render", "images": "render", "ocr": "OCR"}
RASTER_INLINE = False  # tests only: run raster jobs in-process so monkeypatches reach them


class RasterError(Exception):
    """A raster job did not complete; str(exc) is the failedPages message."""


class RasterUnavailable(Exception):
    pass


def raster_budget(default):
    return float(os.environ.get("DOC_TO_MD_RASTER_BUDGET_S", default))


def clamp_note(n, eff, requested):
    return f"Page {n} rendered at {eff} dpi (requested {requested}; {MAX_RENDER_PX // 1_000_000} Mpx ceiling)"


def native_page_image(doc, page, target_dir, allow_annots=False):
    """One full-page, unrotated, unmasked PNG/JPEG stream with no vector overlay -> written untouched as page.<ext>."""
    import pymupdf
    if not allow_annots and (page.first_annot is not None or page.first_widget is not None):
        return None
    infos = page.get_image_info(xrefs=True)
    if len(infos) != 1 or infos[0].get("xref", 0) <= 0 or page.rotation != 0:
        return None
    drawings = page.get_drawings()
    if allow_annots:
        # MuPDF includes appearance streams, clipped to annotation/widget rectangles.
        annot_rects = [a.rect + (-1, -1, 1, 1) for items in (page.annots(), page.widgets()) for a in items]
        drawings = [drawing for drawing in drawings if not any(drawing["rect"] in rect for rect in annot_rects)]
    if drawings:
        return None
    info = infos[0]
    a, b, c, d = info["transform"][:4]
    if b != 0 or c != 0 or a <= 0 or d <= 0:
        return None
    area, bbox = page.rect.get_area(), pymupdf.Rect(info["bbox"])
    if area <= 0 or (bbox & page.rect).get_area() / area < NATIVE_MIN_COVERAGE or bbox.get_area() / area > NATIVE_MAX_COVERAGE:
        return None
    img = doc.extract_image(info["xref"])
    ext, cs = img["ext"].lower(), img.get("cs-name")
    plain = cs in ("DeviceRGB", "DeviceGray") or (cs == "DeviceCMYK" and ext in ("jpeg", "jpg"))
    if img.get("smask", 0) or ext not in NATIVE_EXTS or not img["image"] or not plain:
        return None
    name = f"page.{ext}"
    with open(os.path.join(target_dir, name), "wb") as fh:
        fh.write(img["image"])
    return {"file": name, "width": img["width"], "height": img["height"]}


def run_raster_job(doc, job):
    import time
    import pymupdf
    n, kind = job["page"], job["kind"]
    try:
        if os.environ.get("DOC_TO_MD_RASTER_STALL_PAGE") in (str(n), f"{kind}:{n}"):  # tests only: a wedged page
            time.sleep(3600)
        if os.environ.get("DOC_TO_MD_RASTER_CRASH_PAGE") == str(n):  # tests only: partial output, stdout chatter, hard exit
            if kind == "render":
                with open(job["target"], "wb") as fh:
                    fh.write(b"\x89PNG partial")
            print("raster worker crash hook", flush=True)
            os._exit(1)
        page = doc[n - 1]
        if kind == "native":
            r = native_page_image(doc, page, job["target"], job.get("allowAnnots", False))
            return {"ok": True, "eligible": r is not None, **(r or {})}
        if kind == "render":
            kw = {"dpi": job["dpi"], "annots": job["annots"]}
            if job.get("clip") is not None:
                kw["clip"] = pymupdf.Rect(job["clip"])
            pix = page.get_pixmap(**kw)
            pix.save(job["target"])
            return {"ok": True, "width": pix.width, "height": pix.height}
        if kind == "images":
            files = []
            for i, image in enumerate(page.get_image_info(xrefs=True), 1):
                xref = image.get("xref", 0)
                if xref > 0:
                    img = doc.extract_image(xref)
                    name = f"img{i}.{img['ext'].lower()}"
                    with open(os.path.join(job["target"], name), "wb") as fh:
                        fh.write(img["image"])
                else:
                    if job["dpi"] is None:
                        continue
                    name = f"img{i}.{job['format']}"
                    pix = page.get_pixmap(clip=pymupdf.Rect(image["bbox"]), dpi=job["dpi"], annots=job["annots"])
                    pix.save(os.path.join(job["target"], name))
                files.append(name)
            return {"ok": True, "files": files}
        import pymupdf4llm
        md = pymupdf4llm.to_markdown(doc, pages=[n - 1], write_images=False, page_separators=False, use_ocr=True, force_ocr=True,
                                     ocr_language=job["lang"], ocr_dpi=job["ocrDpi"])
        result = {"ok": True, "markdown": md}
        if job.get("wordsSnapshot"):
            # OCR mutates only the worker's document; carry that text layer back for parent-side word extraction.
            try:
                snapshot = pymupdf.open()
                snapshot.insert_pdf(doc, from_page=n - 1, to_page=n - 1)
                snapshot.save(job["wordsSnapshot"])
                snapshot.close()
            except Exception as exc:  # noqa: BLE001 - geometry never changes the OCR outcome
                result["wordsSnapshotError"] = words_error(exc)
        return result
    except Exception as exc:  # noqa: BLE001 - the parent decides what a failed job costs
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}


def redirect_worker_stdout():
    # redirect_stdout in the parent is a Python-object swap the spawned process does not inherit; pymupdf4llm prints to stdout.
    try:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    except (AttributeError, OSError, ValueError):
        sys.stdout = sys.stderr


def raster_worker(conn, path):
    redirect_worker_stdout()
    import pymupdf
    doc = pymupdf.open(path)
    conn.send({"ready": True})
    while True:
        job = conn.recv()
        if job["kind"] == "stop":
            break
        conn.send(run_raster_job(doc, job))
    doc.close()


class RasterWorker:
    """One spawned PyMuPDF process per conversion. MuPDF spins at C level, so only an OS kill ends a toxic page; a job that overruns its budget or takes the process down costs that job, and the next job respawns."""

    def __init__(self, path, doc):
        self.path, self.doc, self.proc, self.conn = path, doc, None, None

    def run(self, job, budget_s):
        if RASTER_INLINE:
            return run_raster_job(self.doc, job)
        if self.proc is None:
            try:
                import multiprocessing
                ctx = multiprocessing.get_context("spawn")
                self.conn, child = ctx.Pipe()
                self.proc = ctx.Process(target=raster_worker, args=(child, self.path))
                try:
                    self.proc.start()
                finally:
                    child.close()
            except Exception as exc:
                if self.conn is not None:
                    self.conn.close()
                self.proc = self.conn = None
                raise RasterUnavailable(f"raster worker unavailable: {exc}") from exc
            try:
                ready = self.conn.poll(RASTER_SPAWN_BUDGET_S) and self.conn.recv() == {"ready": True}
            except (EOFError, OSError):
                ready = False
            if not ready:
                self.kill()
                return {"ok": False, "error": "renderer failed to start"}
        try:
            self.conn.send(job)
            if self.conn.poll(budget_s):
                return self.conn.recv()
            error = f"{JOB_VERB[job['kind']]} timed out after {budget_s:g}s"
        except (EOFError, OSError):
            error = "renderer crashed"
        self.kill()
        if job["kind"] == "render":
            with contextlib.suppress(OSError):
                os.remove(job["target"])
        if job["kind"] == "ocr" and job.get("wordsSnapshot"):
            with contextlib.suppress(OSError):
                os.remove(job["wordsSnapshot"])
        return {"ok": False, "error": error}

    def kill(self):
        if self.proc is not None:
            if self.proc.is_alive():
                self.proc.kill()
            self.proc.join()
            self.conn.close()
            self.proc = self.conn = None

    def stop(self):
        if self.proc is None:
            return
        with contextlib.suppress(OSError):
            self.conn.send({"kind": "stop"})
        self.proc.join(2)
        self.kill()


def textless_picture(worker, page, n, d, o, notes, render):
    """Native stream when the page is one full-page image, else (when render) a worker render at the clamped DPI. Returns (file name or None, .done metadata)."""
    r = worker.run({"kind": "native", "page": n, "target": d, "allowAnnots": bool(o.get("hideAnnotations"))}, raster_budget(RASTER_BUDGET_S))
    if r.get("ok") and r.get("eligible"):
        return r["file"], {"native": {"file": r["file"], "width": r["width"], "height": r["height"]}}
    for f in os.listdir(d):
        if f.startswith("page."):  # a failed native job may have left a partial stream
            os.remove(os.path.join(d, f))
    if not render:
        return None, {}
    eff = clamped_dpi(page.rect.width, page.rect.height, o["imageDpi"])
    if eff is None:
        return None, {}
    name = f"page.{o['imageFormat']}"
    r = worker.run({"kind": "render", "page": n, "dpi": eff, "annots": not o.get("hideAnnotations"), "target": os.path.join(d, name)}, raster_budget(RASTER_BUDGET_S))
    if not r["ok"]:
        raise RasterError(r["error"])
    if eff < o["imageDpi"]:
        notes.append(clamp_note(n, eff, o["imageDpi"]))
        return name, {"dpi": eff, "requestedDpi": o["imageDpi"]}
    return name, {}


def render_page_image(worker, page, n, o, page_images, notes):
    d = o["pagesStagingDir"]
    eff = clamped_dpi(page.rect.width, page.rect.height, o["imageDpi"])
    if eff is None:
        return None
    os.makedirs(d, exist_ok=True)
    name = f"p{n}.{o['imageFormat']}"
    target = os.path.join(d, name)
    r = worker.run({"kind": "render", "page": n, "dpi": eff, "annots": not o.get("hideAnnotations"), "target": target}, raster_budget(RASTER_BUDGET_S))
    if not r["ok"]:
        notes.append(f"Page {n} render unavailable: {r['error']}")
        with contextlib.suppress(OSError):
            os.remove(target)
        return None
    entry = {"page": n, "file": name, "dpi": eff}
    if eff < o["imageDpi"]:
        entry["requestedDpi"] = o["imageDpi"]
        notes.append(clamp_note(n, eff, o["imageDpi"]))
    page_images.append(entry)
    return name


def page_failure(n, exc):
    return {"page": n, "error": str(exc) if isinstance(exc, RasterError) else f"{type(exc).__name__}: {exc}"[:300]}


def page_ocr_kwargs(textless, lang):
    if textless:
        return {"use_ocr": True, "force_ocr": True, "ocr_language": lang}
    return {"use_ocr": False}


def image_ocr_dpi(px_w, pt_w, pt_h):
    import math
    native = 72 * px_w / pt_w
    cap = math.sqrt(MAX_RENDER_PX / (pt_w * pt_h / 72 ** 2))
    return max(1, math.floor(min(native, cap)))


def mode_image(o):
    import pymupdf
    import pymupdf4llm
    path, lang = o["path"], o.get("ocrLanguage", "eng")
    ext = os.path.splitext(path)[1].lower()
    d = page_dir(o["stagingDir"], 1)
    name = f"original{ext}"
    shutil.copyfile(path, os.path.join(d, name))
    mark_done(d)
    md = f"![{o['stem']}](p1/{name})"
    info = new_ocr(lang)
    status = ocr_status(bool(o.get("ocr")), lang)
    apply_status(info, status)
    words_on = bool(o.get("words"))
    word_pages, words_errors = [], {}
    w_px = h_px = None
    if words_on or status["status"] == "ready":
        try:
            pix = pymupdf.Pixmap(path)
            w_px, h_px = pix.width, pix.height
            del pix
        except Exception as exc:  # noqa: BLE001
            if words_on:
                words_errors["1"] = words_error(exc)
            if status["status"] == "ready":
                info["ocrFailed"].append(1)
                status = {**status, "status": "failed"}
    if status["status"] == "ready":
        try:
            if min(w_px, h_px) < MIN_OCR_SIDE_PX:
                info["status"], info["reason"] = "skipped", "image too small"
            else:
                with pymupdf.open(path) as src, pymupdf.open("pdf", src.convert_to_pdf()) as pdf:
                    r = pdf[0].rect
                    text = pymupdf4llm.to_markdown(pdf, pages=[0], write_images=False, use_ocr=True, force_ocr=True,
                                                   ocr_language=lang, ocr_dpi=image_ocr_dpi(w_px, r.width, r.height),
                                                   page_separators=False).strip()
                    if words_on:
                        try:
                            pg = pdf[0]
                            entry = words_page(pg, 1, 0, page_words(pg, True))
                            sx, sy = w_px / r.width, h_px / r.height
                            for word in entry["words"]:
                                b = word["bbox"]
                                word["bbox"] = [round(b[0] * sx, 1), round(b[1] * sy, 1),
                                                round(b[2] * sx, 1), round(b[3] * sy, 1)]
                            entry["width"], entry["height"] = w_px, h_px
                            word_pages.append(entry)
                        except Exception as exc:  # noqa: BLE001
                            words_errors["1"] = words_error(exc)
                if text:
                    info["pages"].append(1)
                    md += "\n\n" + ocr_block(f"p1/{name}", text)
                else:
                    info["noText"].append(1)
        except Exception:  # noqa: BLE001 - OCR never fails the conversion
            info["ocrFailed"].append(1)
    if words_on and not o.get("ocr") and w_px is not None and "1" not in words_errors:
        try:
            if os.environ.get("DOC_TO_MD_WORDS_FAIL") == "1":  # tests only
                raise RuntimeError("words injected failure")
            word_pages.append({"page": 1, "width": w_px, "height": h_px, "rotation": 0, "words": []})
        except Exception as exc:  # noqa: BLE001
            words_errors["1"] = words_error(exc)
    result = {"markdown": md + "\n", "pageCount": 1, "emptyPages": [], "failedPages": [], "notes": [], "ocr": info}
    if words_on:
        result.update(write_words(o["stagingDir"], "px", word_pages, words_errors))
    return result


def mode_info(o):
    import pymupdf  # noqa: F401
    doc = open_pdf(o["path"])
    meta = {k: v for k, v in (doc.metadata or {}).items() if v}
    toc = [[lvl, title, page] for lvl, title, page in doc.get_toc()]
    return {"pageCount": doc.page_count, "metadata": meta, "toc": toc}


def primary_page_markdown(doc, n, d, o, kw, write_images):
    import pymupdf4llm
    if not write_images:
        return pymupdf4llm.to_markdown(doc, pages=[n - 1], write_images=False, page_separators=False, **kw)
    # Space-free temp dir: pymupdf4llm's md_path() mangles paths containing spaces/parens.
    with tempfile.TemporaryDirectory() as tmp:
        md = pymupdf4llm.to_markdown(doc, pages=[n - 1], write_images=True, image_path=tmp,
                                       image_format=o["imageFormat"], dpi=o["imageDpi"], page_separators=False, **kw)
        sources = {}
        for i, f in enumerate(sorted(os.listdir(tmp)), 1):
            dest = f"img{i}{os.path.splitext(f)[1].lower()}"
            source = os.path.join(tmp, f)
            sources.update(image_source_map(source, f"p{n}/{dest}", f))
            os.replace(source, os.path.join(d, dest))
        return rewrite_image_destinations(md, sources)


def page_stats(doc, n):
    try:
        page = doc[n - 1]
        chars = len(page.get_text("text").strip())
        infos = page.get_image_info()
        area = page.rect.width * page.rect.height
        covered = sum(max(0.0, (b[2] - b[0]) * (b[3] - b[1])) for b in (i["bbox"] for i in infos))
        coverage = round(min(1.0, covered / area), 2) if area > 0 else 0.0
        return {"page": n, "chars": chars, "images": len(infos), "imageCoverage": coverage}
    except Exception as exc:  # noqa: BLE001 - stats never cost a page its Markdown
        return {"page": n, "error": f"{type(exc).__name__}: {exc}"[:300]}


GLYPHLESS_FONT = "GlyphLessFont"


def word_entries(page, words, ocr_lines):
    import pymupdf
    matrix = page.rotation_matrix
    out = []
    for x0, y0, x1, y1, text, bno, lno, _ in words:
        r = pymupdf.Rect(x0, y0, x1, y1) * matrix
        out.append({"text": text, "bbox": [round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1)],
                    "source": "ocr" if ocr_lines is None or (bno, lno) in ocr_lines else "text"})
    return out


def page_words(page, inline_ocr_ran):
    if not inline_ocr_ran:
        return word_entries(page, page.get_text("words"), set())
    # Shared textpage keeps block/line indexes aligned despite differing default image flags.
    tp = page.get_textpage()
    ocr_lines = {(bi, li) for bi, b in enumerate(page.get_text("dict", textpage=tp)["blocks"])
                 for li, line in enumerate(b.get("lines", []))
                 if line["spans"] and all(s["font"] == GLYPHLESS_FONT for s in line["spans"])}
    return word_entries(page, page.get_text("words", textpage=tp), ocr_lines)


def ocr_words(page, tp):
    return word_entries(page, page.get_text("words", textpage=tp), None)


def words_page(page, n, rotation, words):
    if os.environ.get("DOC_TO_MD_WORDS_FAIL") == str(n):  # tests only
        raise RuntimeError("words injected failure")
    return {"page": n, "width": round(page.rect.width, 1), "height": round(page.rect.height, 1),
            "rotation": rotation, "words": words}


def words_error(exc):
    return f"{type(exc).__name__}: {exc}"[:300]


def write_words(staging, unit, pages, errors):
    try:
        os.makedirs(staging, exist_ok=True)
        with open(os.path.join(staging, "words.json"), "w", encoding="utf-8") as fh:
            json.dump({"unit": unit, "pages": pages}, fh, indent=2)
            fh.write("\n")
        return {"words": True, "wordsErrors": errors}
    except Exception as exc:  # noqa: BLE001 - geometry never fails the conversion
        errors["file"] = words_error(exc)
        return {"words": False, "wordsErrors": errors}


def mode_pdf_primary(o):
    import time
    start = time.monotonic()
    doc = open_pdf(o["path"])
    pages = check_pages(o.get("pages"), doc.page_count)
    staging, out, empty, failed, notes = o["stagingDir"], [], [], [], []
    page_images = []
    native_images = []
    worker = RasterWorker(o["path"], doc)
    stats = []
    lang, budget, max_pages = o.get("ocrLanguage", "eng"), o.get("ocrBudgetMs", 60000), o.get("ocrMaxPages", 10)
    ocr_count = 0
    info = new_ocr(lang)
    status = ocr_status(True, lang) if o.get("ocr") else None
    ocr_ms, plain_ms = [], []
    word_pages, words_errors = [], {}
    try:
        for i, n in enumerate(pages):
            stats.append(page_stats(doc, n))
            d = page_dir(staging, n)
            try:
                page = doc[n - 1]
                rotation = page.rotation
                textless = not page.get_text("text").strip()
                if textless:
                    info["textless"].append(n)
                    if status is None:
                        status = ocr_status(False, lang)
                kw = page_ocr_kwargs(textless, lang) if status and status["status"] == "ready" else {"use_ocr": False}
                if kw["use_ocr"]:
                    if ocr_count >= max_pages:
                        info["ceilingStopped"].append(n)
                        kw = {"use_ocr": False}
                    else:
                        elapsed = (time.monotonic() - start) * 1000
                        est_ocr = max(ocr_ms) if ocr_ms else OCR_EST_INITIAL_MS
                        est_page = sum(plain_ms) / len(plain_ms) if plain_ms else PAGE_EST_INITIAL_MS
                        if not ocr_admit(elapsed, est_ocr, len(pages) - i - 1, est_page, budget):
                            info["budgetStopped"].append(n)
                            kw = {"use_ocr": False}
                text, meta = "", {}
                ocr_words = None
                if textless:
                    pic, meta = textless_picture(worker, page, n, d, o, notes, render=not o.get("pageImages"))
                    t0 = time.monotonic()
                    if kw["use_ocr"]:
                        remaining = (budget - (time.monotonic() - start) * 1000 - OCR_BUDGET_RESERVE_MS) / 1000
                        if remaining < MIN_OCR_JOB_S:
                            info["budgetStopped"].append(n)
                            kw = {"use_ocr": False}
                        else:
                            ocr_dpi = clamped_dpi(page.rect.width, page.rect.height, OCR_DPI)
                            words_snapshot = os.path.join(staging, f".ocr-words-p{n}.pdf") if o.get("words") else None
                            ocr_count += 1
                            try:
                                r = worker.run({"kind": "ocr", "page": n, "lang": lang, "ocrDpi": ocr_dpi, **({"wordsSnapshot": words_snapshot} if words_snapshot else {})}, min(raster_budget(OCR_JOB_BUDGET_S), remaining)) if ocr_dpi is not None else {"ok": False}
                                if words_snapshot and r["ok"]:
                                    if r.get("wordsSnapshotError"):
                                        words_errors[str(n)] = r["wordsSnapshotError"]
                                    else:
                                        try:
                                            with open_pdf(words_snapshot) as snapshot:
                                                ocr_words = words_page(snapshot[0], n, rotation, page_words(snapshot[0], True))
                                        except Exception as exc:  # noqa: BLE001
                                            words_errors[str(n)] = words_error(exc)
                            finally:
                                if words_snapshot:
                                    with contextlib.suppress(OSError):
                                        os.remove(words_snapshot)
                            if r["ok"]:
                                text = r["markdown"].strip()
                            else:
                                kw = {"use_ocr": False}
                                info["ocrFailed"].append(n)
                    md = ""
                else:
                    t0 = time.monotonic()
                    md = primary_page_markdown(doc, n, d, o, kw, True)
                if not (textless and not kw["use_ocr"]):
                    (ocr_ms if kw["use_ocr"] else plain_ms).append((time.monotonic() - t0) * 1000)
                if textless:
                    if kw["use_ocr"] and text:
                        info["pages"].append(n)
                    else:
                        if kw["use_ocr"]:
                            info["noText"].append(n)
                        empty.append(n)
                elif not md.strip():
                    empty.append(n)
                mark_done(d, meta)
                page_pic = render_page_image(worker, page, n, o, page_images, notes) if o.get("pageImages") else None
                if textless:
                    parts = [f"![page {n}](p{n}/{pic})"] if pic else []
                    if kw["use_ocr"] and text:
                        parts.append(ocr_block(f"p{n}/{pic}" if pic else f"pages/{page_pic}" if page_pic else "-", text))
                    md = "\n\n".join(parts)
                if page_pic:
                    md = "\n\n".join(x for x in [md.rstrip(), f"![page {n}](pages/{page_pic})"] if x)
                out.append(md.rstrip())
                if o.get("words") and not (textless and o.get("ocr") and not kw["use_ocr"]):
                    try:
                        if textless and kw["use_ocr"]:
                            if ocr_words is not None:
                                word_pages.append(ocr_words)
                        else:
                            word_pages.append(words_page(page, n, rotation, page_words(page, kw["use_ocr"])))
                    except Exception as exc:  # noqa: BLE001
                        words_errors[str(n)] = words_error(exc)
                if meta.get("native"):
                    native_images.append({"page": n, **meta["native"]})
            except RasterUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001
                shutil.rmtree(d, ignore_errors=True)
                failed.append(page_failure(n, exc))
                empty.append(n)
                out.append("")
            out.append(SEP.format(n=n).strip("\n"))
    finally:
        worker.stop()
    if failed and len(failed) == len(pages):
        raise RuntimeError("every selected page failed: " + failed[0]["error"])
    if status is not None:
        apply_status(info, status)
    missing = len(pages) - len(page_images) if o.get("pageImages") else 0
    if missing:
        notes.append(f"Page images: {missing} of {len(pages)} unavailable")
    result = {"markdown": "\n\n".join(out) + "\n", "pages": pages, "pageCount": doc.page_count,
              "emptyPages": empty, "failedPages": failed, "notes": notes, "ocr": info, "pageImages": page_images, "nativeImages": native_images, "pageStats": stats}
    if o.get("words"):
        result.update(write_words(staging, "pt", word_pages, words_errors))
    return result


def mode_pdf_fallback(o):
    import pymupdf
    doc = open_pdf(o["path"])
    pages = check_pages(o.get("pages"), doc.page_count)
    keep = {int(k): v for k, v in (o.get("keepPages") or {}).items()}
    staging, out, empty, failed = o["stagingDir"], [], [], []
    page_images = []
    native_images = []
    worker = RasterWorker(o["path"], doc)
    stats = []
    lang = o.get("ocrLanguage", "eng")
    ocr_info = new_ocr(lang)
    word_pages, words_errors = [], {}
    status = {"status": "unavailable", "reason": "fallback tier", "tesseract": None} if o.get("ocr") else None
    notes = [DEGRADED_NOTE]
    try:
        for n in pages:
            stats.append(page_stats(doc, n))
            links = [f"![](images/{f})" for f in keep.get(n, [])]
            text = ""
            page_pic = None
            meta = {}
            page_ok = False
            try:
                page = doc[n - 1]
                rotation = page.rotation
                text = page.get_text("text").strip()
                if not text:
                    ocr_info["textless"].append(n)
                    if status is None:
                        status = ocr_status(False, lang)
                if n not in keep:
                    d = page_dir(staging, n)
                    if not text:
                        pic, meta = textless_picture(worker, page, n, d, o, notes, render=not o.get("pageImages"))
                        if pic:
                            links.append(f"![page {n}](p{n}/{pic})")
                    else:
                        eff = clamped_dpi(page.rect.width, page.rect.height, o["imageDpi"])
                        r = worker.run({"kind": "images", "page": n, "dpi": eff, "annots": not o.get("hideAnnotations"), "format": o["imageFormat"], "target": d}, raster_budget(RASTER_BUDGET_S))
                        if not r["ok"]:
                            raise RasterError(r["error"])
                        links.extend(f"![](p{n}/{name})" for name in r["files"])
                    mark_done(d, meta)
                page_pic = render_page_image(worker, page, n, o, page_images, notes) if o.get("pageImages") else None
                page_ok = True
            except RasterUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001
                shutil.rmtree(os.path.join(staging, f"p{n}"), ignore_errors=True)
                text = ""
                meta = {}
                links = [f"![](images/{f})" for f in keep.get(n, [])]
                failed.append(page_failure(n, exc))
            if o.get("words") and page_ok and not (not text and o.get("ocr")):
                try:
                    word_pages.append(words_page(page, n, rotation, page_words(page, False)))
                except Exception as exc:  # noqa: BLE001
                    words_errors[str(n)] = words_error(exc)
            if not text:
                empty.append(n)
            out.append("\n\n".join(x for x in [text, "\n".join(links), f"![page {n}](pages/{page_pic})" if page_pic else ""] if x))
            if meta.get("native"):
                native_images.append({"page": n, **meta["native"]})
            out.append(SEP.format(n=n).strip("\n"))
    finally:
        worker.stop()
    if failed and len(failed) == len(pages):
        raise RuntimeError("every selected page failed: " + failed[0]["error"])
    if status is not None:
        apply_status(ocr_info, status)
    missing = len(pages) - len(page_images) if o.get("pageImages") else 0
    if missing:
        notes.append(f"Page images: {missing} of {len(pages)} unavailable")
    result = {"markdown": "\n\n".join(out) + "\n", "pages": pages, "pageCount": doc.page_count,
              "emptyPages": empty, "failedPages": failed, "notes": notes, "ocr": ocr_info, "pageImages": page_images, "nativeImages": native_images, "pageStats": stats}
    if o.get("words"):
        result.update(write_words(staging, "pt", word_pages, words_errors))
    return result


def mode_ocr_pages(o):
    import time
    start = time.monotonic()
    lang, budget = o.get("ocrLanguage", "eng"), o.get("ocrBudgetMs", 60000)
    status = ocr_status(True, lang)
    if status["status"] != "ready":
        return {"status": "unavailable", "reason": status["reason"]}
    doc = open_pdf(o["path"])
    pages = check_pages(o.get("pages"), doc.page_count)
    staging, stem, dpi = o["stagingDir"], o["stem"], o.get("dpi", 150)
    os.makedirs(staging, exist_ok=True)
    active = os.path.join(staging, "active")
    out = {"status": "ran", "written": [], "noText": [], "ocrFailed": [], "ocrErrors": {}, "budgetStopped": []}
    if o.get("words"):
        out["wordsErrors"] = {}
    ocr_ms = []
    for i, n in enumerate(pages):
        with open(active, "w") as fh:
            fh.write(str(n))
        if os.environ.get("DOC_TO_MD_OCR_STALL_PAGE") == str(n):  # tests only: simulate a wedged page
            time.sleep(3600)
        elapsed = (time.monotonic() - start) * 1000
        est = max(ocr_ms) if ocr_ms else OCR_EST_INITIAL_MS
        if not ocr_admit(elapsed, est, 0, 0, budget):
            out["budgetStopped"].extend(pages[i:])
            os.remove(active)
            break
        tag = f"p{n:03d}"
        d = os.path.join(staging, tag)
        os.makedirs(d, exist_ok=True)
        sidecar = os.path.join(d, f"{stem}-{tag}.md")
        t0 = time.monotonic()
        try:
            page = doc[n - 1]
            eff = clamped_dpi(page.rect.width, page.rect.height, dpi)
            if eff is None:
                raise RuntimeError(f"page cannot be rendered at a usable DPI ({page.rect.width:.0f} x {page.rect.height:.0f} pt)")
            tp = page.get_textpage_ocr(full=True, language=lang, dpi=eff)
            text = page.get_text("text", textpage=tp).strip()
            header = f"<!-- OCR of page {n} (tesseract {lang}); recognized text, not the text layer -->"
            with open(sidecar, "w", encoding="utf-8") as fh:
                fh.write(header + "\n\n" + (text + "\n\n" if text else "") + SEP.format(n=n).strip("\n") + "\n")
            if o.get("words"):
                wpath = os.path.join(d, f"{stem}-{tag}.words.json")
                try:
                    entry = words_page(page, n, page.rotation, ocr_words(page, tp))
                    entry["unit"] = "pt"
                    with open(wpath, "w", encoding="utf-8") as fh:
                        json.dump(entry, fh, indent=2)
                        fh.write("\n")
                except Exception as exc:  # noqa: BLE001 - geometry never changes the OCR outcome
                    try:
                        os.remove(wpath)
                    except OSError:
                        pass
                    out["wordsErrors"][str(n)] = words_error(exc)
            mark_done(d)
            (out["written"] if text else out["noText"]).append(n)
        except Exception as exc:  # noqa: BLE001 - one page never stops the pass
            msg = f"{type(exc).__name__}: {exc}"
            with open(os.path.join(d, ".failed"), "w", encoding="utf-8") as fh:
                fh.write(msg)
            try:
                os.remove(sidecar)
            except OSError:
                pass
            try:
                os.remove(os.path.join(d, f"{stem}-{tag}.words.json"))
            except OSError:
                pass
            out["ocrFailed"].append(n)
            out["ocrErrors"][str(n)] = msg
        ocr_ms.append((time.monotonic() - t0) * 1000)
        os.remove(active)
    return out


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


PREVIEW_ROWS, PREVIEW_COLS = 100, 50
PROFILE_MAJORITY, DISTINCT_CAP, SLUG_MAX = 0.6, 50, 40
MAX_RENDER_PX, MIN_RENDER_DPI, MIN_PAGE_PT = 50_000_000, 36, 72
INV_HEADER = "| # | name | kind | size | hidden | charts | images | rendered | data |\n|---|---|---|---|---|---|---|---|---|\n"
XLS_NOTE = "Rendered views: unavailable (visual detection not supported for .xls)"


def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:SLUG_MAX].strip("-")
    return s or "sheet"


def csv_value(v):
    import datetime
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    return str(v)


def cell_class(v):
    import datetime
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, (datetime.date, datetime.datetime)):
        return "date"
    return "str"


def is_formula(src):
    return isinstance(src, str) and src.startswith("=")


class ColProfile:
    def __init__(self):
        self.n, self.classes, self.lo, self.hi, self.distinct = 0, {}, None, None, set()

    def add(self, cls, v):
        self.n += 1
        self.classes[cls] = self.classes.get(cls, 0) + 1
        if cls in ("int", "float", "date"):
            try:
                if self.lo is None or v < self.lo:
                    self.lo = v
                if self.hi is None or v > self.hi:
                    self.hi = v
            except TypeError:
                pass
        if len(self.distinct) <= DISTINCT_CAP:
            self.distinct.add(repr(v))

    def row(self, letter, header):
        if not self.n:
            return f"| {letter} | {header} | - | 0 | - | - | 0 |"
        cls, cnt = max(self.classes.items(), key=lambda kv: kv[1])
        typ = cls if cnt / self.n >= PROFILE_MAJORITY else "mixed"
        rng = typ in ("int", "float", "date") and self.lo is not None
        lo, hi = (esc(self.lo), esc(self.hi)) if rng else ("-", "-")
        distinct = f">{DISTINCT_CAP}" if len(self.distinct) > DISTINCT_CAP else str(len(self.distinct))
        return f"| {letter} | {header} | {typ} | {self.n} | {lo} | {hi} | {distinct} |"


def chart_line(ch):
    title = "untitled"
    tx = getattr(getattr(ch, "title", None), "tx", None)
    if tx is not None:
        if getattr(tx, "rich", None) is not None:
            title = "".join((r.t or "") for p in tx.rich.p for r in (p.r or [])) or "untitled"
        elif getattr(tx, "strRef", None) is not None:
            title = tx.strRef.f or "untitled"
    series = list(getattr(ch, "series", None) or [])
    refs = [s.val.numRef.f for s in series if getattr(s, "val", None) is not None and s.val.numRef is not None]
    shown = ", ".join(refs[:5]) + (", ..." if len(refs) > 5 else "")
    return f'- {type(ch).__name__} "{esc(title)}" - {len(series)} series ({shown})'


def write_csv(idx, title, cells, R, C, csv_dir):
    if not R:
        return None
    import csv
    os.makedirs(csv_dir, exist_ok=True)
    name = f"s{idx}-{slug(title)}.csv"
    with open(os.path.join(csv_dir, name), "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        for row in cells[:R]:
            w.writerow([csv_value(val if val is not None else src) for src, val in row[:C]])
    return f"sheets/{name}"


def data_line(R, C, csv_rel, formulas):
    if not R:
        return "Data: none"
    return f"Data: [{csv_rel}]({csv_rel}) - {R} rows x {C} cols" + (f", {formulas} formulas" if formulas else "")


def preview_and_profile(lines, cells, profiles, R, C, continuation):
    r_lim, c_lim = min(R, PREVIEW_ROWS), min(C, PREVIEW_COLS)
    truncated = r_lim < R or c_lim < C
    lines.append("")
    lines.append(f"Preview (rows 1-{r_lim} of {R}, cols A-{col_letter(c_lim)} of {C}) - full data in the CSV above:" if truncated else f"Content ({R} rows x {C} cols):")
    lines += ["| | " + " | ".join(col_letter(c) for c in range(1, c_lim + 1)) + " |", "|---|" + "---|" * c_lim]
    for r in range(1, r_lim + 1):
        out = []
        for c in range(1, c_lim + 1):
            if (r, c) in continuation:
                out.append("")
                continue
            src, val = cells[r - 1][c - 1]
            if is_formula(src):
                out.append(f"{esc(val) if val is not None else '(no cached result)'} ({esc(src)})")
            else:
                out.append(esc(src))
        lines.append(f"| {r} | " + " | ".join(out) + " |")
    if not truncated:
        return r_lim, c_lim
    lines += ["", "Columns:", "| col | header | type | non-empty | min | max | distinct |", "|---|---|---|---|---|---|---|"]
    for c, p in enumerate(profiles[:C], 1):
        h = cells[0][c - 1][0]
        lines.append(p.row(col_letter(c), esc(h) if isinstance(h, str) and not is_formula(h) else "-"))
    return r_lim, c_lim


def inv_row(idx, name, kind, size, hidden, charts, images, rvs, data):
    return f"| {idx} | {esc(name)} | {kind} | {size} | {'yes' if hidden else 'no'} | {charts} | {images} | {rvs} | {data} |"


def sheet_info(idx, name, kind, hidden, R, C, hr, hc, charts, images, csv_rel):
    return {"index": idx, "name": name, "kind": kind, "hidden": hidden, "rows": R, "cols": C, "hiddenRows": hr, "hiddenCols": hc,
            "charts": charts, "images": images, "rendered": False, "csv": csv_rel}

def is_page_break(el):
    return el.tag == f"{W}br" and el.get(f"{W}type") == "page"


def count_explicit_breaks(body):
    return sum(1 for el in body.iter(f"{W}br") if is_page_break(el))


def heading_level(paragraph):
    name = paragraph.style.name if paragraph.style is not None else ""
    m = re.match(r"heading\s*(\d+)$", (name or "").strip(), re.IGNORECASE)
    return min(int(m.group(1)), 6) if m else None


def paragraph_pieces(p_el):
    pieces = [""]
    for el in p_el.iter():
        if el.tag == f"{W}t":
            pieces[-1] += el.text or ""
        elif el.tag == f"{W}tab":
            pieces[-1] += "\t"
        elif is_page_break(el):
            pieces.append("")
    return pieces


def docx_body_events(document):
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    def walk(child):
        if child.tag == f"{W}p":
            lvl = heading_level(Paragraph(child, document))
            pieces = paragraph_pieces(child)
            images = [False] * len(pieces)
            part = 0
            for el in child.iter():
                if is_page_break(el):
                    part += 1
                elif el.tag in (f"{W}drawing", f"{W}pict"):
                    images[part] = True
            for i, piece in enumerate(pieces):
                if i:
                    yield "break", None, None
                yield "paragraph", (piece, images[i]), lvl
        elif child.tag == f"{W}tbl":
            yield "table", Table(child, document), None
            for _ in range(count_explicit_breaks(child)):
                yield "break", None, None
        elif is_page_break(child):
            yield "break", None, None
        else:
            for nested in child.iterchildren():
                yield from walk(nested)

    for child in document.element.body.iterchildren():
        yield from walk(child)


def image_ext(content_type):
    ct = (content_type or "").lower()
    if ct in ("image/x-emf", "image/x-wmf"):
        return ct[8:]
    return ct.split("/", 1)[1] if "/" in ct else "bin"


def finish_segments(segs):
    if len(segs) > 1 and not segs[-1].strip():
        segs = segs[:-1]
    return segs


def hoist_breaks(soup):
    for hr in list(soup.find_all("hr", class_="pagebreak")):
        top = hr
        while top.parent is not None and top.parent is not soup:
            top = top.parent
        if top is hr:
            continue
        if top.name == "table":
            hr.extract()
            top.insert_after(hr)
            continue
        chain, node = [], hr
        while node is not top:
            chain.append(node)
            node = node.parent
        tail, created = None, []
        for node in chain:
            parent = node.parent
            fresh = soup.new_tag(parent.name, attrs=dict(parent.attrs))
            if tail is not None:
                fresh.append(tail)
            for sib in list(node.next_siblings):
                fresh.append(sib.extract())
            created.append(fresh)
            tail = fresh
        hr.extract()
        top.insert_after(hr)
        hr.insert_after(tail)
        for el in created + [top]:
            if not el.get_text(strip=True) and el.find("img") is None and el.find("hr", class_="pagebreak") is None:
                el.decompose()
    for n in (7, 8, 9):
        for h in soup.find_all(f"h{n}"):
            h.name = "h6"


def split_footnotes(soup):
    notes = {}
    ols = soup.find_all("ol", recursive=False)
    if ols:
        ol = ols[-1]
        items = ol.find_all("li", recursive=False)
        if items and all((li.get("id") or "").startswith(("footnote-", "endnote-")) for li in items):
            for li in items:
                notes[li["id"]] = li
            ol.extract()
    return notes


def code_language(pre):
    for node in [pre, *pre.find_all("code", limit=1)]:
        for cls in node.get("class") or []:
            match = CODE_LANG_RE.match(cls)
            if match:
                return match.group(1)
    return ""


def markdown_converter(pagebreaks):
    from markdownify import MarkdownConverter

    class Converter(MarkdownConverter):
        def convert_img(self, el, text, parent_tags):
            # Mammoth wraps cell images in p; markdownify checks only the immediate parent.
            if el.find_parent(["td", "th"]):
                parent_tags = parent_tags - {"_inline"}
            return super().convert_img(el, text, parent_tags)

        def convert_hr(self, el, text, parent_tags):
            if pagebreaks and "pagebreak" in (el.get("class") or []):
                return f"\n\n{PAGEBREAK_SENTINEL}\n\n"
            return "\n\n---\n\n"

        def convert_td(self, el, text, parent_tags):
            return super().convert_td(el, re.sub(r"(?<!\\)\|", r"\\|", text), parent_tags)

        def convert_th(self, el, text, parent_tags):
            return super().convert_th(el, re.sub(r"(?<!\\)\|", r"\\|", text), parent_tags)

    return Converter(heading_style="ATX", bullets="-", keep_inline_images_in=["td", "th"], code_language_callback=code_language)


def mode_html(o):
    from bs4 import BeautifulSoup
    md = markdown_converter(pagebreaks=False).convert_soup(BeautifulSoup(o["html"], "html.parser")).strip()
    return {"markdown": md + "\n", "pageCount": None, "engine": "markdownify", "emptyPages": [], "failedPages": [], "notes": []}


SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def format_size(n):
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    return f"{n / (1024 * 1024):.1f}MB"


def safe_attachment_name(name, index):
    base = os.path.basename((name or "").replace("\\", "/"))
    stem, ext = os.path.splitext(base)
    stem = SAFE_NAME_RE.sub("_", stem)
    ext = SAFE_NAME_RE.sub("", ext).lower()
    return (stem if stem.strip("._") else f"attachment-{index + 1}") + ext


def dedupe_names(names):
    seen, out = {}, []
    for name in names:
        stem, ext = os.path.splitext(name)
        candidate = name
        suffix = 2
        while candidate.lower() in seen:
            candidate = f"{stem}-{suffix}{ext}"
            suffix += 1
        seen[candidate.lower()] = True
        out.append(candidate)
    return out


def email_table(headers):
    rows = [f"| {key} | {esc(value)} |" for key, value in headers if key != "Cc" or value]
    return "| Header | Value |\n|---|---|\n" + "\n".join(rows)


def parse_eml(path):
    import email
    import email.policy
    with open(path, "rb") as fh:
        msg = email.message_from_bytes(fh.read(), policy=email.policy.default)
    def h(name):
        return str(msg[name] or "")
    parsed_date = msg["Date"].datetime if msg["Date"] else None
    date = parsed_date.isoformat() if parsed_date else h("Date")
    body = msg.get_body(preferencelist=("html", "plain"))
    html = text = None
    if body is not None:
        content = body.get_content()
        if body.get_content_type() == "text/html":
            html = content
        else:
            text = content
    inline, attachments = {}, []
    pending = [msg]
    while pending:
        part = pending.pop()
        if part.get_content_type() == "message/rfc822":
            attachments.append((part.get_filename() or "message.eml", part.get_payload(0).as_bytes(), "message/rfc822", None))
            continue
        if part.is_multipart():
            pending.extend(reversed(list(part.iter_parts())))
            continue
        if part is body:
            continue
        cid = (part.get("Content-ID") or "").strip("<>")
        data = part.get_payload(decode=True)
        if data is None:
            continue
        if cid and html and f"cid:{cid}" in html:
            inline[cid] = (data, image_ext(part.get_content_type()))
        elif part.get_content_disposition() in ("attachment", "inline") or part.get_filename():
            attachments.append((part.get_filename(), data, part.get_content_type(), None))
    return {"From": h("From"), "To": h("To"), "Cc": h("Cc"), "Date": date, "Subject": h("Subject")}, html, text, inline, attachments


def parse_msg(path):
    import extract_msg
    msg = extract_msg.openMsg(path)
    html = msg.htmlBody.decode("utf-8", "replace") if isinstance(msg.htmlBody, bytes) else msg.htmlBody
    inline, attachments = {}, []
    for part in msg.attachments:
        name = part.longFilename or part.shortFilename
        try:
            data = part.data
            if isinstance(part, extract_msg.attachments.EmbeddedMsgAttachment) and data is not None:
                attachments.append((name if not name or name.lower().endswith(".msg") else f"{name}.msg", data.exportBytes(), "application/vnd.ms-outlook", None))
                continue
        except NotImplementedError as exc:
            attachments.append((name, None, "application/octet-stream", str(exc) or "unsupported attachment"))
            continue
        if not isinstance(data, (bytes, bytearray)):
            attachments.append((name, None, "application/octet-stream", "data unavailable"))
            continue
        cid = part.cid
        if cid and html and f"cid:{cid}" in html:
            inline[cid] = (bytes(data), image_ext(part.mimetype or "image/png"))
        else:
            attachments.append((name, bytes(data), part.mimetype or "application/octet-stream", None))
    date = msg.date
    headers = {"From": msg.sender or "", "To": msg.to or "", "Cc": msg.cc or "",
               "Date": date.isoformat() if date else "", "Subject": msg.subject or ""}
    return headers, html, None if html else msg.body, inline, attachments


def mode_email(o):
    from bs4 import BeautifulSoup
    path = o["path"]
    is_msg = path.lower().endswith(".msg")
    try:
        headers, html, text, inline, attachments = parse_msg(path) if is_msg else parse_eml(path)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"email parse failed: {type(exc).__name__}: {exc}") from exc
    d = page_dir(o["stagingDir"], 1)
    sources = {}
    for i, (cid, (data, ext)) in enumerate(inline.items(), 1):
        name = f"img{i}.{ext}"
        with open(os.path.join(d, name), "wb") as fh:
            fh.write(data)
        sources[f"cid:{cid}"] = f"p1/{name}"
    mark_done(d)
    if html:
        soup = BeautifulSoup(html, "html.parser")
        for img in soup.find_all("img"):
            src = img.get("src") or ""
            if src in sources:
                img["src"] = sources[src]
        body_md = markdown_converter(pagebreaks=False).convert_soup(soup).strip()
    elif text:
        body_md = text
    else:
        body_md = "Body: none"
    names = dedupe_names([safe_attachment_name(name, i) for i, (name, _, _, _) in enumerate(attachments)])
    rows = []
    os.makedirs(o["attachmentsStagingDir"], exist_ok=True)
    for name, (_, data, ctype, reason) in zip(names, attachments):
        if reason is not None:
            rows.append(f"- `{name}` ({ctype}) (not extracted: {reason})")
            continue
        with open(os.path.join(o["attachmentsStagingDir"], name), "wb") as fh:
            fh.write(data)
        rows.append(f"- [`{name}`](attachments/{name}) ({format_size(len(data))}, {ctype})")
    md = f"# {esc(headers['Subject'] or '(no subject)')}\n\n{email_table(headers.items())}\n\n{body_md}\n"
    if rows:
        md += "\n## Attachments\n\n" + "\n".join(rows) + "\n"
    return {"markdown": md, "pageCount": None, "engine": "extract-msg" if is_msg else "email",
            "emptyPages": [], "failedPages": [], "notes": []}


def numbering_transform(labels):
    from mammoth import documents, transforms
    it = iter(labels)
    _END = object()
    state = {"drift": False}

    def fn(p):
        label = next(it, _END)
        if label is _END:
            state["drift"] = True
            return p
        if label is None:
            return p.copy(numbering=None)
        return p.copy(numbering=None, children=[documents.run([documents.text(label + " ")])] + list(p.children))

    return transforms.paragraph(fn), it, state, _END


def docx_mammoth(path):
    import mammoth
    from bs4 import BeautifulSoup
    import docx_numbering
    notes = []
    try:
        labels = docx_numbering.compute_labels(path)
    except Exception as exc:  # noqa: BLE001 - labels never block conversion
        labels, notes = None, [f"Numbering: labels unavailable ({type(exc).__name__}: {exc})"]

    def convert(transform):
        images = {}

        def convert_image(image):
            with image.open() as fh:
                data = fh.read()
            images[len(images) + 1] = (data, image_ext(image.content_type))
            return {"src": f"__docximg{len(images)}__"}

        with open(path, "rb") as fh:
            kwargs = {"transform_document": transform} if transform else {}
            return mammoth.convert_to_html(fh, style_map=DOCX_STYLE_MAP, convert_image=mammoth.images.img_element(convert_image), **kwargs), images

    if labels is not None:
        transform, it, state, _END = numbering_transform(labels)
        result, images = convert(transform)
        if state["drift"] or next(it, _END) is not _END:
            notes = ["Numbering: labels unavailable (paragraph sequence differs from mammoth's)"]
            result, images = convert(None)
    else:
        result, images = convert(None)
    soup = BeautifulSoup(result.value, "html.parser")
    hoist_breaks(soup)
    footnote_nodes = split_footnotes(soup)

    conv = markdown_converter(pagebreaks=True)
    body = conv.convert_soup(soup)
    segs = finish_segments([s.strip("\n") for s in re.split(r"\n*\x00PAGEBREAK\x00\n*", body)])
    footnotes = {nid: conv.convert("".join(str(c) for c in li.children)).strip() for nid, li in footnote_nodes.items()}
    return segs, images, footnotes, notes


def docx_fallback(path):
    import docx
    document = docx.Document(path)
    segs, cur = [], []

    def close():
        segs.append("\n\n".join(cur))
        cur.clear()

    for kind, value, lvl in docx_body_events(document):
        if kind == "break":
            close()
        elif kind == "paragraph":
            text = value[0].strip()
            if text:
                cur.append(f"{'#' * lvl} {text}" if lvl else text)
        else:
            rows = [[c.text.replace("|", "\\|").replace("\n", " ").strip() for c in r.cells] for r in value.rows]
            if rows:
                cur.append("| " + " | ".join(rows[0]) + " |\n|" + "---|" * len(rows[0]) + "\n" + "\n".join("| " + " | ".join(r) + " |" for r in rows[1:]))
    close()
    return finish_segments(segs)


def assemble_docx(segs, selected, images, footnotes, staging, all_notes):
    out = []
    for n in selected:
        seg = segs[n - 1]
        d = page_dir(staging, n)
        if images and IMG_PLACEHOLDER_RE.search(seg):
            j = 0

            def place(m):
                nonlocal j
                j += 1
                data, ext = images[int(m.group(1))]
                name = f"img{j}.{ext}"
                with open(os.path.join(d, name), "wb") as fh:
                    fh.write(data)
                return f"p{n}/{name}"

            seg = IMG_PLACEHOLDER_RE.sub(place, seg)
        mark_done(d)
        out.append(seg)
        if len(segs) > 1:
            out.append(SEP.format(n=n).strip("\n"))
    md = "\n\n".join(out)
    wanted = list(footnotes) if all_notes else [nid for nid in footnotes if any(f"(#{nid})" in segs[n - 1] for n in selected)]
    if wanted:
        md += "\n\n" + "\n".join(f"{nid.split('-', 1)[1]}. {footnotes[nid]}" for nid in wanted)
    return md


def mode_docx(o):
    staging = o["stagingDir"]
    engine, degraded, reason = "mammoth", False, None
    try:
        if os.environ.get("DOC_TO_MD_FORCE_DOCX_FALLBACK") == "1":
            raise RuntimeError("forced by DOC_TO_MD_FORCE_DOCX_FALLBACK")
        segs, images, footnotes, notes = docx_mammoth(o["path"])
    except Exception as exc:  # noqa: BLE001
        first = f"{type(exc).__name__}: {exc}"
        try:
            segs = docx_fallback(o["path"])
            images, footnotes = {}, {}
            notes = ["Numbering: labels unavailable (python-docx fallback)"]
        except Exception as exc2:  # noqa: BLE001
            raise RuntimeError(f"mammoth failed: {first}; python-docx failed: {type(exc2).__name__}: {exc2}") from exc2
        engine, degraded, reason = "python-docx", True, f"mammoth {first}"
    import docx
    explicit = count_explicit_breaks(docx.Document(o["path"]).element.body)
    page_count = len(segs)
    pages = o.get("pages")
    if pages is not None and explicit == 0:
        raise UserError(DOCX_NO_BREAKS, page_count)
    selected = check_pages(pages, page_count, "segments")
    try:
        md = assemble_docx(segs, selected, images, footnotes, staging, pages is None)
    except Exception:
        for n in selected:
            shutil.rmtree(os.path.join(staging, f"p{n}"), ignore_errors=True)
        raise
    return {"markdown": md + "\n", "pages": selected, "pageCount": page_count, "explicitBreaks": explicit,
            "engine": engine, "degraded": degraded, "fallbackReason": reason, "emptyPages": [], "failedPages": [], "notes": notes}


def mode_info_docx(o):
    import docx
    document = docx.Document(o["path"])
    body = document.element.body
    explicit = count_explicit_breaks(body)
    seg, toc, filled = 1, [], [False]
    for kind, value, lvl in docx_body_events(document):
        if kind == "break":
            seg += 1
            filled.append(False)
        elif kind == "table":
            filled[-1] = True
        else:
            text, image = value
            text = text.strip()
            if text or image:
                filled[-1] = True
            if text and lvl:
                toc.append([lvl, text, seg if explicit else None])
    page_count = seg - (1 if seg > 1 and not filled[-1] else 0)
    cp = document.core_properties
    meta = {k: v for k, v in (("title", cp.title), ("author", cp.author)) if v}
    for k in ("created", "modified"):
        v = getattr(cp, k)
        if v is not None:
            meta[k] = v.isoformat()
    return {"pageCount": page_count, "explicitBreaks": explicit, "metadata": meta, "toc": toc}


def preview_note(truncated):
    if not truncated:
        return None
    parts = [f"{esc(t)} ({r_lim} of {R} rows" + (f", {c_lim} of {C} columns" if c_lim < C else "") + ")"
             for t, R, C, r_lim, c_lim, _ in truncated]
    return "preview truncated: " + "; ".join(parts) + "; full data: " + ", ".join(rel for *_, rel in truncated)


def mode_xlsx(o):
    path, staging, csv_dir = o["path"], o["stagingDir"], o["sheetsStagingDir"]
    if path.lower().endswith(".xls"):
        return mode_xls(o)
    import openpyxl
    from openpyxl.chartsheet import Chartsheet
    wb_f = openpyxl.load_workbook(path, data_only=False)
    wb_v = openpyxl.load_workbook(path, data_only=True)
    stem = os.path.splitext(os.path.basename(path))[0]
    notes, images, sheets, render, inv, sections = [], [], [], [], [], []
    truncated = []
    for idx, ws in enumerate(wb_f._sheets):
        hidden = ws.sheet_state != "visible"
        charts = list(getattr(ws, "_charts", []) or [])
        if isinstance(ws, Chartsheet):
            lines = [f"## {esc(ws.title)} (chartsheet)"]
            if charts:
                lines += ["Charts:"] + [chart_line(ch) for ch in charts]
                render.append(idx)
                lines.append(f"<!--rv:{idx}-->")
            inv.append(inv_row(idx, ws.title, "chartsheet", "-", hidden, len(charts), 0, f"<!--rvs:{idx}-->" if charts else "-", "-"))
            sheets.append(sheet_info(idx, ws.title, "chartsheet", hidden, None, None, 0, 0, len(charts), 0, None))
            sections.append("\n".join(lines))
            continue
        wv = wb_v[ws.title]
        raw_r, raw_c = ws.max_row, ws.max_column
        cells, formulas, R, C = [], 0, 0, 0
        profiles = [ColProfile() for _ in range(raw_c)]
        for r, (fr, vr) in enumerate(zip(ws.iter_rows(min_row=1, max_row=raw_r, max_col=raw_c),
                                         wv.iter_rows(min_row=1, max_row=raw_r, max_col=raw_c)), 1):
            row = []
            for c, (fc, vc) in enumerate(zip(fr, vr), 1):
                src, val = fc.value, vc.value
                if src is not None:
                    R, C = r, max(C, c)
                    if is_formula(src):
                        formulas += 1
                        profiles[c - 1].add("formula" if val is None else cell_class(val), val)
                    else:
                        profiles[c - 1].add(cell_class(src), src)
                row.append((src, val))
            cells.append(row)
        lines = [f"## {esc(ws.title)}"]
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
        csv_rel = write_csv(idx, ws.title, cells, R, C, csv_dir)
        lines.append(data_line(R, C, csv_rel, formulas))
        if charts:
            lines += ["Charts:"] + [chart_line(ch) for ch in charts]
        raw_images = list(getattr(ws, "_images", []) or [])
        img_lines = []
        for i, img in enumerate(raw_images, 1):
            try:
                fmt = (getattr(img, "format", None) or "png").lower()
                name = f"s{idx}-{i}.{fmt}"
                data = img._data() if callable(getattr(img, "_data", None)) else img.ref.getvalue()
                with open(os.path.join(staging, name), "wb") as fh:
                    fh.write(data)
                images.append({"sheetIndex": idx, "file": name})
                img_lines.append(f"- ![{esc(ws.title)} image {i}]({name})")
            except Exception as exc:  # noqa: BLE001
                notes.append(f"sheet {ws.title}: image {i} not extracted ({type(exc).__name__})")
        if img_lines:
            lines += ["Images:"] + img_lines
        visual = bool(charts or raw_images)
        if visual:
            render.append(idx)
            lines.append(f"<!--rv:{idx}-->")
        if R:
            continuation = set()
            for rng in ws.merged_cells.ranges:
                for r in range(rng.min_row, rng.max_row + 1):
                    for c in range(rng.min_col, rng.max_col + 1):
                        if (r, c) != (rng.min_row, rng.min_col):
                            continuation.add((r, c))
            r_lim, c_lim = preview_and_profile(lines, cells, profiles, R, C, continuation)
            if r_lim < R or c_lim < C:
                truncated.append((ws.title, R, C, r_lim, c_lim, csv_rel))
        inv.append(inv_row(idx, ws.title, "worksheet", f"{R} x {C}", hidden, len(charts), len(raw_images),
                           f"<!--rvs:{idx}-->" if visual else "-", f"[{csv_rel}]({csv_rel})" if csv_rel else "-"))
        sheets.append(sheet_info(idx, ws.title, "worksheet", hidden, R, C, len(hr), len(hc), len(charts), len(raw_images), csv_rel))
        sections.append("\n".join(lines))
    if note := preview_note(truncated):
        notes.insert(0, note)
    if path.lower().endswith(".xlsm"):
        notes.append("macros ignored (VBA project not converted)")
    md = f"# {esc(stem)}\n\n## Sheets\n" + INV_HEADER + "\n".join(inv) + "\n\n" + "\n\n".join(sections) + "\n"
    return {"markdown": md, "images": images, "notes": notes, "sheets": sheets, "renderPages": render, "sheetCount": len(wb_f._sheets)}

def mode_xls(o):
    import xlrd
    path, csv_dir = o["path"], o["sheetsStagingDir"]
    book = xlrd.open_workbook(path, formatting_info=True, logfile=sys.stderr)
    stem = os.path.splitext(os.path.basename(path))[0]
    sheets, inv, sections, truncated = [], [], [], []
    for idx in range(book.nsheets):
        sh = book.sheet_by_index(idx)
        hidden = sh.visibility != 0
        cells, R, C = [], 0, 0
        profiles = [ColProfile() for _ in range(sh.ncols)]
        for r in range(sh.nrows):
            row = []
            for c in range(sh.ncols):
                cell = sh.cell(r, c)
                v = cell.value
                if cell.ctype == xlrd.XL_CELL_DATE:
                    v = xlrd.xldate_as_datetime(v, book.datemode)
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    v = bool(v)
                elif cell.ctype == xlrd.XL_CELL_ERROR:
                    v = xlrd.error_text_from_code.get(int(v), f"#ERR{int(v)}")
                elif cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                    v = None
                if v is not None:
                    R, C = r + 1, max(C, c + 1)
                    profiles[c].add(cell_class(v), v)
                row.append((v, v))
            cells.append(row)
        lines = [f"## {esc(sh.name)}", "Formulas: unavailable (.xls via xlrd); Images: unavailable"]
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
        csv_rel = write_csv(idx, sh.name, cells, R, C, csv_dir)
        lines.append(data_line(R, C, csv_rel, 0))
        if R:
            continuation = {(r + 1, c + 1) for r0, r1, c0, c1 in sh.merged_cells for r in range(r0, r1) for c in range(c0, c1) if (r, c) != (r0, c0)}
            r_lim, c_lim = preview_and_profile(lines, cells, profiles, R, C, continuation)
            if r_lim < R or c_lim < C:
                truncated.append((sh.name, R, C, r_lim, c_lim, csv_rel))
        inv.append(inv_row(idx, sh.name, "worksheet", f"{R} x {C}", hidden, 0, 0, "-", f"[{csv_rel}]({csv_rel})" if csv_rel else "-"))
        sheets.append(sheet_info(idx, sh.name, "worksheet", hidden, R, C, len(hr), len(hc), 0, 0, csv_rel))
        sections.append("\n".join(lines))
    md = f"# {esc(stem)}\n\n## Sheets\n" + INV_HEADER + "\n".join(inv) + "\n\n" + XLS_NOTE + "\n\n" + "\n\n".join(sections) + "\n"
    note = preview_note(truncated)
    return {"markdown": md, "images": [], "notes": ([note] if note else []) + [XLS_NOTE], "sheets": sheets, "renderPages": [], "sheetCount": book.nsheets}

def mode_info_excel(o):
    path = o["path"]
    sheets = []
    if path.lower().endswith(".xls"):
        import xlrd
        book = xlrd.open_workbook(path, formatting_info=True, logfile=sys.stderr)
        for idx in range(book.nsheets):
            sh = book.sheet_by_index(idx)
            sheets.append(sheet_info(idx, sh.name, "worksheet", sh.visibility != 0, sh.nrows, sh.ncols,
                                     sum(1 for i in sh.rowinfo_map.values() if i.hidden), sum(1 for i in sh.colinfo_map.values() if i.hidden), 0, 0, None))
    else:
        import openpyxl
        from openpyxl.chartsheet import Chartsheet
        wb = openpyxl.load_workbook(path, data_only=True)
        for idx, ws in enumerate(wb._sheets):
            hidden = ws.sheet_state != "visible"
            charts = len(getattr(ws, "_charts", []) or [])
            if isinstance(ws, Chartsheet):
                sheets.append(sheet_info(idx, ws.title, "chartsheet", hidden, None, None, 0, 0, charts, 0, None))
                continue
            hc = sum(d.max - d.min + 1 for d in ws.column_dimensions.values() if d.hidden)
            hr = sum(1 for d in ws.row_dimensions.values() if d.hidden)
            sheets.append(sheet_info(idx, ws.title, "worksheet", hidden, ws.max_row, ws.max_column, hr, hc, charts, len(getattr(ws, "_images", []) or []), None))
    return {"sheets": sheets}

def mode_render_pages(o):
    import pymupdf
    doc = pymupdf.open(o["path"])
    expected = o["expectedPages"]
    if doc.page_count != expected:
        return {"ok": False, "reason": f"page-count mismatch ({doc.page_count} vs {expected})"}
    fmt, dpi, staging = o["imageFormat"], o["imageDpi"], o["stagingDir"]
    rendered, failed = [], []
    for idx in o["sheetIndices"]:
        try:
            page = doc[idx]
            w, h = page.rect.width, page.rect.height
            if w < MIN_PAGE_PT or h < MIN_PAGE_PT:
                failed.append({"idx": idx, "reason": f"rendered view degenerate (page {w:.0f} x {h:.0f} pt)"})
                continue
            eff = clamped_dpi(w, h, dpi)
            if eff is None:
                failed.append({"idx": idx, "reason": f"rendered view too large (page {w:.0f} x {h:.0f} pt)"})
                continue
            name = f"s{idx}.{fmt}"
            page.get_pixmap(dpi=eff).save(os.path.join(staging, name))
            rendered.append({"idx": idx, "file": name, "dpi": eff})
        except Exception as exc:  # noqa: BLE001
            failed.append({"idx": idx, "reason": f"render failed: {type(exc).__name__}: {exc}"[:300]})
    return {"ok": True, "rendered": rendered, "failed": failed}


MODES = {"info": None, "pdf-primary": mode_pdf_primary, "pdf-fallback": mode_pdf_fallback, "xlsx": mode_xlsx, "render-pages": mode_render_pages, "docx": mode_docx, "html": mode_html, "image": mode_image, "email": mode_email, "ocr-pages": mode_ocr_pages}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in MODES:
        print("usage: doc_to_md.py <info|pdf-primary|pdf-fallback|xlsx|render-pages|docx|html|image|email|ocr-pages>  (options JSON on stdin)", file=sys.stderr)
        return 1
    mode = sys.argv[1]
    o = json.loads(sys.stdin.read() or "{}")
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with contextlib.redirect_stdout(sys.stderr):
                if mode == "info":
                    lower = o["path"].lower()
                    if lower.endswith((".xlsx", ".xlsm", ".xls")):
                        result = mode_info_excel(o)
                    elif lower.endswith(".docx"):
                        result = mode_info_docx(o)
                    else:
                        result = mode_info(o)
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
