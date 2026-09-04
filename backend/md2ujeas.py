"""
md2ujeas.py — render the submission draft as a UJEAS-shaped .docx.

Not a general markdown converter. It knows this one document, and it knows the
journal's constraints: Times New Roman 10 pt, double column, single line
spacing, page numbers on every page, headings numbered and not underlined,
table captions above the table.

Two layout rules need section breaks rather than paragraph formatting, because
Word applies column count per section:

  * the title block spans both columns, so it is its own single-column section
  * a table wider than four columns cannot fit an 8 cm column, so each one is
    wrapped in a single-column section and the body resumes in two afterwards

Everything after "Reference corrections and cautions" is working notes for the
author, not manuscript. It is pushed onto a fresh page behind a heading that
says to delete it, so it cannot be submitted by accident.

    python md2ujeas.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Cm, RGBColor

PAPERS = Path(r"C:\Users\Admin\Downloads\CONCARETTI PAPERS")
SRC = PAPERS / "CONCARETTI - UJEAS submission draft.md"
OUT = PAPERS / "CONCARETTI - UJEAS submission draft.docx"

BODY_PT = 10
FONT = "Times New Roman"
WIDE_TABLE_COLS = 5          # 5+ columns goes full width
NOTES_MARKER = "Reference corrections and cautions"


# --------------------------------------------------------------------------- #
# section plumbing
# --------------------------------------------------------------------------- #

def set_columns(section, n: int, space_twips: int = 360) -> None:
    """Column count is a section property, not a paragraph one."""
    sectPr = section._sectPr
    cols = sectPr.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        sectPr.append(cols)
    cols.set(qn("w:num"), str(n))
    cols.set(qn("w:space"), str(space_twips))
    cols.set(qn("w:equalWidth"), "1")


def add_page_numbers(section) -> None:
    """PAGE field, centred in the footer. UJEAS wants every page numbered."""
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for r in list(p.runs):
        r._element.getparent().remove(r._element)

    run = p.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)
    run.font.name = FONT
    run.font.size = Pt(9)


def new_section(doc, ncols: int):
    s = doc.add_section(WD_SECTION.CONTINUOUS)
    set_columns(s, ncols)
    s.footer.is_linked_to_previous = True
    return s


# --------------------------------------------------------------------------- #
# inline formatting
# --------------------------------------------------------------------------- #

TOKEN = re.compile(r"(\*\*.+?\*\*|\*[^*]+?\*|`[^`]+?`)", re.DOTALL)


def add_runs(par, text: str, base_italic: bool = False) -> None:
    """Split on **bold**, *italic* and `code`, keeping order."""
    text = text.replace("\\_", "_")
    for chunk in TOKEN.split(text):
        if not chunk:
            continue
        if chunk.startswith("**") and chunk.endswith("**") and len(chunk) > 4:
            r = par.add_run(chunk[2:-2])
            r.bold = True
        elif chunk.startswith("*") and chunk.endswith("*") and len(chunk) > 2:
            r = par.add_run(chunk[1:-1])
            r.italic = True
        elif chunk.startswith("`") and chunk.endswith("`") and len(chunk) > 2:
            r = par.add_run(chunk[1:-1])
            r.font.name = "Consolas"
            r.font.size = Pt(BODY_PT - 1)
        else:
            r = par.add_run(chunk)
        r.font.name = r.font.name or FONT
        if r.font.size is None:
            r.font.size = Pt(BODY_PT)
        if base_italic:
            r.italic = True


def para(doc, text="", *, style=None, align=None, italic=False,
         space_after=4, space_before=0, first_line=None, hanging=None,
         size=None, bold_all=False, keep_next=False):
    p = doc.add_paragraph(style=style)
    pf = p.paragraph_format
    pf.space_after = Pt(space_after)
    pf.space_before = Pt(space_before)
    pf.line_spacing = 1.0
    if align is not None:
        p.alignment = align
    if first_line is not None:
        pf.first_line_indent = Cm(first_line)
    if hanging is not None:
        pf.left_indent = Cm(hanging)
        pf.first_line_indent = Cm(-hanging)
    if keep_next:
        pf.keep_with_next = True
    if text:
        add_runs(p, text, base_italic=italic)
        for r in p.runs:
            if size:
                r.font.size = Pt(size)
            if bold_all:
                r.bold = True
    return p


# --------------------------------------------------------------------------- #
# tables
# --------------------------------------------------------------------------- #

def split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def is_divider(line: str) -> bool:
    return bool(re.fullmatch(r"\|[\s:|-]+\|", line.strip()))


def add_table(doc, rows: list[list[str]]) -> None:
    ncols = max(len(r) for r in rows)
    t = doc.add_table(rows=0, cols=ncols)
    t.style = "Table Grid"
    t.autofit = True
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for ci in range(ncols):
            txt = row[ci] if ci < len(row) else ""
            cell = cells[ci]
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.line_spacing = 1.0
            add_runs(p, txt)
            for r in p.runs:
                r.font.size = Pt(BODY_PT - 2)
                if ri == 0:
                    r.bold = True
    para(doc, "", space_after=6)


# --------------------------------------------------------------------------- #
# document
# --------------------------------------------------------------------------- #

def build() -> None:
    if not SRC.exists():
        sys.exit(f"missing source: {SRC}")

    lines = SRC.read_text(encoding="utf-8").split("\n")

    doc = Document()

    normal = doc.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(BODY_PT)
    normal.font.color.rgb = RGBColor(0, 0, 0)
    normal.paragraph_format.line_spacing = 1.0
    normal.paragraph_format.space_after = Pt(4)
    rpr = normal.element.get_or_add_rPr().get_or_add_rFonts()
    rpr.set(qn("w:eastAsia"), FONT)

    for name, size, bold in (("Heading 1", 11, True),
                             ("Heading 2", 10, True),
                             ("Heading 3", 10, True)):
        st = doc.styles[name]
        st.font.name = FONT
        st.font.size = Pt(size)
        st.font.bold = bold
        st.font.italic = (name == "Heading 3")
        st.font.underline = False           # UJEAS: headings not underlined
        st.font.color.rgb = RGBColor(0, 0, 0)
        st.paragraph_format.space_before = Pt(8)
        st.paragraph_format.space_after = Pt(3)
        st.paragraph_format.line_spacing = 1.0
        st.paragraph_format.keep_with_next = True

    s0 = doc.sections[0]
    s0.left_margin = s0.right_margin = Cm(2.0)
    s0.top_margin = s0.bottom_margin = Cm(2.2)
    set_columns(s0, 1)                      # title block spans both columns
    add_page_numbers(s0)

    ncols = 1
    in_notes = False
    i = 0
    n = len(lines)
    first_heading_seen = False

    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # ---- table block -------------------------------------------------- #
        if stripped.startswith("|") and stripped.endswith("|"):
            block = []
            while i < n and lines[i].strip().startswith("|"):
                if not is_divider(lines[i]):
                    block.append(split_row(lines[i]))
                i += 1
            if block:
                wide = max(len(r) for r in block) >= WIDE_TABLE_COLS
                if wide and ncols != 1 and not in_notes:
                    new_section(doc, 1)
                    add_table(doc, block)
                    new_section(doc, 2)
                    ncols = 2
                else:
                    add_table(doc, block)
            continue

        i += 1

        if not stripped or stripped in {"---", "***"}:
            continue

        # ---- headings ----------------------------------------------------- #
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped[level:].strip()

            if level == 1:
                p = para(doc, text.upper(), align=WD_ALIGN_PARAGRAPH.CENTER,
                         size=14, bold_all=True, space_after=8)
                continue

            if NOTES_MARKER.lower() in text.lower():
                in_notes = True
                brk = doc.add_paragraph()
                brk.add_run().add_break(WD_BREAK.PAGE)
                new_section(doc, 1)
                ncols = 1
                para(doc,
                     "AUTHOR WORKING NOTES — NOT PART OF THE MANUSCRIPT. "
                     "DELETE EVERYTHING FROM THIS PAGE ONWARD BEFORE SUBMISSION.",
                     bold_all=True, align=WD_ALIGN_PARAGRAPH.CENTER,
                     space_after=10)

            # first body heading is where the two-column body starts
            if not first_heading_seen and not in_notes and text.lower().startswith("abstract"):
                first_heading_seen = True

            doc.add_heading(text, level=min(level - 1, 3) if level > 1 else 1)
            last = doc.paragraphs[-1]
            for r in last.runs:
                r.font.name = FONT
                r.font.underline = False
                r.font.color.rgb = RGBColor(0, 0, 0)

            # after keywords, switch the body to double column
            continue

        # ---- blockquote --------------------------------------------------- #
        if stripped.startswith(">"):
            text = stripped.lstrip(">").strip()
            if text:
                para(doc, text, hanging=0.5, size=BODY_PT - 1, italic=False,
                     space_after=3)
            continue

        # ---- bullets ------------------------------------------------------ #
        if re.match(r"^[-*]\s+", stripped):
            para(doc, "\u2022  " + re.sub(r"^[-*]\s+", "", stripped),
                 hanging=0.45, space_after=2)
            continue

        # ---- numbered list ------------------------------------------------ #
        m = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if m:
            para(doc, f"{m.group(1)}.  {m.group(2)}", hanging=0.5, space_after=2)
            continue

        # ---- reference entries get a hanging indent ----------------------- #
        if re.match(r"^[A-ZÀ-Ý][A-Za-zÀ-ÿ'’\-]+,\s+[A-Z]\.", stripped) and "(" in stripped:
            para(doc, stripped, hanging=0.6, space_after=3, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
            continue

        # ---- ordinary paragraph ------------------------------------------- #
        para(doc, stripped, align=WD_ALIGN_PARAGRAPH.JUSTIFY, space_after=4)

        # switch to two columns once the keyword line is behind us
        if ncols == 1 and not in_notes and stripped.startswith("*(Exactly five"):
            new_section(doc, 2)
            ncols = 2

    doc.save(OUT)
    print(f"wrote {OUT}")
    print(f"{OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    build()
