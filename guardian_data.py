"""Shared Brim Guardian CSV data layer (scoped per company)."""

from __future__ import annotations

from functools import lru_cache

import pandas as pd

from company_data import get_company_key, get_company_paths, paths_for_company
from formatting import EMPTY_LABEL, fmt_date, fmt_money, sanitize_display_text


def clear_cache() -> None:
    _transactions_for.cache_clear()
    _employee_summary_for.cache_clear()
    _flagged_transactions_for.cache_clear()
    _department_summary_for.cache_clear()
    _employees_by_name_for.cache_clear()
    try:
        from policy_engine import clear_policy_cache
        clear_policy_cache()
    except ImportError:
        pass
    try:
        import expense_data
        expense_data.reload_expense_cache()
    except Exception:
        pass


@lru_cache(maxsize=32)
def _transactions_for(company_key: tuple[int, str]) -> pd.DataFrame:
    paths = paths_for_company(company_key[0], company_key[1])
    if not paths.scored_tx.is_file():
        return pd.DataFrame()
    df = pd.read_csv(paths.scored_tx)
    if df.empty:
        return df
    df["Transaction Date"] = pd.to_datetime(df["Transaction Date"], errors="coerce")
    df["Amount Clean"] = pd.to_numeric(df["Amount Clean"], errors="coerce").fillna(0)
    return df


@lru_cache(maxsize=32)
def _employee_summary_for(company_key: tuple[int, str]) -> pd.DataFrame:
    paths = paths_for_company(company_key[0], company_key[1])
    if not paths.employee_scores.is_file():
        return pd.DataFrame()
    return pd.read_csv(paths.employee_scores)


@lru_cache(maxsize=32)
def _flagged_transactions_for(company_key: tuple[int, str]) -> pd.DataFrame:
    paths = paths_for_company(company_key[0], company_key[1])
    if not paths.flagged_tx.is_file():
        return pd.DataFrame()
    df = pd.read_csv(paths.flagged_tx)
    if df.empty:
        return df
    df["Transaction Date"] = pd.to_datetime(df["Transaction Date"], errors="coerce")
    df["Amount Clean"] = pd.to_numeric(df["Amount Clean"], errors="coerce").fillna(0)
    return df


@lru_cache(maxsize=32)
def _department_summary_for(company_key: tuple[int, str]) -> pd.DataFrame:
    paths = paths_for_company(company_key[0], company_key[1])
    if not paths.department_summary.is_file():
        return pd.DataFrame()
    return pd.read_csv(paths.department_summary)


@lru_cache(maxsize=32)
def _employees_by_name_for(company_key: tuple[int, str]) -> dict[str, dict]:
    df = _employee_summary_for(company_key)
    if df.empty:
        return {}
    return {
        row["employee_name"]: row.to_dict()
        for _, row in df.iterrows()
    }


def transactions() -> pd.DataFrame:
    return _transactions_for(get_company_key())


def employee_summary() -> pd.DataFrame:
    return _employee_summary_for(get_company_key())


def flagged_transactions() -> pd.DataFrame:
    return _flagged_transactions_for(get_company_key())


def department_summary() -> pd.DataFrame:
    return _department_summary_for(get_company_key())


def employees_by_name() -> dict[str, dict]:
    return _employees_by_name_for(get_company_key())


def credit_score_for_name(name: str) -> float | None:
    meta = employees_by_name().get(name)
    if not meta:
        return None
    return float(meta["final_score"])


def credit_score_for_id(employee_id: str) -> float | None:
    df = employee_summary()
    if df.empty:
        return None
    row = df[df["employee_id"].astype(str) == str(employee_id)]
    if row.empty:
        return None
    return float(row.iloc[0]["final_score"])


def employee_row(name: str | None = None, employee_id: str | None = None):
    df = employee_summary()
    if df.empty:
        return None
    if employee_id is not None:
        match = df[df["employee_id"].astype(str) == str(employee_id)]
    elif name:
        match = df[df["employee_name"] == name]
    else:
        return None
    if match.empty:
        return None
    return match.iloc[0]


def overview_totals() -> dict:
    from policy_engine import scan_all_policy_violations

    policy_count = len(scan_all_policy_violations())
    dept_df = department_summary()
    return {
        "transactions": int(len(transactions())),
        "flagged": int(flagged_transactions().shape[0]) + policy_count,
        "employees": int(len(employee_summary())),
        "departments": int(len(dept_df)) if not dept_df.empty else 0,
        "policy_violations": policy_count,
    }


