"""
md_to_pdf.py — render the architecture handover markdown as a professional PDF.

Deliberately a small, focused converter rather than a general markdown engine:
it handles exactly the constructs used in docs/VROOMIE_ARCHITECTURE_HANDOVER.md
(headings, paragraphs, bullet/numbered lists, checkboxes, pipe tables, fenced
code blocks, horizontal rules, inline bold/code).

Fonts: registers Arial/Consolas from the Windows font directory so Unicode
arrows, Greek (tau/delta) and box-drawing glyphs render properly. ReportLab's
built-in Type1 fonts lack these and would draw solid black boxes.

Usage: python scripts/md_to_pdf.py <input.md> <output.pdf>
"""
import os
import re
import sys

# Optional CLI overrides: argv[3]=subtitle line, argv[4]=version tag
DOC_SUBTITLE = sys.argv[3] if len(sys.argv) > 3 else "Audio Diagnostics Architecture<br/>&amp; Engineering Handover"
DOC_VERSION = sys.argv[4] if len(sys.argv) > 4 else "v9.7"
DOC_VERSION_LINE = sys.argv[5] if len(sys.argv) > 5 else "Engine version v9.7 &nbsp;·&nbsp; ETHANOL-FEATURE"
DOC_BLURB = sys.argv[6] if len(sys.argv) > 6 else ("Complete technical reference for architects and development "
                                                  "teams extending the Vroomie audio anomaly-detection system")

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, HRFlowable, KeepTogether,
                                NextPageTemplate, PageBreak, PageTemplate,
                                Paragraph, Preformatted, Spacer, Table, TableStyle)

FONT_DIR = r"C:\Windows\Fonts"
BODY, BODY_B, BODY_I, MONO = "Body", "Body-Bold", "Body-Italic", "Mono"

ACCENT = colors.HexColor("#B8860B")     # Vroomie gold
INK = colors.HexColor("#1A1A1A")
MUTED = colors.HexColor("#5A5A5A")
RULE = colors.HexColor("#D8D8D8")
CODE_BG = colors.HexColor("#F4F4F2")
TABLE_HEAD = colors.HexColor("#2B2B2B")


def register_fonts():
    """Register Unicode-capable TTFs; fall back to built-ins if unavailable."""
    try:
        pdfmetrics.registerFont(TTFont(BODY, os.path.join(FONT_DIR, "arial.ttf")))
        pdfmetrics.registerFont(TTFont(BODY_B, os.path.join(FONT_DIR, "arialbd.ttf")))
        pdfmetrics.registerFont(TTFont(BODY_I, os.path.join(FONT_DIR, "ariali.ttf")))
        pdfmetrics.registerFont(TTFont(MONO, os.path.join(FONT_DIR, "consola.ttf")))
        pdfmetrics.registerFontFamily(BODY, normal=BODY, bold=BODY_B, italic=BODY_I)
        return True
    except Exception as exc:                                    # pragma: no cover
        print("Font registration failed (%s) — using built-ins" % exc)
        return False


