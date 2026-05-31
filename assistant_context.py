"""Site-wide context for the voice assistant — every page and data source in one snapshot."""

from __future__ import annotations

SITE_PAGES = {
    "overview": "Home — dashboard, quick actions, spend overview",
    "people": "People — employee roster, profiles, compare spending",
    "activity": "All purchases — searchable transaction table",
    "receipts": "Receipts — scan, upload, and save receipt photos or PDFs",
    "proposals": "My projects — submit and track project budget proposals",
    "budget": "Budgets — department caps, burn rate, forecasts",
    "map": "Map — purchase locations worldwide",
    "alerts": "Policy flags — violations, repeat offenders, flagged purchases",
    "approvals": "Review queue — approve spending requests, trip reports, proposals, and fraud",
    "reports": "Trip reports — bundled trip expenses for CFO sign-off",
    "chat": "Friday assistant — plain-English spending Q&A with charts",
    "settings": "Settings — department budget caps and spending rules",
}

_snapshot_cache: dict | None = None
_snapshot_cache_at: float = 0.0
_SNAPSHOT_TTL = 30.0


def clear_site_snapshot_cache() -> None:
    global _snapshot_cache, _snapshot_cache_at
    _snapshot_cache = None
    _snapshot_cache_at = 0.0


def get_site_snapshot(current_view: str | None = None) -> dict:
    import time

    global _snapshot_cache, _snapshot_cache_at
    now = time.time()
    if _snapshot_cache and now - _snapshot_cache_at < _SNAPSHOT_TTL:
        snap = dict(_snapshot_cache)
        snap["current_view"] = current_view or "overview"
        snap["current_view_label"] = SITE_PAGES.get(snap["current_view"], SITE_PAGES["overview"])
        return snap

    from guardian_data import (
        employee_summary,
        get_approvals_list,
        get_flags_list,
        get_reports_list,
        overview_totals,
        transactions,
    )
    from expense_data import format_money, load_expenses

    rows = load_expenses()
    totals_meta = overview_totals()
    flags = get_flags_list(limit=8)
    approvals = get_approvals_list(limit=8)
    reports = get_reports_list(limit=12)
    pending_reports = [r for r in reports if r.get("status") == "pending_cfo"]

    total_spend = sum(r["amount"] for r in rows)
    flagged_rows = [r for r in rows if r.get("flagged") == "yes"]
    flagged_spend = sum(r["amount"] for r in flagged_rows)

    dept_spend: dict[str, float] = {}
    for row in rows:
        dept = row.get("department") or "Unknown"
        dept_spend[dept] = dept_spend.get(dept, 0.0) + row["amount"]
    top_depts = sorted(dept_spend.items(), key=lambda x: -x[1])[:6]

    budget_lines = []
    budget_cap_lines: list[str] = []
    try:
        from budget_data import format_budget_caps_for_context, get_department_forecasts

        budget_cap_lines = format_budget_caps_for_context()
        for fc in get_department_forecasts(limit=6):
            budget_lines.append(fc["message"])
    except ImportError:
        pass

    approval_lines = [
        f"{a['name']} ({a['dept']}): {a['item']} — {a['amount']}, {a.get('risk', 'Review')} risk"
        for a in approvals[:5]
    ]

    flag_lines = [
        f"{f.get('employee', '?')} — {f.get('vendor', '?')} — {f.get('amount', '')}"
        for f in flags[:6]
    ]

    result = {
        "current_view": current_view or "overview",
        "current_view_label": SITE_PAGES.get(current_view or "overview", SITE_PAGES["overview"]),
        "pages": SITE_PAGES,
        "counts": {
            "transactions": len(transactions()),
            "employees": len(employee_summary()),
            "flags": int(totals_meta.get("flagged", len(flags))),
            "approvals_pending": len(approvals),
            "reports_pending": len(pending_reports),
        },
        "totals": {
            "spend_fmt": format_money(total_spend),
            "flagged_fmt": format_money(flagged_spend),
            "flagged_count": len(flagged_rows),
        },
        "top_departments": [
            {"name": name, "spend_fmt": format_money(amt)} for name, amt in top_depts
        ],
        "budget_forecasts": budget_lines,
        "budget_caps": budget_cap_lines,
        "pending_approvals": approval_lines,
        "recent_flags": flag_lines,
        "pending_report_count": len(pending_reports),
    }

    _snapshot_cache = {k: v for k, v in result.items() if k not in ("current_view", "current_view_label")}
    _snapshot_cache_at = now
    return result


def build_voice_context_block(current_view: str | None = None) -> str:
    snap = get_site_snapshot(current_view)
    lines = [
        f"USER IS ON PAGE: {snap['current_view']} — {snap['current_view_label']}",
        "",
        "ALL PAGES YOU CAN NAVIGATE TO:",
    ]
    for key, desc in snap["pages"].items():
        lines.append(f"  - {key}: {desc}")

    c = snap["counts"]
    lines += [
        "",
        "LIVE COUNTS:",
        f"  - {c['transactions']} purchases — {c['employees']} employees",
        f"  - {c['flags']} flagged purchases — {c['approvals_pending']} pending approvals",
        f"  - {c['reports_pending']} trip reports awaiting CFO",
        "",
        f"TOTAL SPEND: {snap['totals']['spend_fmt']} ({snap['totals']['flagged_count']} flagged, {snap['totals']['flagged_fmt']})",
        "",
        "TOP DEPARTMENTS BY SPEND:",
    ]
    for dept in snap["top_departments"]:
        lines.append(f"  - {dept['name']}: {dept['spend_fmt']}")

    if snap.get("budget_caps"):
        lines += ["", "DEPARTMENT BUDGET CAPS (Settings — current quarter):"]
        lines.extend(snap["budget_caps"])

    if snap["budget_forecasts"]:
        lines += ["", "BUDGET FORECASTS:"]
        lines.extend(f"  - {line}" for line in snap["budget_forecasts"])

    if snap["pending_approvals"]:
        lines += ["", "PENDING APPROVALS (newest):"]
        lines.extend(f"  - {line}" for line in snap["pending_approvals"])

    if snap["recent_flags"]:
        lines += ["", "RECENT FLAGS:"]
        lines.extend(f"  - {line}" for line in snap["recent_flags"])

    lines += [
        "",
        "ACTIONS FRIDAY CAN TAKE (via tools):",
        "  - Open any page (navigate)",
        "  - Set or look up department budget caps (admin)",
        "  - Update spending policy rules — meal limits, approval thresholds, keywords (admin)",
        "  - List and approve/deny/escalate Review queue items — expenses, flags, fraud, projects (admin)",
        "  - Approve or reject trip reports (admin)",
        "  - Submit a project budget proposal (employees)",
    ]

    return "\n".join(lines)