def flag_item_key(
    employee: str,
    vendor: str,
    date: str,
    amount: float,
    flag_type: str = "guardian",
) -> str:
    """Stable id for a flagged purchase (review decisions + dedupe)."""
    del flag_type
    emp = str(employee or "").strip()
    vend = str(vendor or "").strip()
    date_part = str(date or "").strip()[:24]
    amt = round(float(amount or 0), 2)
    return f"{emp}|{vend}|{date_part}|{amt}"


def _merge_flag_records(existing: dict, incoming: dict) -> dict:
    """Combine guardian + policy hits on the same purchase into one flag."""
    merged = dict(existing)
    for field in ("employee", "department", "vendor", "amount", "amount_raw", "date", "location"):
        if not merged.get(field) or merged.get(field) == "—":
            merged[field] = incoming.get(field) or merged.get(field)

    reasons = []
    for src in (existing, incoming):
        reason = str(src.get("reason") or "").strip()
        if reason and reason not in reasons:
            reasons.append(reason)
    merged["reason"] = " — ".join(reasons)

    risk_order = {"Severe": 4, "High": 3, "Medium": 2, "Low": 1}
    merged["risk"] = max(
        (existing.get("risk"), incoming.get("risk")),
        key=lambda r: risk_order.get(str(r or "Low"), 0),
    )

    types = []
    for src in (existing, incoming):
        ft = str(src.get("flag_type") or "").strip()
        if ft and ft not in types:
            types.append(ft)
    merged["flag_type"] = types[0] if len(types) == 1 else "flagged"
    merged["flag_types"] = types
    return merged


def _flag_record(row) -> dict:
    risk = str(row.get("risk_level") or "Low")
    city = str(row.get("Merchant City") or "").strip()
    country = str(row.get("Merchant Country") or "").strip()
    location = ", ".join(part for part in (city, country) if part)
    amount = float(row["Amount Clean"])
    date_label = fmt_date(row["Transaction Date"])
    return {
        "employee": row["Employee Name"],
        "department": row.get("Department") or EMPTY_LABEL,
        "vendor": row["Merchant Info DBA Name"],
        "amount": fmt_money(amount),
        "amount_raw": round(amount, 2),
        "location": location or EMPTY_LABEL,
        "reason": sanitize_display_text(str(row.get("flag_reason") or "").strip()),
        "risk": risk,
        "date": date_label,
        "flag_type": "guardian",
        "flag_key": flag_item_key(
            row["Employee Name"],
            row["Merchant Info DBA Name"],
            date_label,
            amount,
            "guardian",
        ),
    }


def get_flags_list(
    limit: int | None = 200,
    exclude_keys: set[str] | None = None,
) -> list[dict]:
    from policy_engine import merge_flags_with_policy, scan_all_policy_violations

    exclude_keys = exclude_keys or set()
    df = flagged_transactions()
    if df.empty:
        guardian_flags = []
    else:
        df = df.sort_values("Amount Clean", ascending=False)
        guardian_flags = [_flag_record(row) for _, row in df.iterrows()]
    policy_violations = scan_all_policy_violations()
    combined = merge_flags_with_policy(guardian_flags, policy_violations)

    by_key: dict[str, dict] = {}
    for flag in combined:
        key = flag.get("flag_key")
        if not key or key in exclude_keys:
            continue
        if key in by_key:
            by_key[key] = _merge_flag_records(by_key[key], flag)
        else:
            by_key[key] = flag

    merged = list(by_key.values())
    merged.sort(
        key=lambda item: (
            {"Severe": 4, "High": 3, "Medium": 2, "Low": 1}.get(str(item.get("risk") or "Low"), 0),
            float(item.get("amount_raw") or 0),
        ),
        reverse=True,
    )
    if limit is not None:
        merged = merged[:limit]
    return merged


def get_approvals_list(limit: int = 12, exclude_keys: set[str] | None = None) -> list[dict]:
    from workflow_data import build_pending_approvals

    exclude_keys = exclude_keys or set()
    pending = build_pending_approvals(limit=limit + len(exclude_keys))
    return [
        item for item in pending if item.get("request_key") not in exclude_keys
    ][:limit]


def get_reports_list(limit: int = 20, status_overrides: dict | None = None) -> list[dict]:
    from workflow_data import build_trip_reports

    return build_trip_reports(limit=limit, status_overrides=status_overrides)


def get_report_detail(report_id: str) -> dict | None:
    from workflow_data import get_trip_report

    return get_trip_report(report_id)


def __getattr__(name: str):
    if name == "SCORED_TX_PATH":
        return get_company_paths().scored_tx
    if name == "CSV_NAME":
        return get_company_paths().csv_name
    if name == "SUMMARY_PATH":
        return get_company_paths().employee_scores
    if name == "FLAGS_PATH":
        return get_company_paths().flagged_tx
    if name == "DEPT_PATH":
        return get_company_paths().department_summary
    raise AttributeError(name)
