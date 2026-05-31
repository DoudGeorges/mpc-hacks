"""Pre-approval queue and automated expense report workflows."""
from __future__ import annotations

from datetime import datetime

import pandas as pd

from formatting import fmt_date, fmt_money, sanitize_display_text
from guardian_data import (
    credit_score_for_name,
    department_summary,
    employees_by_name,
    transactions,
)
from policy_engine import load_policy_rules, scan_all_policy_violations


def _current_quarter_label(dt: datetime | None = None) -> str:
    dt = dt or datetime.now()
    q = (dt.month - 1) // 3 + 1
    return f"Q{q} {dt.year}"


def _dept_budget_context(dept: str) -> tuple[float, float, float]:
    from budget_data import _debit_df, _dept_spend_in_range, _quarter_bounds, _reference_date, quarterly_budget_cap
    from guardian_data import transactions

    df = _debit_df(transactions())
    ref = _reference_date(df)
    q_start, q_end, quarter, _ = _quarter_bounds(ref)
    spent = _dept_spend_in_range(df, dept, q_start, q_end)
    budget = quarterly_budget_cap(dept, df, ref, quarter)
    remaining = round(max(budget - spent, 0.0), 2)
    return budget, spent, remaining


def _count_conferences(employee_name: str, df: pd.DataFrame) -> int:
    travel_mcc = {4722, 7011, 3501, 3502, 4784, 4121}
    keywords = ("conference", "registration", "summit", "expo", "convention", "hotel")
    rows = df[df["Employee Name"] == employee_name]
    count = 0
    for _, r in rows.iterrows():
        mcc = str(r.get("Merchant Category Code") or "")
        blob = " ".join(
            str(r.get(c) or "")
            for c in ("Merchant Info DBA Name", "Transaction Description", "Transaction Category")
        ).lower()
        amt = float(r.get("Amount Clean") or 0)
        if amt >= 300 and (
            (mcc.isdigit() and int(mcc) in travel_mcc)
            or any(k in blob for k in keywords)
        ):
            count += 1
    return count


def _item_label(row) -> str:
    vendor = str(row.get("Merchant Info DBA Name") or "Expense")
    cat = str(row.get("Transaction Category") or "").strip()
    trip = str(row.get("Project/Trip Name") or "").strip()
    blob = f"{vendor} {cat} {trip}".lower()
    if any(k in blob for k in ("conference", "registration", "summit", "expo")):
        return sanitize_display_text(f"Conference registration {vendor}")
    if trip and trip != "nan":
        return sanitize_display_text(f"{trip} {vendor}")
    return sanitize_display_text(vendor)


