"""Compute Word list labels in body paragraph order; unsupported labels raise Unsupported."""

import re
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
FORMATS = {"decimal", "decimalZero", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "bullet", "none"}
PLACEHOLDER = re.compile(r"%(\d)")


class Unsupported(Exception):
    pass


def _val(el, tag, default=None):
    c = el.find(W + tag)
    return default if c is None else c.get(W + "val", default)


def _roman(n):
    if n < 1:
        raise Unsupported(f"roman counter {n}")
    out = ""
    for v, s in [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]:
        while n >= v:
            out, n = out + s, n - v
    return out


def _letters(n):
    if n < 1:
        raise Unsupported(f"letter counter {n}")
    out = ""
    while n:
        n, remainder = divmod(n - 1, 26)
        out = chr(ord("A") + remainder) + out
    return out


def fmt_number(n, fmt):
    if fmt == "decimal": return str(n)
    if fmt == "decimalZero": return f"{n:02d}"
    if fmt == "upperLetter": return _letters(n)
    if fmt == "lowerLetter": return _letters(n).lower()
    if fmt == "upperRoman": return _roman(n)
    if fmt == "lowerRoman": return _roman(n).lower()
    raise Unsupported(f"numFmt {fmt}")


def _read(zf, name):
    try:
        return ET.fromstring(zf.read(name))
    except KeyError:
        return None


def _levels(lvls):
    out = {}
    for lvl in lvls:
        i = int(lvl.get(W + "ilvl"))
        fmt = _val(lvl, "numFmt", "decimal")
        if fmt not in FORMATS: raise Unsupported(f"numFmt {fmt}")
        text = _val(lvl, "lvlText", "")
        if fmt not in ("bullet", "none") and not PLACEHOLDER.search(text):
            raise Unsupported(f"lvlText {text!r} has no %n")
        restart = _val(lvl, "lvlRestart")
        out[i] = {"fmt": fmt, "text": text, "start": int(_val(lvl, "start", "1")),
                  "restart": None if restart is None else int(restart),
                  "legal": lvl.find(W + "isLgl") is not None, "pstyle": _val(lvl, "pStyle")}
    return out


def _definitions(numbering):
    abstracts = {a.get(W + "abstractNumId"): _levels(a.findall(W + "lvl")) for a in numbering.findall(W + "abstractNum")}
    nums = {}
    for num in numbering.findall(W + "num"):
        aid = _val(num, "abstractNumId")
        if aid not in abstracts: raise Unsupported(f"missing abstractNum {aid}")
        levels = {i: dict(l) for i, l in abstracts[aid].items()}
        overrides = {}
        for ov in num.findall(W + "lvlOverride"):
            i = int(ov.get(W + "ilvl"))
            full = ov.find(W + "lvl")
            if full is not None: levels.update(_levels([full]))
            so = ov.find(W + "startOverride")
            if so is not None:
                if i not in levels: raise Unsupported(f"override for missing level {i}")
                levels[i]["start"] = int(so.get(W + "val"))
                overrides[i] = levels[i]["start"]
        nums[num.get(W + "numId")] = (aid, levels, overrides)
    return nums


def _styles(root):
    out = {}
    for st in root.findall(W + "style") if root is not None else []:
        ppr = st.find(W + "pPr")
        numpr = ppr.find(W + "numPr") if ppr is not None else None
        out[st.get(W + "styleId")] = {"based": _val(st, "basedOn"),
            "num": None if numpr is None else (_val(numpr, "numId"), int(_val(numpr, "ilvl", "0")))}
    return out


def _paragraph_numbering(p, styles, pstyle_map):
    ppr = p.find(W + "pPr")
    numpr = ppr.find(W + "numPr") if ppr is not None else None
    if numpr is not None:
        nid = _val(numpr, "numId")
        if nid is None: raise Unsupported("numPr without numId")
        if nid == "0": return None
        return nid, int(_val(numpr, "ilvl", "0"))
    sid = _val(ppr, "pStyle") if ppr is not None else None
    original_sid = sid
    seen = set()
    while sid and sid not in seen:
        seen.add(sid)
        st = styles.get(sid)
        if st is None: break
        if st["num"]: return None if st["num"][0] == "0" else st["num"]
        sid = st["based"]
    return pstyle_map.get(original_sid)


def _render(levels, counters, i):
    lvl = levels[i]
    if lvl["fmt"] in ("bullet", "none"): return "-"
    def sub(match):
        k = int(match.group(1)) - 1
        if k not in levels: raise Unsupported(f"undefined level {k + 1}")
        return fmt_number(counters[k], "decimal" if lvl["legal"] else levels[k]["fmt"])
    return PLACEHOLDER.sub(sub, lvl["text"])


def compute_labels(path):
    with zipfile.ZipFile(path) as zf:
        doc = _read(zf, "word/document.xml")
        numbering = _read(zf, "word/numbering.xml")
        styles = _read(zf, "word/styles.xml")
    nums = _definitions(numbering) if numbering is not None else {}
    styles = _styles(styles)
    pstyle_map = {}
    for nid, (_, levels, _) in nums.items():
        for i, lvl in levels.items():
            if lvl["pstyle"]:
                pstyle_map.setdefault(lvl["pstyle"], (nid, i))
    counters = {}
    seen_nums = set()
    out = []
    for p in doc.find(W + "body").iter(W + "p"):
        ref = _paragraph_numbering(p, styles, pstyle_map)
        if ref is None:
            out.append(None)
            continue
        nid, i = ref
        if nid not in nums: raise Unsupported(f"numId {nid} has no definition")
        aid, levels, overrides = nums[nid]
        if i not in levels: raise Unsupported(f"numId {nid} has no level {i}")
        c = counters.setdefault(aid, {k: l["start"] - 1 for k, l in levels.items()})
        for k, lvl in levels.items():
            c.setdefault(k, lvl["start"] - 1)
        if nid not in seen_nums:
            for k, start in overrides.items():
                c[k] = start - 1
            seen_nums.add(nid)
        c[i] += 1
        for d in levels:
            if d > i and (levels[d]["restart"] is None or i < levels[d]["restart"]):
                c[d] = levels[d]["start"] - 1
        out.append(_render(levels, c, i))
    return out
