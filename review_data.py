"""Unified review queue — expense approvals + fraud flags in one sorted list."""

from __future__ import annotations

from formatting import EMPTY_LABEL, sanitize_display_text
from guardian_data import get_approvals_list


def _approval_priority(item: dict) -> float:
    risk_scores = {"Severe": 95, "High": 75, "Medium": 55, "Low": 35}
    base = risk_scores.get(str(item.get("risk") or "Low"), 40)
    if item.get("rec") == "deny":
        base += 10
    return base + min(float(item.get("amount_raw") or 0) / 500.0, 15)


def _fraud_priority(item: dict) -> float:
    return round(float(item.get("fraud_score") or 0) * 100, 1)


def format_fraud_risk_label(score: float) -> str:
    """Human-readable fraud risk — truncate (don't round up) to avoid inflated 100% labels."""
    pct = float(score or 0) * 100
    if pct <= 0:
        return EMPTY_LABEL
    return f"{int(pct)}%"


def _field(value, default: str = EMPTY_LABEL) -> str:
    if value is None or value == "":
        return default
    return sanitize_display_text(value)


def _approval_item(raw: dict) -> dict:
    key = raw.get("request_key") or raw.get("id") or ""
    return {
        "id": f"approval:{key}",
        "kind": "approval",
        "status": "pending",
        "priority": _approval_priority(raw),
        "title": _field(raw.get("item"), "Expense request"),
        "employee": _field(raw.get("name")),
        "department": _field(raw.get("dept")),
        "amount": _field(raw.get("amount")),
        "amount_raw": float(raw.get("amount_raw") or 0),
        "risk_label": raw.get("risk") or "Review",
        "risk_kind": "policy",
        "brief": _field(raw.get("brief"), ""),
        "context": [_field(c, "") for c in (raw.get("context") or []) if c],
        "rec": raw.get("rec") or "approve",
        "request_type": raw.get("request_type") or "high_value",
        "item_key": key,
    }


def _flag_item(raw: dict) -> dict:
    key = raw.get("flag_key") or ""
    amount_raw = float(raw.get("amount_raw") or 0)
    risk = str(raw.get("risk") or "Medium")
    flag_type = str(raw.get("flag_type") or "guardian")
    reason = sanitize_display_text(str(raw.get("reason") or "").strip())
    location = sanitize_display_text(str(raw.get("location") or "").strip())
    flag_types = raw.get("flag_types") or [flag_type]
    context = []
    for part in reason.split(" — "):
        part = part.strip()
        if part:
            context.append(sanitize_display_text(part))
    if not context:
        context.append("Flagged purchase requires review")
    if location and location != EMPTY_LABEL:
        context.append(f"Location: {location}")
    if len(flag_types) > 1:
        context.append(f"Sources: {', '.join(t.replace('_', ' ') for t in flag_types)}")
    elif flag_type:
        context.append(f"Type: {flag_type.replace('_', ' ')}")
    if raw.get("date"):
        context.append(f"Date: {raw['date']}")

    return {
        "id": f"flag:{key}",
        "kind": "flag",
        "status": "pending",
        "priority": _approval_priority({"risk": risk, "amount_raw": amount_raw, "rec": "deny"}),
        "title": _field(raw.get("vendor"), "Flagged purchase"),
        "employee": _field(raw.get("employee")),
        "department": _field(raw.get("department")),
        "amount": _field(raw.get("amount")),
        "amount_raw": amount_raw,
        "risk_label": risk,
        "risk_kind": "policy",
        "brief": reason,
        "context": context,
        "rec": "deny",
        "item_key": key,
        "flag_type": flag_type,
        "flag_reason": reason,
        "flag_date": raw.get("date"),
        "flag_location": location or None,
    }


def _fraud_item(raw: dict, status: str) -> dict:
    if status != "pending":
        return None
    score = float(raw.get("fraud_score") or 0)
    return {
        "id": f"fraud:{raw['transaction_id']}",
        "kind": "fraud",
        "status": status,
        "priority": _fraud_priority(raw),
        "title": _field(raw.get("merchant_name"), "Unknown merchant"),
        "employee": _field(raw.get("employee_name") or raw.get("card_id")),
        "department": _field(raw.get("department")),
        "amount": f"${float(raw.get('amount') or 0):,.2f}",
        "amount_raw": float(raw.get("amount") or 0),
        "risk_label": format_fraud_risk_label(score),
        "risk_kind": "fraud",
        "transaction_id": raw["transaction_id"],
        "timestamp": raw.get("timestamp"),
        "fraud_score": score,
        "explanation": _field(raw.get("explanation"), ""),
        "merchant_category": raw.get("merchant_category"),
        "channel": raw.get("channel"),
        "cardholder_country": raw.get("cardholder_country"),
        "merchant_country": raw.get("merchant_country"),
        "device_id": raw.get("device_id"),
        "ip_address": raw.get("ip_address"),
    }