def build_ai_recommendation(
    name: str,
    dept: str,
    amount: float,
    item: str,
    reason: str = "",
    flag_type: str = "",
) -> tuple[str, str, list[str]]:
    """Returns (recommendation approve|deny, brief, context bullets)."""
    rules = load_policy_rules()
    score = credit_score_for_name(name) or 80.0
    meta = employees_by_name().get(name, {})
    flagged_count = int(meta.get("flagged_transactions") or 0)
    _, _, remaining = _dept_budget_context(dept)
    df = transactions()
    conferences = _count_conferences(name, df)

    context = [
        f"{fmt_money(remaining)} remaining in {_current_quarter_label()} dept budget ({dept})",
        f"Credit score {score:.1f}/100 — {flagged_count} prior flagged transaction(s)",
        f"Attended {conferences} conference/travel event(s) this period",
    ]

    rec = "approve"
    reasoning_parts = []

    approval_threshold = float(rules.get("manager_approval_threshold", 500))
    dept_rules = rules.get("department_overrides", {}).get(dept, {})
    if dept_rules.get("manager_approval_threshold"):
        approval_threshold = float(dept_rules["manager_approval_threshold"])

    if flag_type == "split_purchase":
        rec = "deny"
        reasoning_parts.append("Split-purchase pattern detected — likely threshold evasion")
    elif score < 70:
        rec = "deny"
        reasoning_parts.append(f"Credit score {score:.1f} below acceptable threshold")
    elif amount > remaining:
        rec = "deny"
        reasoning_parts.append("Would exceed department budget remainder")
    elif flag_type == "policy_violation" and "solo meal" in reason.lower():
        rec = "deny"
        reasoning_parts.append("Meal expense lacks team/client context per policy")
    elif amount <= approval_threshold and score >= 75:
        reasoning_parts.append("Within policy limits and aligns with past spending pattern")
    elif dept_rules.get("conference_pre_approved") and "conference" in item.lower():
        reasoning_parts.append("Marketing conference spend pre-approved per department policy")
    elif amount > approval_threshold and score >= 80 and amount <= remaining:
        reasoning_parts.append("Above approval threshold but employee history is strong")
    else:
        if score < 75:
            rec = "deny"
            reasoning_parts.append("Elevated risk profile")
        else:
            reasoning_parts.append("Requires manager review but no automatic deny triggers")

    if not reasoning_parts and rec == "approve":
        reasoning_parts.append("Within policy, aligns with past pattern")

    if reason and flag_type:
        context.append(sanitize_display_text(f"Trigger: {reason[:120]}"))

    brief = sanitize_display_text(
        f"{name} from {dept} is requesting {fmt_money(amount)} for {sanitize_display_text(item)}. "
        f"Department has {fmt_money(remaining)} remaining in {_current_quarter_label()} budget. "
        f"They attended {conferences} conference(s) this year. "
        f"Recommendation: {'Approve' if rec == 'approve' else 'Deny'}. "
        f"{sanitize_display_text(reasoning_parts[0] if reasoning_parts else 'review required')}."
    )
    context = [sanitize_display_text(c) for c in context]

    return rec, brief, context


def _valid_city(value) -> bool:
    s = str(value or "").strip()
    return s.isalpha() and 2 < len(s) < 30 and s.upper() == s


def _trip_city(row) -> str:
    for col in ("Approved City", "Merchant City"):
        if _valid_city(row.get(col)):
            return str(row.get(col)).strip().title()
    return "Trip"


def _trip_name_key(value) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return None
    return s


def _same_trip_cluster(prev, row, gap_days: int) -> bool:
    if gap_days > 4:
        return False
    prev_trip = _trip_name_key(prev.get("Project/Trip Name"))
    row_trip = _trip_name_key(row.get("Project/Trip Name"))
    if prev_trip is not None and row_trip is not None:
        return prev_trip == row_trip
    if prev_trip is None and row_trip is None:
        return True
    return False


