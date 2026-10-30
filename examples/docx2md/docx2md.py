#!/usr/bin/env python3
"""Convert a .docx file to Markdown using only the standard library.

Handles: headings, bold/italic/strikethrough, inline code (monospace fonts),
hyperlinks, bulleted and numbered lists (with nesting), tables, line breaks,
footnotes, and images (extracted to a media folder next to the output).

Usage:
    python3 docx2md.py input.docx                # writes input.md
    python3 docx2md.py input.docx -o out.md      # explicit output path
    python3 docx2md.py input.docx -o -           # print to stdout
    python3 docx2md.py *.docx                    # batch convert
"""

import argparse
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "v": "urn:schemas-microsoft-com:vml",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
MONO_FONTS = {"courier", "courier new", "consolas", "menlo", "monaco",
              "lucida console", "source code pro", "fira code", "dejavu sans mono"}


def w(tag):
    return f"{{{NS['w']}}}{tag}"


def attr(el, name, ns="w"):
    return el.get(f"{{{NS[ns]}}}{name}") if el is not None else None


def escape_md(text):
    # Escape characters that would otherwise be read as Markdown syntax.
    return re.sub(r"([\\`*_\[\]<>|])", r"\\\1", text)


class DocxConverter:
    def __init__(self, path, media_dir=None, media_prefix=""):
        self.zip = zipfile.ZipFile(path)
        self.media_dir = media_dir
        self.media_prefix = media_prefix
        self.rels = self._load_rels("word/_rels/document.xml.rels")
        self.styles = self._load_styles()
        self.numbering = self._load_numbering()
        self.footnotes = self._load_footnotes()
        self.used_footnotes = []
        self.list_counters = {}

    # ---------- loading ----------

    def _xml(self, name):
        try:
            return ET.fromstring(self.zip.read(name))
        except KeyError:
            return None

    def _load_rels(self, name):
        root = self._xml(name)
        rels = {}
        if root is not None:
            for rel in root.findall("rel:Relationship", NS):
                rels[rel.get("Id")] = (rel.get("Target"), rel.get("TargetMode"))
        return rels

    def _load_styles(self):
        """Map styleId -> (heading level or None, is_code_style)."""
        styles = {}
        root = self._xml("word/styles.xml")
        if root is None:
            return styles
        for s in root.findall("w:style", NS):
            sid = attr(s, "styleId")
            name = (attr(s.find("w:name", NS), "val") or sid or "").lower()
            level = None
            m = re.match(r"heading\s*(\d)", name)
            if m:
                level = int(m.group(1))
            elif name == "title":
                level = 1
            elif name == "subtitle":
                level = 2
            outline = s.find("w:pPr/w:outlineLvl", NS)
            if level is None and outline is not None:
                lvl = int(attr(outline, "val"))
                if lvl < 9:
                    level = lvl + 1
            is_code = any(k in name for k in ("code", "source", "preformatted", "html pre"))
            is_quote = "quote" in name
            styles[sid] = {"heading": level, "code": is_code, "quote": is_quote,
                           "list": "list bullet" in name and "bullet"
                           or "list number" in name and "number",
                           "list_level": int(name[-1]) - 1 if name[-1:].isdigit() else 0}
        return styles

    def _load_numbering(self):
        """Map numId -> {ilvl: 'bullet'|'number'}."""
        root = self._xml("word/numbering.xml")
        if root is None:
            return {}
        abstract = {}
        for an in root.findall("w:abstractNum", NS):
            levels = {}
            for lvl in an.findall("w:lvl", NS):
                fmt = attr(lvl.find("w:numFmt", NS), "val") or "bullet"
                levels[int(attr(lvl, "ilvl"))] = "bullet" if fmt in ("bullet", "none") else "number"
            abstract[attr(an, "abstractNumId")] = levels
        nums = {}
        for num in root.findall("w:num", NS):
            aid = attr(num.find("w:abstractNumId", NS), "val")
            nums[attr(num, "numId")] = abstract.get(aid, {})
        return nums

    def _load_footnotes(self):
        root = self._xml("word/footnotes.xml")
        notes = {}
        if root is not None:
            for fn in root.findall("w:footnote", NS):
                fid = attr(fn, "id")
                if attr(fn, "type") in ("separator", "continuationSeparator"):
                    continue
                text = " ".join(filter(None, (self.paragraph_text(p)
                                              for p in fn.findall("w:p", NS))))
                notes[fid] = text.strip()
        return notes

    # ---------- inline content ----------

    def run_props(self, run):
        rpr = run.find("w:rPr", NS)
        props = {"b": False, "i": False, "s": False, "code": False}
        if rpr is None:
            return props

        def on(tag):
            el = rpr.find(f"w:{tag}", NS)
            return el is not None and attr(el, "val") not in ("0", "false", "none")

        props["b"] = on("b")
        props["i"] = on("i")
        props["s"] = on("strike") or on("dstrike")
        fonts = rpr.find("w:rFonts", NS)
        if fonts is not None:
            font = (attr(fonts, "ascii") or attr(fonts, "hAnsi") or "").lower()
            props["code"] = font in MONO_FONTS
        style = attr(rpr.find("w:rStyle", NS), "val")
        if style and ("code" in style.lower() or "verbatim" in style.lower()):
            props["code"] = True
        return props

    def run_text(self, run, raw=False):
        parts = []
        for child in run:
            tag = child.tag
            if tag == w("t"):
                parts.append(child.text or "" if raw else escape_md(child.text or ""))
            elif tag == w("tab"):
                parts.append("\t")
            elif tag in (w("br"), w("cr")):
                parts.append("\n" if raw else "  \n")
            elif tag == w("footnoteReference"):
                fid = attr(child, "id")
                if fid in self.footnotes:
                    if fid not in self.used_footnotes:
                        self.used_footnotes.append(fid)
                    parts.append(f"[^{self.used_footnotes.index(fid) + 1}]")
            elif tag == w("drawing") or tag == w("pict"):
                parts.append(self.image(child))
        return "".join(parts)

    def image(self, el):
        blip = el.find(".//a:blip", NS)
        rid = attr(blip, "embed", "r") if blip is not None else None
        if rid is None:
            imagedata = el.find(".//v:imagedata", NS)
            rid = attr(imagedata, "id", "r") if imagedata is not None else None
        if rid is None or rid not in self.rels:
            return ""
        target = self.rels[rid][0]
        docpr = el.find(".//wp:docPr", NS)
        alt = (docpr.get("descr") or docpr.get("title") or "") if docpr is not None else ""
        src = posixpath.normpath(posixpath.join("word", target))
        name = posixpath.basename(src)
        if self.media_dir is not None:
            try:
                data = self.zip.read(src)
                self.media_dir.mkdir(parents=True, exist_ok=True)
                (self.media_dir / name).write_bytes(data)
            except KeyError:
                pass
        return f"![{escape_md(alt)}]({self.media_prefix}{name})"

    def inline(self, parent, in_code_block=False):
        """Render the runs/hyperlinks of a paragraph into Markdown."""
        segments = []  # list of (text, props)
        for child in parent:
            if child.tag == w("r"):
                segments.append((self.run_text(child, raw=in_code_block),
                                 self.run_props(child)))
            elif child.tag == w("hyperlink"):
                text = self.inline(child, in_code_block)
                rid = attr(child, "id", "r")
                anchor = attr(child, "anchor")
                href = self.rels.get(rid, (None,))[0] if rid else (f"#{anchor}" if anchor else None)
                link = f"[{text}]({href})" if href and text else text
                segments.append((link, None))
            elif child.tag in (w("ins"), w("smartTag"), w("sdt"), w("sdtContent"),
                               w("fldSimple")):
                segments.append((self.inline(child, in_code_block), None))
        if in_code_block:
            return "".join(t for t, _ in segments)
        return self._merge_formatting(segments)

    @staticmethod
    def _merge_formatting(segments):
        """Join adjacent runs with identical formatting before wrapping in markers,
        so 'Hello' + ' world' (both bold) becomes **Hello world**, not **Hello** **world**."""
        merged = []
        for text, props in segments:
            if merged and props is not None and merged[-1][1] == props:
                merged[-1] = (merged[-1][0] + text, props)
            else:
                merged.append((text, props))
        out = []
        for text, props in merged:
            if not props or not text.strip():
                out.append(text)
                continue
            lead = text[: len(text) - len(text.lstrip())]
            trail = text[len(text.rstrip()):]
            core = text.strip()
            if props["code"]:
                core = "`" + core.replace("\\", "") + "`"
            else:
                if props["s"]:
                    core = f"~~{core}~~"
                if props["i"]:
                    core = f"*{core}*"
                if props["b"]:
                    core = f"**{core}**"
            out.append(lead + core + trail)
        return "".join(out)

    def paragraph_text(self, p):
        return self.inline(p)

    # ---------- blocks ----------

    def paragraph_info(self, p):
        ppr = p.find("w:pPr", NS)
        style_id = attr(ppr.find("w:pStyle", NS), "val") if ppr is not None else None
        style = self.styles.get(style_id, {})
        info = {"heading": style.get("heading"), "code": style.get("code", False),
                "quote": style.get("quote", False), "list": None, "level": 0}
        if ppr is not None:
            outline = ppr.find("w:outlineLvl", NS)
            if info["heading"] is None and outline is not None and int(attr(outline, "val")) < 9:
                info["heading"] = int(attr(outline, "val")) + 1
            numpr = ppr.find("w:numPr", NS)
            if numpr is not None:
                num_id = attr(numpr.find("w:numId", NS), "val")
                ilvl = int(attr(numpr.find("w:ilvl", NS), "val") or 0)
                if num_id and num_id != "0":
                    kind = self.numbering.get(num_id, {}).get(ilvl, "bullet")
                    info.update(list=kind, level=ilvl, num_id=num_id)
        if info["list"] is None and style.get("list"):
            info.update(list=style["list"], level=style["list_level"],
                        num_id=f"style:{style['list']}")
        return info

    def table(self, tbl):
        rows = []
        for tr in tbl.findall("w:tr", NS):
            cells = []
            for tc in tr.findall("w:tc", NS):
                text = "<br>".join(filter(None, (self.paragraph_text(p).strip()
                                                 for p in tc.findall(".//w:p", NS))))
                cells.append(text.replace("\n", " ").replace("|", "\\|"))
                span = attr(tc.find("w:tcPr/w:gridSpan", NS), "val")
                cells.extend([""] * (int(span) - 1 if span else 0))
            rows.append(cells)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(rows[0]) + " |",
                 "|" + "|".join([" --- "] * width) + "|"]
        lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n".join(lines)

    def convert(self):
        body = self._xml("word/document.xml").find("w:body", NS)
        blocks = []  # (kind, text) where kind groups consecutive lines
        for el in self._iter_blocks(body):
            if el.tag == w("tbl"):
                blocks.append(("table", self.table(el)))
                self.list_counters.clear()
                continue
            info = self.paragraph_info(el)
            if info["code"]:
                blocks.append(("code", self.inline(el, in_code_block=True)))
                continue
            text = self.paragraph_text(el).strip()
            if not text:
                if info["list"] is None:
                    self.list_counters.clear()
                continue
            if info["heading"]:
                blocks.append(("heading", "#" * min(info["heading"], 6) + " " + text))
                self.list_counters.clear()
            elif info["list"]:
                indent = "    " * info["level"]
                if info["list"] == "number":
                    key = (info["num_id"], info["level"])
                    # Reset deeper levels when we return to a shallower one.
                    for k in [k for k in self.list_counters
                              if k[0] == info["num_id"] and k[1] > info["level"]]:
                        del self.list_counters[k]
                    self.list_counters[key] = self.list_counters.get(key, 0) + 1
                    marker = f"{self.list_counters[key]}."
                else:
                    marker = "-"
                blocks.append(("list", f"{indent}{marker} {text}"))
            elif info["quote"]:
                blocks.append(("quote", "> " + text.replace("\n", "\n> ")))
            else:
                blocks.append(("para", text))
                self.list_counters.clear()

        out = []
        prev = None
        for kind, text in blocks:
            if kind == "code":
                if prev == "code":
                    out[-1] = out[-1][:-4] + text + "\n```"
                else:
                    out.append("```\n" + text + "\n```")
            elif kind == "list" and prev == kind and not (
                    text[0] != " " and text[0].isdigit() != out[-1].rsplit("\n", 1)[-1][0].isdigit()):
                out[-1] += "\n" + text
            elif kind == "quote" and prev == kind:
                out[-1] += "\n" + text
            else:
                out.append(text)
            prev = kind

        md = "\n\n".join(out).strip() + "\n"
        if self.used_footnotes:
            md += "\n" + "\n".join(f"[^{i}]: {self.footnotes[fid]}"
                                   for i, fid in enumerate(self.used_footnotes, 1)) + "\n"
        return md

    def _iter_blocks(self, parent):
        """Yield paragraphs and tables in order, descending into content controls."""
        for child in parent:
            if child.tag in (w("p"), w("tbl")):
                yield child
            elif child.tag in (w("sdt"), w("sdtContent"), w("customXml")):
                yield from self._iter_blocks(child)


def convert_file(src, dest, extract_images=True):
    src = Path(src)
    if dest == "-":
        conv = DocxConverter(src)  # images referenced but not extracted
        sys.stdout.write(conv.convert())
        return
    dest = Path(dest) if dest else src.with_suffix(".md")
    media_dir = dest.parent / f"{dest.stem}_media" if extract_images else None
    conv = DocxConverter(src, media_dir, f"{dest.stem}_media/")
    dest.write_text(conv.convert(), encoding="utf-8")
    print(f"{src} -> {dest}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Convert .docx files to Markdown.")
    ap.add_argument("inputs", nargs="+", help=".docx file(s) to convert")
    ap.add_argument("-o", "--output",
                    help="output file ('-' for stdout); only valid with a single input")
    ap.add_argument("--no-images", action="store_true",
                    help="don't extract embedded images")
    args = ap.parse_args()
    if args.output and len(args.inputs) > 1:
        ap.error("-o/--output can only be used with a single input file")
    for path in args.inputs:
        try:
            convert_file(path, args.output, extract_images=not args.no_images)
        except (zipfile.BadZipFile, KeyError, AttributeError) as e:
            print(f"error: {path}: not a valid .docx ({e})", file=sys.stderr)


if __name__ == "__main__":
    main()