def _report_item(raw: dict) -> dict | None:
    if raw.get("status") != "pending_cfo":
        return None
    amount_raw = float(raw.get("total") or 0)
    risk = "High" if raw.get("violation") else "Low"
    rec = raw.get("ai_recommendation") or ("deny" if raw.get("violation") else "approve")
    return {
        "id": f"report:{raw.get('report_key')}",
        "kind": "report",
        "status": "pending",
        "priority": _approval_priority({"risk": risk, "amount_raw": amount_raw, "rec": rec}),
        "title": _field(raw.get("title"), "Trip expense report"),
        "employee": _field(raw.get("employee")),
        "department": _field(raw.get("department")),
        "amount": _field(raw.get("total_formatted")),
        "amount_raw": amount_raw,
        "risk_label": risk,
        "risk_kind": "policy",
        "brief": _field(raw.get("ai_brief") or raw.get("policy_summary"), ""),
        "context": [_field(c, "") for c in (raw.get("ai_context") or []) if c],
        "rec": rec,
        "report_key": raw.get("report_key"),
        "txs": raw.get("txs"),
        "date_range": raw.get("date_range"),
    }


def build_review_queue(
    approval_exclude: set[str] | None = None,
    fraud_status_overrides: dict[str, str] | None = None,
    proposal_items: list[dict] | None = None,
    flag_exclude: set[str] | None = None,
    report_status_overrides: dict[str, str] | None = None,
    submitted_trip_reports: list[dict] | None = None,
) -> list[dict]:
    from fraud_data import flagged_records
    from guardian_data import get_flags_list

    approval_exclude = approval_exclude or set()
    fraud_status_overrides = fraud_status_overrides or {}
    flag_exclude = flag_exclude or set()
    queue: list[dict] = []
    seen_flag_keys: set[str] = set()

    for raw in get_flags_list(limit=48, exclude_keys=flag_exclude):
        key = raw.get("flag_key")
        if not key or key in seen_flag_keys:
            continue
        seen_flag_keys.add(key)
        queue.append(_flag_item(raw))

    for raw in get_approvals_list(limit=24, exclude_keys=approval_exclude):
        queue.append(_approval_item(raw))

    for item in proposal_items or []:
        if item.get("status") == "pending":
            queue.append(item)

    from workflow_data import build_trip_reports
    from trip_report_data import merge_trip_report_lists

    report_overrides = report_status_overrides or {}
    auto_reports = build_trip_reports(limit=24, status_overrides=report_overrides)
    merged_reports = merge_trip_report_lists(
        auto_reports,
        submitted_trip_reports or [],
        limit=24,
    )
    for raw in merged_reports:
        item = _report_item(raw)
        if item:
            queue.append(item)

    for raw in flagged_records():
        tid = raw["transaction_id"]
        in_memory = raw.get("review_status") or "pending"
        status = fraud_status_overrides.get(tid, in_memory)
        item = _fraud_item(raw, status)
        if item:
            queue.append(item)

    queue.sort(key=lambda x: (x["priority"], x["amount_raw"]), reverse=True)
    return queue


def build_review_stats(
    approval_exclude: set[str] | None = None,
    fraud_status_overrides: dict[str, str] | None = None,
    proposal_items: list[dict] | None = None,
    flag_exclude: set[str] | None = None,
    report_status_overrides: dict[str, str] | None = None,
    submitted_trip_reports: list[dict] | None = None,
) -> dict:
    from fraud_data import fraud_stats, get_threshold

    queue = build_review_queue(
        approval_exclude, fraud_status_overrides, proposal_items, flag_exclude, report_status_overrides,
        submitted_trip_reports,
    )
    approvals = [q for q in queue if q["kind"] == "approval"]
    fraud = [q for q in queue if q["kind"] == "fraud"]
    proposals = [q for q in queue if q["kind"] == "proposal"]
    flags = [q for q in queue if q["kind"] == "flag"]
    reports = [q for q in queue if q["kind"] == "report"]
    fs = fraud_stats()

    return {
        "total_pending": len(queue),
        "approvals_pending": len(approvals),
        "proposals_pending": len(proposals),
        "flags_pending": len(flags),
        "reports_pending": len(reports),
        "fraud_pending": len(fraud),
        "fraud_scored_total": fs.get("total", 0),
        "fraud_flagged_total": fs.get("flagged", 0),
        "fraud_escalated": fs.get("escalated", 0),
        "fraud_resolved": fs.get("approved", 0) + fs.get("dismissed", 0),
        "threshold": get_threshold(),
    }