def cluster_trip_reports(df: pd.DataFrame | None = None, min_txns: int = 2) -> list[dict]:
    """Group transactions into trip-based expense reports."""
    df = df if df is not None else transactions()
    work = df.copy()
    work["Transaction Date"] = pd.to_datetime(work["Transaction Date"], errors="coerce")
    work = work.sort_values(["Employee Name", "Transaction Date"])

    reports = []
    report_idx = 0

    for emp_name, emp_df in work.groupby("Employee Name"):
        emp_df = emp_df.sort_values("Transaction Date")
        dept = str(emp_df.iloc[0].get("Department") or "—")
        clusters: list[list] = []
        current: list = []

        for _, row in emp_df.iterrows():
            if not current:
                current = [row]
                continue
            prev = current[-1]
            gap = (row["Transaction Date"] - prev["Transaction Date"]).days
            if _same_trip_cluster(prev, row, gap):
                current.append(row)
            else:
                if len(current) >= min_txns:
                    clusters.append(current)
                current = [row]
        if len(current) >= min_txns:
            clusters.append(current)

        for cluster in clusters:
            report_idx += 1
            total = sum(float(r.get("Amount Clean") or 0) for r in cluster)
            trip = _trip_name_key(cluster[0].get("Project/Trip Name")) or "Business travel"
            city = _trip_city(cluster[0])
            start = cluster[0]["Transaction Date"]
            end = cluster[-1]["Transaction Date"]
            date_label = fmt_date(start)
            if len(cluster) > 1 and start != end:
                date_label = f"{fmt_date(start)} – {fmt_date(end)}"

            categories = {}
            violations = []
            for r in cluster:
                cat = str(r.get("Transaction Category") or "Other")
                categories[cat] = categories.get(cat, 0) + float(r.get("Amount Clean") or 0)
                if str(r.get("flagged", "")).lower() in ("true", "1") or r.get("flagged") is True:
                    violations.append(str(r.get("flag_reason") or "Guardian flag"))

            policy_hits = scan_all_policy_violations(pd.DataFrame(cluster))
            for p in policy_hits:
                violations.append(p.get("reason", "Policy violation"))

            tags = list(categories.keys())[:4]
            if violations:
                tags.append(f"{len(violations)} policy issue(s)")

            rec, brief, ai_context = build_trip_report_recommendation(
                {
                    "employee": emp_name,
                    "department": dept,
                    "total": total,
                    "txs": len(cluster),
                    "trip_name": trip,
                    "date_range": date_label,
                    "violations": violations,
                }
            )

            title = f"{emp_name} — {city} {trip.replace(' Trip', '').replace(' Travel', '')}"
            reports.append(
                {
                    "id": report_idx,
                    "report_key": f"{emp_name}|{trip}|{start.date() if hasattr(start, 'date') else start}",
                    "title": title,
                    "employee": emp_name,
                    "department": dept,
                    "trip_name": trip,
                    "city": city,
                    "txs": len(cluster),
                    "total": total,
                    "total_formatted": fmt_money(total),
                    "tags": tags or ["Business travel"],
                    "violation": bool(violations),
                    "violation_count": len(violations),
                    "violations": violations[:5],
                    "dup": False,
                    "date_range": date_label,
                    "categories": {k: round(v, 2) for k, v in categories.items()},
                    "status": "pending_cfo",
                    "policy_summary": (
                        f"{len(violations)} policy issue(s) detected across {len(cluster)} transactions."
                        if violations
                        else "All transactions pass automated policy checks."
                    ),
                    "ai_recommendation": rec,
                    "ai_brief": brief,
                    "ai_context": ai_context,
                    "transactions": [
                        {
                            "date": fmt_date(r.get("Transaction Date")),
                            "vendor": r.get("Merchant Info DBA Name"),
                            "amount": fmt_money(float(r.get("Amount Clean") or 0)),
                            "category": r.get("Transaction Category"),
                        }
                        for r in cluster
                    ],
                }
            )

    reports.sort(key=lambda r: (r["violation_count"], r["txs"], r["total"]), reverse=True)
    return reports


