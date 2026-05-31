import re
from datetime import datetime
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from expense_data import CSV_NAME, compare_employees, get_employee_detail

MARGIN = 48
PAGE_WIDTH = letter[0] - (2 * MARGIN)


def _name_slug(name):
    slug = re.sub(r"[^\w\s-]", "", name.lower())
    slug = re.sub(r"[\s_]+", "-", slug).strip("-")
    return slug[:40] or "employee"


def build_pdf_filename(names):
    names = [n.strip() for n in names if n and n.strip()]
    date_part = datetime.now().strftime("%Y-%m-%d")
    if len(names) == 1:
        return f"mpc-spending-{_name_slug(names[0])}-{date_part}.pdf"
    slugs = [_name_slug(n) for n in names[:4]]
    if len(names) > 4:
        slugs.append(f"{len(names) - 4}-more")
    label = "-vs-".join(slugs)
    return f"mpc-comparison-{label}-{date_part}.pdf"


def _styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "Title",
            parent=base["Heading1"],
            fontSize=18,
            spaceAfter=12,
            textColor=colors.HexColor("#1e3a8a"),
        ),
        "heading": ParagraphStyle(
            "Heading",
            parent=base["Heading2"],
            fontSize=13,
            spaceBefore=14,
            spaceAfter=8,
            textColor=colors.HexColor("#1f2937"),
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["BodyText"],
            fontSize=10,
            leading=14,
            textColor=colors.HexColor("#374151"),
        ),
        "small": ParagraphStyle(
            "Small",
            parent=base["BodyText"],
            fontSize=8,
            leading=11,
            textColor=colors.HexColor("#6b7280"),
        ),
        "cell": ParagraphStyle(
            "Cell",
            parent=base["BodyText"],
            fontSize=8,
            leading=10,
            textColor=colors.HexColor("#374151"),
            wordWrap="CJK",
        ),
        "cell_header": ParagraphStyle(
            "CellHeader",
            parent=base["BodyText"],
            fontSize=8,
            leading=10,
            textColor=colors.white,
            fontName="Helvetica-Bold",
            wordWrap="CJK",
        ),
    }


def _fit_widths(widths):
    """Scale column widths so the table fits the printable page width."""
    total = sum(widths)
    if total <= PAGE_WIDTH:
        return widths
    ratio = PAGE_WIDTH / total
    return [w * ratio for w in widths]


def _even_widths(count, first_ratio=0.28):
    """Distribute page width across columns; first column gets a wider label slot."""
    if count < 1:
        return []
    if count == 1:
        return [PAGE_WIDTH]
    first = PAGE_WIDTH * first_ratio
    rest = (PAGE_WIDTH - first) / (count - 1)
    return [first] + [rest] * (count - 1)


def _para(text, style):
    safe = escape(str(text or ""))
    return Paragraph(safe, style)


def _table(rows, col_widths, styles):
    if not rows:
        return Spacer(1, 0)

    col_widths = _fit_widths(col_widths)
    wrapped = []
    for row_idx, row in enumerate(rows):
        cell_style = styles["cell_header"] if row_idx == 0 else styles["cell"]
        wrapped.append([_para(cell, cell_style) for cell in row])

    tbl = Table(wrapped, colWidths=col_widths, repeatRows=1, splitByRow=1)
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2563eb")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return tbl


def _employee_section(story, styles, employee):
    story.append(Paragraph(employee["name"], styles["heading"]))
    meta = (
        f"Employee ID: {employee['employee_id']}<br/>"
        f"Total spend: {employee['total_spend_fmt']} — "
        f"Transactions: {employee['transaction_count']} — "
        f"Flagged: {employee['flagged_count']} — "
        f"Credit score: {employee['credit_score']}"
    )
    story.append(Paragraph(meta, styles["body"]))
    story.append(Spacer(1, 8))

    cat_rows = [["City", "Amount"]]
    for label, value in zip(
        employee["by_city"]["labels"], employee["by_city"]["values"]
    ):
        cat_rows.append([label, f"${value:,.2f}"])
    story.append(_table(cat_rows, [PAGE_WIDTH * 0.62, PAGE_WIDTH * 0.38], styles))
    story.append(Spacer(1, 10))

    vendor_rows = [["Top vendor", "Amount"]]
    for v in employee.get("top_vendors", [])[:8]:
        vendor_rows.append([v["vendor"], v["amount"]])
    story.append(_table(vendor_rows, [PAGE_WIDTH * 0.62, PAGE_WIDTH * 0.38], styles))
    story.append(Spacer(1, 10))

    tx_rows = [["Date", "Vendor", "Category", "Amount", "Location"]]
    for tx in employee.get("recent_transactions", [])[:20]:
        tx_rows.append(
            [tx["date"], tx["vendor"], tx["category"], tx["amount"], tx["location"]]
        )
    story.append(Paragraph("Recent transactions", styles["heading"]))
    story.append(
        _table(
            tx_rows,
            [
                PAGE_WIDTH * 0.13,
                PAGE_WIDTH * 0.28,
                PAGE_WIDTH * 0.18,
                PAGE_WIDTH * 0.14,
                PAGE_WIDTH * 0.27,
            ],
            styles,
        )
    )


def build_spending_pdf(names):
    names = [n.strip() for n in names if n and n.strip()]
    if not names:
        raise ValueError("At least one employee name is required")

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        rightMargin=MARGIN,
        leftMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        title="Employee Spending Comparison" if len(names) > 1 else f"Spending Report — {names[0]}",
    )
    styles = _styles()
    story = []

    is_compare = len(names) > 1
    title = "Employee Spending Comparison" if is_compare else f"Spending Report — {names[0]}"
    story.append(Paragraph(title, styles["title"]))
    story.append(
        Paragraph(
            f"Generated {datetime.now().strftime('%B %d, %Y at %I:%M %p')} — Source: {CSV_NAME}",
            styles["small"],
        )
    )
    story.append(Spacer(1, 16))

    if is_compare:
        data = compare_employees(names)
        if not data:
            raise ValueError("No matching employees found")

        summary_rows = [["Employee", "Total spend", "Transactions", "Flagged", "Credit score"]]
        for e in data["employees"]:
            summary_rows.append(
                [
                    e["name"],
                    e["total_spend_fmt"],
                    str(e["transaction_count"]),
                    str(e["flagged_count"]),
                    str(e["credit_score"]),
                ]
            )
        story.append(Paragraph("Comparison summary", styles["heading"]))
        story.append(
            _table(
                summary_rows,
                _even_widths(len(summary_rows[0]), first_ratio=0.34),
                styles,
            )
        )
        story.append(Spacer(1, 14))

        city_labels = data["comparison"]["by_city"]["labels"]
        city_header = ["City"] + [
            d["name"].split()[0] for d in data["comparison"]["by_city"]["datasets"]
        ]
        city_rows = [city_header]
        for i, city in enumerate(city_labels):
            row = [city]
            for ds in data["comparison"]["by_city"]["datasets"]:
                row.append(f"${ds['values'][i]:,.2f}")
            city_rows.append(row)
        story.append(Paragraph("Spend by city", styles["heading"]))
        story.append(
            _table(
                city_rows,
                _even_widths(len(city_header), first_ratio=0.22),
                styles,
            )
        )
        story.append(Spacer(1, 18))

        for employee in data["employees"]:
            _employee_section(story, styles, employee)
            story.append(Spacer(1, 16))
    else:
        employee = get_employee_detail(names[0])
        if not employee:
            raise ValueError(f"Employee not found: {names[0]}")
        _employee_section(story, styles, employee)

    doc.build(story)
    buffer.seek(0)
    return buffer