def esc(text):
    """Escape for ReportLab's mini-HTML, then re-apply inline markup."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # `code`
    text = re.sub(r"`([^`]+)`",
                  r'<font face="%s" size="8.5" color="#8A3B00">\1</font>' % MONO, text)
    # **bold**
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    # *italic* (avoid touching ** already consumed)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", text)
    # [label](url) -> label
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    return text


def build_styles(unicode_ok):
    base = BODY if unicode_ok else "Helvetica"
    bold = BODY_B if unicode_ok else "Helvetica-Bold"
    mono = MONO if unicode_ok else "Courier"
    ss = getSampleStyleSheet()

    def mk(name, **kw):
        kw.setdefault("fontName", base)
        kw.setdefault("textColor", INK)
        return ParagraphStyle(name, parent=ss["Normal"], **kw)

    return {
        "mono_name": mono,
        "title": mk("t", fontName=bold, fontSize=27, leading=32, alignment=TA_CENTER,
                    textColor=INK, spaceAfter=6),
        "subtitle": mk("st", fontSize=12.5, leading=17, alignment=TA_CENTER,
                       textColor=MUTED),
        "cover_meta": mk("cm", fontSize=9.5, leading=15, alignment=TA_CENTER,
                         textColor=MUTED),
        "h1": mk("h1", fontName=bold, fontSize=17, leading=21, spaceBefore=20,
                 spaceAfter=8, textColor=INK),
        "h2": mk("h2", fontName=bold, fontSize=12.5, leading=16, spaceBefore=14,
                 spaceAfter=5, textColor=ACCENT),
        "h3": mk("h3", fontName=bold, fontSize=10.5, leading=14, spaceBefore=10,
                 spaceAfter=4, textColor=INK),
        "body": mk("b", fontSize=9.5, leading=14.2, spaceAfter=6),
        "bullet": mk("bu", fontSize=9.5, leading=14, leftIndent=13, bulletIndent=3,
                     spaceAfter=2.5),
        "code": ParagraphStyle("code", fontName=mono, fontSize=7.9, leading=10.4,
                               textColor=colors.HexColor("#20202A"),
                               backColor=CODE_BG, borderPadding=7,
                               leftIndent=2, spaceBefore=5, spaceAfter=9),
        "cell": mk("cell", fontSize=8.4, leading=11.4),
        "cell_h": mk("cellh", fontName=bold, fontSize=8.4, leading=11.4,
                     textColor=colors.white),
        "footer": mk("f", fontSize=7.6, textColor=MUTED),
    }


def parse_table(lines, start, S):
    """Consume a markdown pipe table starting at `start`; return (flowable, next)."""
    rows, i = [], start
    while i < len(lines) and lines[i].strip().startswith("|"):
        raw = lines[i].strip().strip("|")
        if re.fullmatch(r"[\s:|-]+", raw):      # separator row
            i += 1
            continue
        rows.append([c.strip() for c in raw.split("|")])
        i += 1
    if not rows:
        return None, start + 1

    ncols = max(len(r) for r in rows)
    data = []
    for ri, row in enumerate(rows):
        row = row + [""] * (ncols - len(row))
        style = S["cell_h"] if ri == 0 else S["cell"]
        data.append([Paragraph(esc(c), style) for c in row])

    avail = 170 * mm
    # First column carries the label in most tables — give it more room.
    if ncols == 1:
        widths = [avail]
    elif ncols == 2:
        widths = [avail * 0.46, avail * 0.54]
    else:
        first = avail * 0.34
        widths = [first] + [(avail - first) / (ncols - 1)] * (ncols - 1)

    tbl = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TABLE_HEAD),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#FAFAF8")]),
    ]))
    return tbl, i


def convert(md_path, pdf_path):
    unicode_ok = register_fonts()
    S = build_styles(unicode_ok)
    raw = open(md_path, encoding="utf-8").read()
    lines = raw.split("\n")

    # ── Cover page ────────────────────────────────────────────────────────
    story = [
        Spacer(1, 58 * mm),
        Paragraph("Vroomie", S["title"]),
        Paragraph(DOC_SUBTITLE, S["title"]),
        Spacer(1, 9 * mm),
        HRFlowable(width="42%", thickness=1.1, color=ACCENT, hAlign="CENTER"),
        Spacer(1, 9 * mm),
        Paragraph(DOC_BLURB, S["subtitle"]),
        Spacer(1, 26 * mm),
        Paragraph(DOC_VERSION_LINE, S["cover_meta"]),
        Paragraph("github.com/DGeorgeA/vroomie-app &nbsp;·&nbsp; branch main", S["cover_meta"]),
        Paragraph("Live at vroomie.in", S["cover_meta"]),
        Spacer(1, 14 * mm),
        Paragraph("All performance figures herein are measured results on held-out "
                  "data, reproducible with the committed test harnesses.", S["cover_meta"]),
        NextPageTemplate("body"),
        PageBreak(),
    ]

    i, n = 0, len(lines)
    # Skip the markdown's own H1 title block (the cover replaces it)
    while i < n and not lines[i].startswith("## "):
        i += 1

    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # fenced code
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            code = "\n".join(buf).rstrip()
            if code:
                story.append(Preformatted(code, S["code"]))
            continue

        # horizontal rule
        if re.fullmatch(r"-{3,}|\*{3,}|_{3,}", stripped):
            story.append(Spacer(1, 3))
            story.append(HRFlowable(width="100%", thickness=0.5, color=RULE))
            story.append(Spacer(1, 5))
            i += 1
            continue

        # table
        if stripped.startswith("|"):
            tbl, i = parse_table(lines, i, S)
            if tbl is not None:
                story.append(Spacer(1, 3))
                story.append(tbl)
                story.append(Spacer(1, 9))
            continue

        # headings
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            level, text = len(m.group(1)), m.group(2).strip()
            if level <= 2:
                story.append(KeepTogether([Paragraph(esc(text), S["h1"]),
                                           HRFlowable(width="100%", thickness=0.7,
                                                      color=ACCENT, spaceAfter=4)]))
            elif level == 3:
                story.append(Paragraph(esc(text), S["h2"]))
            else:
                story.append(Paragraph(esc(text), S["h3"]))
            i += 1
            continue

        # checkbox list
        m = re.match(r"^- \[([ xX])\]\s+(.*)$", stripped)
        if m:
            mark = "\u2611" if m.group(1).lower() == "x" else "\u2610"
            story.append(Paragraph(esc(m.group(2)), S["bullet"], bulletText=mark))
            i += 1
            continue

        # bullet
        m = re.match(r"^[-*]\s+(.*)$", stripped)
        if m:
            story.append(Paragraph(esc(m.group(1)), S["bullet"], bulletText="\u2022"))
            i += 1
            continue

        # numbered
        m = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if m:
            story.append(Paragraph(esc(m.group(2)), S["bullet"],
                                   bulletText="%s." % m.group(1)))
            i += 1
            continue

        # paragraph (join continuation lines)
        buf = [stripped]
        i += 1
        while i < n:
            nxt = lines[i].strip()
            if (not nxt or nxt.startswith(("#", "|", "```", "- ", "* "))
                    or re.match(r"^\d+\.\s", nxt)
                    or re.fullmatch(r"-{3,}", nxt)):
                break
            buf.append(nxt)
            i += 1
        story.append(Paragraph(esc(" ".join(buf)), S["body"]))

    # ── Page furniture ────────────────────────────────────────────────────
    def cover_page(canv, doc):
        canv.saveState()
        canv.setFillColor(ACCENT)
        canv.rect(0, A4[1] - 13 * mm, A4[0], 13 * mm, stroke=0, fill=1)
        canv.setFillColor(colors.HexColor("#111111"))
        canv.rect(0, 0, A4[0], 9 * mm, stroke=0, fill=1)
        canv.restoreState()

    def body_page(canv, doc):
        canv.saveState()
        canv.setStrokeColor(RULE)
        canv.setLineWidth(0.4)
        canv.line(20 * mm, A4[1] - 15 * mm, A4[0] - 20 * mm, A4[1] - 15 * mm)
        canv.setFont(BODY if unicode_ok else "Helvetica", 7.6)
        canv.setFillColor(MUTED)
        canv.drawString(20 * mm, A4[1] - 12.4 * mm,
                        "Vroomie — " + DOC_SUBTITLE.replace("<br/>", " ").replace("&amp;", "&"))
        canv.drawRightString(A4[0] - 20 * mm, A4[1] - 12.4 * mm, DOC_VERSION)
        canv.line(20 * mm, 14 * mm, A4[0] - 20 * mm, 14 * mm)
        canv.drawString(20 * mm, 10 * mm, "Measured results on held-out data")
        canv.drawRightString(A4[0] - 20 * mm, 10 * mm, "Page %d" % doc.page)
        canv.restoreState()

    doc = BaseDocTemplate(pdf_path, pagesize=A4,
                          leftMargin=20 * mm, rightMargin=20 * mm,
                          topMargin=20 * mm, bottomMargin=19 * mm,
                          title="Vroomie — " + DOC_SUBTITLE.replace("<br/>", " ").replace("&amp;", "&"),
                          author="Vroomie Engineering",
                          subject="Architecture, calibration rationale, failure catalogue and runbook")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=cover_page),
        PageTemplate(id="body", frames=[frame], onPage=body_page),
    ])
    doc.build(story)
    print("Wrote %s (%.0f KB)" % (pdf_path, os.path.getsize(pdf_path) / 1024))


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