def build_pending_approvals(limit: int = 12) -> list[dict]:
    """Build approval packages from high-value and policy-triggered transactions."""
    df = transactions()
    rules = load_policy_rules()
    pending = []
    seen: set[str] = set()

    policy_violations = scan_all_policy_violations(df)
    split_by_emp = [v for v in policy_violations if v.get("flag_type") == "split_purchase"]

    for v in split_by_emp:
        key = f"split|{v['employee']}|{v.get('vendor')}"
        if key in seen:
            continue
        seen.add(key)
        rec, brief, context = build_ai_recommendation(
            v["employee"],
            v.get("department", "—"),
            float(v.get("amount") or 0),
            v.get("vendor", "Split purchase review"),
            v.get("reason", ""),
            "split_purchase",
        )
        pending.append(
            {
                "request_key": key,
                "name": v["employee"],
                "dept": v.get("department", "—"),
                "amount": fmt_money(float(v.get("amount") or 0)),
                "amount_raw": float(v.get("amount") or 0),
                "item": f"Split purchase review — {v.get('vendor', 'merchant')}",
                "context": context,
                "rec": rec,
                "brief": brief,
                "risk": "Severe",
                "request_type": "split_purchase",
            }
        )

    high_value = df[
        (df["Debit or Credit"].astype(str).str.lower() == "debit")
        & (df["Amount Clean"] >= float(rules.get("manager_approval_threshold", 500)))
    ].sort_values("Amount Clean", ascending=False)

    for _, row in high_value.iterrows():
        name = row["Employee Name"]
        key = f"txn|{row.name}|{name}"
        if key in seen:
            continue
        seen.add(key)
        dept = str(row.get("Department") or "—")
        amount = float(row.get("Amount Clean") or 0)
        item = _item_label(row)
        reason = str(row.get("flag_reason") or "Requires manager approval")
        rec, brief, context = build_ai_recommendation(
            name, dept, amount, item, reason, "approval_required"
        )
        risk = str(row.get("risk_level") or "Medium")
        if amount >= 1000:
            risk = "High"
        pending.append(
            {
                "request_key": key,
                "name": name,
                "dept": dept,
                "amount": fmt_money(amount),
                "amount_raw": amount,
                "item": item,
                "context": context,
                "rec": rec,
                "brief": brief,
                "risk": risk,
                "request_type": "high_value",
            }
        )
        if len(pending) >= limit:
            break

    pending.sort(
        key=lambda x: (
            0 if x["rec"] == "deny" else 1,
            {"Severe": 4, "High": 3, "Medium": 2, "Low": 1}.get(x.get("risk", "Low"), 0),
            x.get("amount_raw", 0),
        ),
        reverse=True,
    )
    return pending[:limit]


def build_trip_report_recommendation(report: dict) -> tuple[str, str, list[str]]:
    """AI-style approve/deny recommendation for a grouped expense report."""
    emp = report.get("employee", "—")
    dept = report.get("department", "—")
    total = float(report.get("total") or 0)
    violations = report.get("violations") or []
    trip = report.get("trip_name") or "Business travel"
    txs = int(report.get("txs") or 0)

    _, _, remaining = _dept_budget_context(dept)
    score = credit_score_for_name(emp) or 80.0
    conferences = _count_conferences(emp, transactions())

    context = [
        f"{fmt_money(remaining)} remaining in {_current_quarter_label()} dept budget ({dept})",
        f"{txs} transactions grouped — {report.get('date_range', '')}",
        f"Credit score {score:.1f}/100 — {conferences} conference(s) this period",
    ]
    if violations:
        context.append(f"{len(violations)} automated policy issue(s) in this report")

    rec = "approve"
    if violations and len(violations) >= 3:
        rec = "deny"
    elif violations and total > 500:
        rec = "deny"
    elif total > remaining and remaining > 0:
        rec = "deny"
    elif violations:
        rec = "deny" if score < 75 else "approve"
    elif score < 70:
        rec = "deny"

    if rec == "approve":
        reason = "Within policy — grouped trip expenses align with department budget and employee history."
    elif total > remaining:
        reason = "Would exceed department budget remainder for the quarter."
    elif violations:
        reason = f"Policy issues detected across {len(violations)} line item(s) — review before CFO sign-off."
    else:
        reason = "Elevated risk profile — manual review recommended."

    brief = sanitize_display_text(
        f"{emp} from {dept} submitted an expense report for {trip} "
        f"({fmt_money(total)}, {txs} transactions). "
        f"Department has {fmt_money(remaining)} remaining in {_current_quarter_label()} budget. "
        f"Recommendation: {'Approve' if rec == 'approve' else 'Reject'}. {sanitize_display_text(reason)}"
    )
    context = [sanitize_display_text(c) for c in context]
    return rec, brief, context


def build_trip_reports(limit: int = 20, status_overrides: dict | None = None) -> list[dict]:
    reports = cluster_trip_reports()
    if status_overrides:
        for report in reports:
            key = report.get("report_key")
            if key in status_overrides:
                report["status"] = status_overrides[key]
    return reports[:limit]


def get_trip_report(report_key: str) -> dict | None:
    for report in cluster_trip_reports():
        if report.get("report_key") == report_key:
            return report
    return None
