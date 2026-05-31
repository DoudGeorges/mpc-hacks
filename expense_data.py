import csv
import os
from collections import defaultdict
from datetime import datetime

from company_data import get_company_key, get_company_paths
from guardian_data import (
    clear_cache,
    credit_score_for_name,
    department_summary,
    employees_by_name,
    overview_totals,
)
from paths import LOCATION_COORDS_PATH, POSTAL_COORDS_PATH, STREET_COORDS_PATH

_cache_by_company: dict[tuple[int, str], dict] = {}
_merchant_index = None
_purchase_map_index = None
_purchase_map_index_mtime = None
_street_coords_file = None
_resolved_flag_keys_provider = None


def register_resolved_flag_keys_provider(provider) -> None:
    """Register a callable returning decided flag keys (wired from app.py after DB init)."""
    global _resolved_flag_keys_provider
    _resolved_flag_keys_provider = provider


def _resolved_flag_keys() -> set[str]:
    if not _resolved_flag_keys_provider:
        return set()
    try:
        return set(_resolved_flag_keys_provider() or [])
    except Exception:
        return set()


def _csv_path() -> str:
    return str(get_company_paths().scored_tx)


def _csv_name() -> str:
    return get_company_paths().csv_name


def reload_expense_cache():
    global _cache_by_company, _merchant_index, _purchase_map_index, _purchase_map_index_mtime, _street_coords_file
    _cache_by_company = {}
    _merchant_index = None
    _purchase_map_index = None
    _purchase_map_index_mtime = None
    _street_coords_file = None
    clear_cache()


def _parse_date(value):
    if not value:
        return None
    value = value.strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _parse_amount(value):
    if value is None:
        return 0.0
    return abs(float(str(value).replace(",", "").strip() or 0))


def _mcc_category(mcc):
    code = str(mcc or "").strip()
    if not code.isdigit():
        return "Other"
    n = int(code)
    if n in (5812, 5813, 5814):
        return "Meals"
    if n in (5541, 5542):
        return "Fuel"
    if n == 9399:
        return "Fees & Permits"
    if n in (4784, 4121, 3501, 3502, 7011, 4722, 4111, 7512):
        return "Travel"
    if n in (5734, 4816, 4814, 5045, 7372):
        return "Software & Telecom"
    if n in (5046, 5533, 7538, 7542):
        return "Vehicle & Equipment"
    if n in (4214, 4215):
        return "Shipping"
    if n in (7399,):
        return "Business Services"
    if n in (7523,):
        return "Parking"
    if n in (5300, 5411, 5921):
        return "Retail"
    return "General"


def _is_flagged(raw):
    val = raw.get("flagged", "")
    if isinstance(val, bool):
        return val
    if str(val).strip().lower() in ("true", "1", "yes"):
        return True
    return str(raw.get("status", "")).strip().lower() == "flagged"


def _apply_unified_flags(rows: list[dict]) -> None:
    """Mark purchases flagged the same way as Problems / Review (Guardian + policy)."""
    from formatting import fmt_date
    from guardian_data import flag_item_key, get_flags_list

    exclude = _resolved_flag_keys()

    flags_by_key = {
        f["flag_key"]: f
        for f in get_flags_list(limit=500, exclude_keys=exclude)
        if f.get("flag_key")
    }

    for row in rows:
        if not row.get("is_debit"):
            continue
        row["flagged"] = row.get("_csv_flagged") or ""
        row["flag_reason"] = row.get("_csv_flag_reason") or ""
        row["status"] = row.get("_csv_status") or "Normal"

    for row in rows:
        if not row.get("is_debit"):
            continue
        key = flag_item_key(
            row["employee"],
            row["vendor"],
            fmt_date(row["date"]),
            row["amount"],
        )
        match = flags_by_key.get(key)
        if not match:
            continue
        row["flagged"] = "yes"
        reason = str(match.get("reason") or "").strip()
        if reason:
            row["flag_reason"] = reason
        risk = str(match.get("risk") or "").strip()
        if risk:
            row["risk_level"] = risk
        row["status"] = "Flagged"


def _clean_text(value):
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() == "nan" else text


def _valid_city(city):
    if not city or len(city) < 2:
        return False
    digits = sum(ch.isdigit() for ch in city)
    if digits >= len(city) * 0.4:
        return False
    cleaned = city.replace("-", "").replace(" ", "")
    if cleaned.isdigit():
        return False
    return True


def _valid_postal(postal):
    if not postal:
        return False
    cleaned = postal.strip().replace(" ", "")
    if len(cleaned) < 3:
        return False
    if sum(ch.isdigit() for ch in cleaned) < len(cleaned) * 0.5:
        return False
    return True


def _valid_street(street):
    street = (street or "").strip()
    if len(street) < 5:
        return False
    return sum(ch.isalpha() for ch in street) >= 3


def _mappable_row(row):
    city = row.get("city") or ""
    postal = row.get("postal") or ""
    street = row.get("street_address") or ""
    return _valid_city(city) or _valid_postal(postal) or _valid_street(street)


def _street_cache_key(street, postal, state, country):
    return "|".join(
        part.strip().upper()
        for part in (street or "", postal or "", state or "", country or "")
        if part
    )


def _street_geocode_query(street, city, state, country, postal):
    parts = [street.strip()]
    if _valid_postal(postal):
        parts.append(postal.strip())
    elif _valid_city(city):
        parts.append(city.strip())
    if state:
        parts.append(state.strip())
    if country:
        parts.append(country.strip())
    return ", ".join(parts)


def _country_geocode_name(country):
    code = (country or "").strip().upper()
    if code == "CAN":
        return "Canada"
    if code == "USA":
        return "United States"
    return (country or "").strip()


def _city_geocode_name(city):
    city = (city or "").strip()
    if not city:
        return ""
    if city.isupper() and sum(ch.isalpha() for ch in city) >= 3:
        return city.title()
    return city


def _normalize_full_address_for_geocode(full_address):
    parts = [part.strip() for part in (full_address or "").split(",") if part.strip()]
    normalized = []
    for part in parts:
        upper = part.upper()
        if upper == "CAN":
            normalized.append("Canada")
        elif upper == "USA":
            normalized.append("United States")
        elif part.isupper() and sum(ch.isalpha() for ch in part) >= 3 and not any(ch.isdigit() for ch in part):
            normalized.append(part.title())
        else:
            normalized.append(part)
    return ", ".join(normalized)


def _merchant_geocode_query(site) -> str:
    """Best-effort address string for geocoding a merchant site."""
    street = (site.get("street_address") or "").strip()
    city = _city_geocode_name(site.get("city"))
    state = (site.get("state") or "").strip()
    country = _country_geocode_name(site.get("country"))
    postal = (site.get("postal") or "").strip()

    if street:
        return _street_geocode_query(street, city, state, country, postal)

    full = (site.get("full_address") or "").strip()
    if full:
        return _normalize_full_address_for_geocode(full)

    location = (site.get("location") or "").strip()
    if location:
        return _normalize_full_address_for_geocode(location)
    return ""


def _merchant_display_address(site) -> str:
    full = (site.get("full_address") or "").strip()
    if full:
        return full
    street = (site.get("street_address") or "").strip()
    parts = [part for part in (street, site.get("location")) if part]
    return ", ".join(parts)


def _coords_near_postal(coords, postal, country, max_km=35.0):
    """Reject geocode hits that land far from the merchant postal code."""
    if not coords or not _valid_postal(postal):
        return True
    anchor = _geocode_postal(postal, country)
    if not anchor:
        return True
    import math

    lat1 = math.radians(coords["lat"])
    lat2 = math.radians(anchor["lat"])
    dlat = lat2 - lat1
    dlng = math.radians(anchor["lng"] - coords["lng"])
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    km = 6371 * 2 * math.asin(min(1.0, math.sqrt(a)))
    return km <= max_km


def _geocode_photon_address(address):
    import json
    import urllib.parse
    import urllib.request

    address = (address or "").strip()
    if not address:
        return None

    cache_key = f"photon|{address}"
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    try:
        url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode(
            {"q": address, "limit": 1}
        )
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        features = data.get("features") or []
        if features:
            lng, lat = features[0]["geometry"]["coordinates"][:2]
            coords = {"lat": float(lat), "lng": float(lng)}
            _geocode_cache[cache_key] = coords
            return coords
    except Exception:
        pass

    _geocode_cache[cache_key] = None
    return None


def _geocode_street_query(address, api_key, postal=None, country=None):
    coords = None
    source = None
    if api_key:
        coords = _geocode_address_google_only(address, api_key)
        if coords:
            source = "google"
    if not coords:
        coords = _geocode_nominatim_address(address)
        if coords:
            source = "nominatim"
    if not coords:
        coords = _geocode_photon_address(address)
        if coords:
            source = "photon"
    if coords and not _coords_near_postal(coords, postal, country):
        return None, None
    return coords, source


def _geocode_address_google_only(address, api_key):
    import json
    import urllib.parse
    import urllib.request

    address = (address or "").strip()
    if not address or not api_key:
        return None

    cache_key = f"gmaps|{address}"
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    try:
        url = "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode(
            {"address": address, "key": api_key}
        )
        with urllib.request.urlopen(url, timeout=6) as resp:
            data = json.loads(resp.read().decode())
        if data.get("status") == "OK" and data.get("results"):
            loc = data["results"][0]["geometry"]["location"]
            coords = {"lat": loc["lat"], "lng": loc["lng"]}
            _geocode_cache[cache_key] = coords
            return coords
    except Exception:
        pass

    _geocode_cache[cache_key] = None
    return None


def _street_cache_verified(entry) -> bool:
    return isinstance(entry, dict) and entry.get("verified") is True


def _street_cache_coords(entry):
    if not isinstance(entry, dict):
        return None
    lat, lng = entry.get("lat"), entry.get("lng")
    if lat is None or lng is None:
        return None
    return {"lat": lat, "lng": lng}


def _map_location_label(city, state, country, postal):
    state = (state or "").strip()
    country = (country or "").strip()
    if _valid_city(city):
        return ", ".join(part for part in (city.strip(), state, country) if part)
    if _valid_postal(postal):
        return ", ".join(part for part in (postal.strip(), state, country) if part)
    return ", ".join(part for part in ((city or "").strip(), state, country) if part) or "Unknown"


def _normalize(raw, emp_meta=None):
    is_debit = raw.get("Debit or Credit", "").strip().lower() == "debit"
    amount = _parse_amount(raw.get("Amount Clean") or raw.get("Transaction Amount"))
    date = _parse_date(raw.get("Transaction Date")) or _parse_date(
        raw.get("Posting date of transaction")
    )

    city = (raw.get("Merchant City") or "").strip()
    state = (raw.get("Merchant State/Province") or "").strip()
    country = (raw.get("Merchant Country") or "").strip()
    postal = (raw.get("Merchant Postal Code") or "").strip()
    full_address = _clean_text(raw.get("Merchant Full Address"))
    street_address = _clean_text(raw.get("Merchant Street Address"))
    location = _map_location_label(city, state, country, postal)

    employee = raw.get("Employee Name", "").strip()
    department = (raw.get("Department") or "").strip()
    meta = (emp_meta or {}).get(employee, {})
    home_department = meta.get("department") or department or "—"

    flagged_yes = _is_flagged(raw) and is_debit
    flagged = "yes" if flagged_yes else ""
    flag_reason = _clean_text(raw.get("flag_reason"))
    risk_level = _clean_text(raw.get("risk_level"))
    status = _clean_text(raw.get("status")) or "Normal"

    return {
        "employee_id": raw.get("Employee ID", "").strip(),
        "employee": employee,
        "vendor": (raw.get("Merchant Info DBA Name") or raw.get("Transaction Description") or "").strip(),
        "description": (raw.get("Transaction Description") or "").strip(),
        "category": _mcc_category(raw.get("Merchant Category Code")),
        "transaction_category": raw.get("Transaction Category", "").strip(),
        "department": department or home_department,
        "home_department": home_department,
        "amount": amount if is_debit else 0.0,
        "is_debit": is_debit,
        "date": date,
        "location": location or "Unknown",
        "city": city,
        "state": state,
        "postal": postal,
        "full_address": full_address,
        "street_address": street_address,
        "flagged": flagged,
        "flag_reason": flag_reason,
        "risk_level": risk_level,
        "status": status,
        "_csv_flagged": flagged,
        "_csv_flag_reason": flag_reason,
        "_csv_status": status,
        "mcc": raw.get("Merchant Category Code", "").strip(),
        "country": country or "Unknown",
    }


def load_expenses():
    key = get_company_key()
    csv_path = _csv_path()
    try:
        mtime = os.path.getmtime(csv_path)
    except OSError:
        return []

    cached = _cache_by_company.get(key)
    if cached and cached.get("mtime") == mtime:
        rows = cached["rows"]
        _apply_unified_flags(rows)
        return rows

    if key in _cache_by_company:
        clear_cache()

    if not os.path.isfile(csv_path):
        _cache_by_company[key] = {"mtime": mtime, "rows": []}
        return []

    emp_meta = employees_by_name()
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            _cache_by_company[key] = {"mtime": mtime, "rows": []}
            return []
        for raw in reader:
            row = _normalize(raw, emp_meta)
            if not row["date"] or row["amount"] <= 0:
                continue
            row["month"] = row["date"].strftime("%Y-%m")
            row["quarter"] = f"Q{(row['date'].month - 1) // 3 + 1} {row['date'].year}"
            rows.append(row)

    _apply_unified_flags(rows)
    _cache_by_company[key] = {"mtime": mtime, "rows": rows}
    return rows


def scoped_expenses(employee_name=None):
    rows = load_expenses()
    if employee_name:
        rows = [r for r in rows if r["employee"] == employee_name]
    return rows


def _sum(rows, key):
    totals = defaultdict(float)
    for r in rows:
        totals[r[key]] += r["amount"]
    return dict(sorted(totals.items(), key=lambda x: -x[1]))


def _filter(rows, **kwargs):
    out = rows
    for k, v in kwargs.items():
        if v is None:
            continue
        out = [r for r in out if str(r.get(k, "")).lower() == str(v).lower()]
    return out


def _latest_month(rows):
    if not rows:
        return None
    return max(r["month"] for r in rows)


def _rows_in_month(rows, month):
    return [r for r in rows if r["month"] == month]


def _latest_quarter_label(rows):
    if not rows:
        return None
    latest = max(r["date"] for r in rows)
    return f"Q{(latest.month - 1) // 3 + 1} {latest.year}"


def _rows_in_quarter(rows, quarter_label):
    return [r for r in rows if r["quarter"] == quarter_label]


def _find_employee_in_query(q, rows):
    names = sorted({r["employee"] for r in rows}, key=len, reverse=True)
    for name in names:
        if name.lower() in q:
            return name
    return None


def format_money(n):
    from formatting import fmt_money

    return fmt_money(n)


def _top_items(totals, n=8):
    return list(totals.items())[:n]


def _city_label(row):
    city = (row.get("city") or "").strip() or "Unknown"
    state = (row.get("state") or "").strip()
    if state and city != "Unknown":
        return f"{city}, {state}"
    return city


def _sum_by_city(rows, limit=None):
    totals = defaultdict(float)
    for r in rows:
        totals[_city_label(r)] += r["amount"]
    ordered = sorted(totals.items(), key=lambda item: -item[1])
    if limit:
        ordered = ordered[:limit]
    return {city: amount for city, amount in ordered}


def _find_department_in_query(q, rows):
    depts = sorted({r["department"] for r in rows if r.get("department")}, key=len, reverse=True)
    for dept in depts:
        if dept.lower() in q:
            return dept
    return None


def _find_category_in_query(q):
    categories = {
        "software": "Software & Telecom",
        "telecom": "Software & Telecom",
        "travel": "Travel",
        "meal": "Meals",
        "meals": "Meals",
        "dining": "Meals",
        "fuel": "Fuel",
        "gas": "Fuel",
        "vehicle": "Vehicle & Equipment",
        "shipping": "Shipping",
    }
    for keyword, cat in categories.items():
        if keyword in q:
            return cat
    return None


def build_gemini_context(user_message: str, conversation_history=None, employee_name=None) -> str:
    rows = scoped_expenses(employee_name)
    q = user_message.lower()
    latest_month = _latest_month(rows)
    latest_q = _latest_quarter_label(rows)
    month_rows = _rows_in_month(rows, latest_month) if latest_month else []

    lines = []
    if employee_name:
        lines += [
            f"VIEW: Personal purchases for {employee_name} only.",
            "Do not infer or discuss other employees from this dataset.",
            "",
        ]

    lines += [
        f"Source file: {_csv_name()}",
        f"Total debit transactions: {len(rows)}",
    ]

    if not rows:
        return "\n".join(lines + ["", "No transactions in scope."])

    lines += [
        f"Date range: {min(r['date'] for r in rows).date()} to {max(r['date'] for r in rows).date()}",
        f"Latest month in file: {latest_month}",
        f"Latest quarter in file: {latest_q}",
        "",
    ]

    spend_heading = "MY SPEND BY CATEGORY:" if employee_name else "SPEND BY EMPLOYEE (all time):"
    if employee_name:
        lines.append(spend_heading)
        for cat, amt in _top_items(_sum(rows, "category"), 10):
            lines.append(f"  {cat}: {format_money(amt)}")
    else:
        lines.append(spend_heading)
        for emp, amt in _top_items(_sum(rows, "employee"), 10):
            flagged = sum(1 for r in rows if r["employee"] == emp and r.get("flagged") == "yes")
            lines.append(f"  {emp}: {format_money(amt)} ({flagged} flagged txns)")

    lines += ["", "SPEND BY CITY (all time):"]
    for city, amt in _top_items(_sum_by_city(rows), 12):
        lines.append(f"  {city}: {format_money(amt)}")

    lines += ["", f"TOP VENDORS ({latest_month}):"]
    for vendor, amt in _top_items(_sum(month_rows, "vendor"), 10):
        lines.append(f"  {vendor}: {format_money(amt)}")

    if latest_q:
        lines += ["", f"{latest_q} SPEND BY CITY:"]
        q_rows = _rows_in_quarter(rows, latest_q)
        for city, amt in _top_items(_sum_by_city(q_rows), 10):
            lines.append(f"  {city}: {format_money(amt)}")

    lines += ["", "SPEND BY COUNTRY (all time):"]
    for country, amt in _top_items(_sum(rows, "country"), 8):
        lines.append(f"  {country}: {format_money(amt)}")

    lines += ["", "FLAGGED / HIGH-VALUE TRANSACTIONS (≥ $500):"]
    flagged_rows = [x for x in rows if x.get("flagged") == "yes"]
    for r in sorted(flagged_rows, key=lambda x: x["amount"], reverse=True)[:20]:
        lines.append(
            f"  {r['date'].date()} | {r['employee']} | {r['vendor']} | "
            f"{_city_label(r)} | {format_money(r['amount'])} | {r['location']}"
        )

    lines += ["", "RECENT TRANSACTIONS (last 15):"]
    for r in sorted(rows, key=lambda x: x["date"], reverse=True)[:15]:
        lines.append(
            f"  {r['date'].date()} | {r['employee']} | {r['vendor']} | "
            f"{_city_label(r)} | {format_money(r['amount'])} | {r['location']}"
        )

    emp = _find_employee_in_query(q, rows)
    if emp:
        emp_rows = _filter(rows, employee=emp)
        lines += ["", f"ALL TRANSACTIONS FOR {emp.upper()} (most recent 25):"]
        for r in sorted(emp_rows, key=lambda x: x["date"], reverse=True)[:25]:
            lines.append(
                f"  {r['date'].date()} | {r['vendor']} | {_city_label(r)} | "
                f"{format_money(r['amount'])} | {r['location']}"
            )

    for city_hint in ("las vegas", "montreal", "toronto", "chicago", "calgary"):
        if city_hint in q:
            city_rows = [r for r in rows if city_hint in _city_label(r).lower()]
            lines += ["", f"TRANSACTIONS IN {city_hint.upper()} (most recent 20):"]
            for r in sorted(city_rows, key=lambda x: x["date"], reverse=True)[:20]:
                lines.append(
                    f"  {r['date'].date()} | {r['employee']} | {r['vendor']} | {format_money(r['amount'])}"
                )
            break

    dept = _find_department_in_query(q, rows)
    if not dept and conversation_history:
        combined = " ".join(
            m.text for m in conversation_history if hasattr(m, "text")
        ).lower()
        dept = _find_department_in_query(combined, rows)

    if dept:
        dept_rows = [r for r in rows if r.get("department", "").lower() == dept.lower()]
        lines += ["", f"SPEND BY CATEGORY — {dept.upper()}:"]
        for cat, amt in _top_items(_sum(dept_rows, "category"), 10):
            lines.append(f"  {cat}: {format_money(amt)}")
        if latest_q:
            q_dept = [r for r in dept_rows if r["quarter"] == latest_q]
            total_q = sum(r["amount"] for r in q_dept)
            lines += ["", f"{dept} {latest_q} total: {format_money(total_q)}"]

    try:
        from budget_data import (
            format_budget_caps_for_context,
            get_department_forecasts,
            get_forecast_for_query,
            lookup_department_budget,
        )

        if not employee_name:
            cap_lines = format_budget_caps_for_context(
                [dept] if dept else None
            )
            lines += ["", "DEPARTMENT BUDGET CAPS (Settings — current quarter):"]
            lines.extend(cap_lines)

        budget_q = any(
            k in q
            for k in (
                "budget", "cap", "limit", "remaining", "forecast",
                "burn rate", "burn", "exceed", "run out", "over budget", "project",
            )
        )
        if budget_q:
            if dept:
                info = lookup_department_budget(dept)
                if info:
                    fc = info["forecast"]
                    lines += [
                        "",
                        f"BUDGET DETAIL — {dept.upper()}:",
                        f"  Cap: {info['budget_fmt']} — Spent: {info['spent_fmt']} — "
                        f"Remaining: {info['remaining_fmt']}",
                        f"  Source: {'custom (Settings)' if info['is_custom'] else 'suggested cap'}",
                        f"  Forecast: {fc['message']}",
                        f"  Weekly burn: {fc['weekly_burn_fmt']} — "
                        f"{fc['pct_used']}% of cap used",
                    ]
            fc = get_forecast_for_query(user_message)
            if fc and (not dept or fc.get("department") != dept):
                lines += [
                    "",
                    "BUDGET FORECAST:",
                    f"  {fc['message']}",
                    f"  Weekly burn: {fc['weekly_burn_fmt']} — Week {fc['current_week']} of {fc['weeks_in_quarter']}",
                    f"  Spent: {fc['spent_fmt']} / {fc['budget_fmt']} cap ({fc['pct_used']}% used)",
                ]
        elif not employee_name:
            lines += ["", "DEPARTMENT BUDGET FORECASTS (current quarter):"]
            for fc in get_department_forecasts(limit=8):
                lines.append(f"  - {fc['message']}")
    except ImportError:
        pass

    if conversation_history:
        prior = [
            m.text for m in conversation_history[-6:]
            if hasattr(m, "text") and m.text.strip()
        ]
        if prior:
            lines += ["", "RECENT CONVERSATION (for follow-up context):"]
            for text in prior:
                lines.append(f"  - {text[:200]}")

    if not employee_name and any(
        k in q for k in ("consolidat", "duplicate vendor", "multiple vendor", "vendor overlap", "coffee vendor")
    ):
        try:
            from vendor_consolidation import analyze_vendor_consolidation

            vc = analyze_vendor_consolidation()
            lines += ["", "VENDOR CONSOLIDATION OPPORTUNITIES:"]
            lines.append(f"  {vc.get('headline')}")
            for opp in (vc.get("opportunities") or [])[:5]:
                lines.append(f"  - {opp.get('recommendation')}")
        except ImportError:
            pass

    try:
        from policy_engine import load_policy_document, policy_summary_text

        lines += ["", "ACTIVE EXPENSE POLICY:", policy_summary_text()]
        doc = load_policy_document()
        if doc:
            lines += ["", "POLICY DOCUMENT (excerpt):", doc[:2000]]
    except ImportError:
        pass

    return "\n".join(lines)


_CHART_INTENT_WORDS = (
    "graph", "chart", "plot", "visualize", "visualisation", "visualization",
    "breakdown", "bar chart", "line chart", "pie chart", "doughnut chart",
    "draw a", "make a graph", "make a chart", "show me a graph", "show me a chart",
)


def _wants_chart(q: str) -> bool:
    return any(w in q for w in _CHART_INTENT_WORDS)


def _monthly_trend_chart(rows, title="Spend Over Time", summary_prefix="Monthly spend trend"):
    by_month = defaultdict(float)
    for r in rows:
        by_month[r["month"]] += r["amount"]
    months = sorted(by_month.keys())
    return {
        "title": title,
        "summary": f"{summary_prefix} from {_csv_name()}.",
        "chart": {
            "type": "line",
            "labels": months,
            "values": [by_month[m] for m in months],
        },
    }


def _fallback_chart_insight(rows, q, employee_name=None, latest_month=None):
    """Pick a chart when the user asked for a graph but no specific rule matched."""
    dept = _find_department_in_query(q, rows)
    emp = _find_employee_in_query(q, rows)
    cat = _find_category_in_query(q)

    if dept:
        scope = [r for r in rows if r["department"].lower() == dept.lower()]
        by_vendor = _top_items(_sum(scope, "vendor"), 8)
        total = sum(r["amount"] for r in scope)
        return {
            "title": f"{dept} — spend by vendor",
            "summary": f"**{format_money(total)}** total for {dept} from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [v for v, _ in by_vendor] or ["No data"],
                "values": [a for _, a in by_vendor] or [0],
            },
        }

    if cat:
        scope = [r for r in rows if r["category"] == cat]
        by_emp = _top_items(_sum(scope, "employee"), 8)
        total = sum(r["amount"] for r in scope)
        return {
            "title": f"{cat} — spend by employee",
            "summary": f"**{format_money(total)}** in {cat} from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [e for e, _ in by_emp] or ["No data"],
                "values": [a for _, a in by_emp] or [0],
            },
        }

    if emp:
        emp_rows = _filter(rows, employee=emp)
        by_cat = _top_items(_sum(emp_rows, "category"), 8)
        total = sum(r["amount"] for r in emp_rows)
        return {
            "title": f"{emp} — spend by category",
            "summary": f"**{format_money(total)}** for {emp} from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [c for c, _ in by_cat] or ["No data"],
                "values": [a for _, a in by_cat] or [0],
            },
        }

    if "department" in q or "dept" in q or "departments" in q:
        by_dept = _top_items(_sum(rows, "department"), 10)
        return {
            "title": "Spend by Department",
            "summary": f"Department breakdown from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [d for d, _ in by_dept],
                "values": [a for _, a in by_dept],
            },
        }

    if "vendor" in q or "merchant" in q:
        month_rows = _rows_in_month(rows, latest_month) if latest_month else rows
        vendors = _top_items(_sum(month_rows, "vendor"), 8)
        label = latest_month or "all time"
        return {
            "title": f"Top Vendors — {label}",
            "summary": f"Top vendors from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [v for v, _ in vendors],
                "values": [a for _, a in vendors],
            },
        }

    if "category" in q or "categories" in q:
        by_cat = _top_items(_sum(rows, "category"), 10)
        return {
            "title": "Spend by Category",
            "summary": f"Category breakdown from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [c for c, _ in by_cat],
                "values": [a for _, a in by_cat],
            },
        }

    if "employee" in q or "person" in q or "people" in q or "who" in q:
        by_emp = _top_items(_sum(rows, "employee"), 10)
        return {
            "title": "Spend by Employee",
            "summary": f"Top spenders from {_csv_name()}.",
            "chart": {
                "type": "bar",
                "labels": [e for e, _ in by_emp],
                "values": [a for _, a in by_emp],
            },
        }

    if any(w in q for w in ("month", "time", "trend", "timeline", "over time", "when")):
        title = "My Spend Over Time" if employee_name else "Spend Over Time"
        return _monthly_trend_chart(rows, title=title)

    if employee_name:
        return _monthly_trend_chart(rows, title="My Spend Over Time", summary_prefix="Your monthly spend trend")

    by_dept = _top_items(_sum(rows, "department"), 10)
    return {
        "title": "Spend by Department",
        "summary": f"Department breakdown from {_csv_name()}.",
        "chart": {
            "type": "bar",
            "labels": [d for d, _ in by_dept],
            "values": [a for _, a in by_dept],
        },
    }


def get_charts_for_query(user_message: str, conversation_history=None, employee_name=None):
    from spending_query import analyze_spending_query

    return analyze_spending_query(user_message, conversation_history, employee_name)


def get_dashboard(employee_name=None):
    rows = scoped_expenses(employee_name)
    by_emp = _sum(rows, "employee")

    by_month = defaultdict(float)
    for r in rows:
        by_month[r["month"]] += r["amount"]
    months = sorted(by_month.keys())
    monthly_values = [by_month[m] for m in months]
    cumulative_total = 0.0
    cumulative_values = []
    for amount in monthly_values:
        cumulative_total += amount
        cumulative_values.append(round(cumulative_total, 2))

    recent = sorted(rows, key=lambda x: x["date"], reverse=True)[:12]
    top_employees = _top_items(by_emp, 8)

    credit_scores = {}
    emp_meta = employees_by_name()
    for emp in by_emp:
        emp_rows = [r for r in rows if r["employee"] == emp]
        credit_scores[emp] = _employee_credit_score(emp_rows, by_emp[emp])

    if employee_name:
        by_dept = _sum(rows, "department")
        by_cat = _sum(rows, "category")
        cat_items = sorted(by_cat.items(), key=lambda x: -x[1])
        cat_labels = [c for c, _ in cat_items if c]
        cat_values = [v for c, v in cat_items if c]
        dept_items = sorted(by_dept.items(), key=lambda x: -x[1])
        dept_labels = [d for d, _ in dept_items]
        dept_values = [v for _, v in dept_items]
        departments = [
            {
                "department": dept,
                "total_spent_fmt": format_money(total),
                "transaction_count": sum(1 for r in rows if r.get("department") == dept),
                "flagged_transactions": sum(
                    1 for r in rows if r.get("department") == dept and r.get("flagged") == "yes"
                ),
                "average_score": credit_scores.get(employee_name, 80.0),
            }
            for dept, total in dept_items
        ]
        overview = {
            "transactions": len(rows),
            "employees": 1,
            "departments": len(by_dept),
            "flags": sum(1 for r in rows if r.get("flagged") == "yes"),
        }
    else:
        dept_df = department_summary()
        if not dept_df.empty:
            dept_df = dept_df.sort_values("total_spent", ascending=False)
            dept_labels = [r.department for r in dept_df.itertuples()]
            dept_values = [float(r.total_spent) for r in dept_df.itertuples()]
            departments = [
                {
                    "department": r.department,
                    "total_spent_fmt": f"${float(r.total_spent):,.2f}",
                    "transaction_count": int(r.transaction_count),
                    "flagged_transactions": int(r.flagged_transactions),
                    "average_score": float(r.average_score_after_transactions),
                }
                for r in dept_df.itertuples()
            ]
        else:
            dept_labels = []
            dept_values = []
            departments = []
        by_cat = _sum(rows, "category")
        cat_items = sorted(by_cat.items(), key=lambda x: -x[1])
        cat_labels = [c for c, _ in cat_items if c]
        cat_values = [v for c, v in cat_items if c]
        overview = overview_totals()

    return {
        "scope": "employee" if employee_name else "company",
        "employee_name": employee_name,
        "totals": {
            **overview,
            "spend": sum(r["amount"] for r in rows),
        },
        "by_employee": {
            "labels": [e for e, _ in top_employees],
            "values": [a for _, a in top_employees],
        },
        "by_employee_all": {
            "labels": list(by_emp.keys()),
            "values": list(by_emp.values()),
        },
        "by_department": {
            "labels": dept_labels,
            "values": dept_values,
        },
        "by_category": {
            "labels": cat_labels,
            "values": cat_values,
        },
        "departments": departments,
        "by_month": {
            "labels": months,
            "values": monthly_values,
            "cumulative": cumulative_values,
        },
        "credit_scores": [
            {
                "name": emp,
                "dept": emp_meta.get(emp, {}).get("department", next((r["home_department"] for r in rows if r["employee"] == emp), "—")),
                "score": credit_scores[emp],
                "initials": "".join(part[0] for part in emp.split()[:2]),
            }
            for emp in by_emp
        ],
        "recent": [
            {
                "date": r["date"].strftime("%b %d, %Y"),
                "employee": r["employee"],
                "department": r["home_department"],
                "vendor": r["vendor"],
                "category": r["category"],
                "amount": format_money(r["amount"]),
                "location": r["location"],
                "flagged": r.get("flagged") == "yes",
                "flag_reason": r.get("flag_reason", ""),
                "risk_level": r.get("risk_level", ""),
            }
            for r in recent
        ],
    }


def list_purchases(employee_name=None):
    """All debit purchases for the activity table."""
    rows = scoped_expenses(employee_name)
    departments = sorted({r["department"] for r in rows if r.get("department")})
    categories = sorted({r["category"] for r in rows if r.get("category")})
    employees = sorted({r["employee"] for r in rows if r.get("employee")})

    purchases = []
    for idx, r in enumerate(rows):
        purchases.append({
            "id": idx,
            "date": r["date"].strftime("%b %d, %Y"),
            "date_sort": r["date"].strftime("%Y-%m-%d"),
            "employee": r["employee"],
            "department": r["department"],
            "vendor": r["vendor"],
            "category": r["category"],
            "amount": format_money(r["amount"]),
            "amount_raw": round(r["amount"], 2),
            "location": r["location"],
            "street_address": r.get("street_address") or "",
            "flagged": r.get("flagged") == "yes",
            "flag_reason": r.get("flag_reason") or "",
            "status": r.get("status") or "",
        })

    purchases.sort(key=lambda item: item["date_sort"], reverse=True)
    return {
        "purchases": purchases,
        "total": len(purchases),
        "departments": departments,
        "categories": categories,
        "employees": employees,
    }


def _employee_credit_score(emp_rows, total):
    if not emp_rows:
        return 80.0
    score = credit_score_for_name(emp_rows[0]["employee"])
    return score if score is not None else 80.0


def _employee_summary(rows):
    total = sum(r["amount"] for r in rows)
    by_city_items = _top_items(_sum_by_city(rows), 8)
    by_month = defaultdict(float)
    for r in rows:
        by_month[r["month"]] += r["amount"]
    months = sorted(by_month.keys())
    top_vendors = _top_items(_sum(rows, "vendor"), 8)
    flagged = [r for r in rows if r.get("flagged") == "yes"]
    recent = sorted(rows, key=lambda x: x["date"], reverse=True)[:30]

    return {
        "total_spend": total,
        "total_spend_fmt": format_money(total),
        "transaction_count": len(rows),
        "flagged_count": len(flagged),
        "credit_score": _employee_credit_score(rows, total),
        "by_city": {
            "labels": [city for city, _ in by_city_items],
            "values": [amount for _, amount in by_city_items],
        },
        "by_month": {"labels": months, "values": [by_month[m] for m in months]},
        "top_vendors": [
            {"vendor": v, "amount": format_money(a), "raw": a} for v, a in top_vendors
        ],
        "flagged_transactions": [
            {
                "date": r["date"].strftime("%b %d, %Y"),
                "vendor": r["vendor"],
                "category": r["category"],
                "amount": format_money(r["amount"]),
                "location": r["location"],
                "reason": r.get("flag_reason", ""),
                "risk_level": r.get("risk_level", ""),
            }
            for r in sorted(flagged, key=lambda x: x["amount"], reverse=True)[:15]
        ],
        "recent_transactions": [
            {
                "date": r["date"].strftime("%b %d, %Y"),
                "vendor": r["vendor"],
                "category": r["category"],
                "amount": format_money(r["amount"]),
                "location": r["location"],
                "flagged": r.get("flagged") == "yes",
                "reason": r.get("flag_reason", ""),
                "risk_level": r.get("risk_level", ""),
            }
            for r in recent
        ],
    }


def list_employees(employee_name=None):
    rows = scoped_expenses(employee_name)
    meta = employees_by_name()
    by_emp = _sum(rows, "employee")
    result = []
    for emp, total in by_emp.items():
        emp_rows = [r for r in rows if r["employee"] == emp]
        emp_meta = meta.get(emp, {})
        result.append({
            "name": emp,
            "employee_id": emp_rows[0]["employee_id"],
            "department": emp_meta.get("department", emp_rows[0].get("home_department", "—")),
            "total_spend": total,
            "total_spend_fmt": format_money(total),
            "transaction_count": len(emp_rows),
            "flagged_count": int(emp_meta.get("flagged_transactions", sum(1 for r in emp_rows if r.get("flagged") == "yes"))),
            "credit_score": _employee_credit_score(emp_rows, total),
            "summary": emp_meta.get("one_sentence_summary", ""),
        })
    return sorted(result, key=lambda item: item["credit_score"])


def get_employee_detail(name, employee_name=None):
    if employee_name and name != employee_name:
        return None
    rows = scoped_expenses(employee_name)
    emp_rows = _filter(rows, employee=name)
    if not emp_rows:
        return None
    summary = _employee_summary(emp_rows)
    emp_meta = employees_by_name().get(name, {})
    detail = {
        "name": name,
        "employee_id": emp_rows[0]["employee_id"],
        "department": emp_meta.get("department", emp_rows[0].get("home_department", "—")),
        "summary": emp_meta.get("one_sentence_summary", ""),
        **summary,
    }
    if emp_meta.get("flagged_transactions") is not None:
        detail["flagged_count"] = int(emp_meta["flagged_transactions"])
    return detail


def compare_employees(names, employee_name=None):
    if employee_name:
        names = [n for n in names if n == employee_name]
        if not names:
            return None
    rows = scoped_expenses(employee_name)
    names = [n for n in names if n]
    if len(names) < 1:
        return None

    employees = []
    for name in names:
        emp_rows = _filter(rows, employee=name)
        if not emp_rows:
            continue
        summary = _employee_summary(emp_rows)
        employees.append({"name": name, "employee_id": emp_rows[0]["employee_id"], **summary})

    if not employees:
        return None

    all_cities = sorted({city for e in employees for city in e["by_city"]["labels"]})
    comparison_cities = {
        "labels": all_cities,
        "datasets": [
            {
                "name": e["name"],
                "values": [
                    e["by_city"]["values"][e["by_city"]["labels"].index(city)]
                    if city in e["by_city"]["labels"]
                    else 0
                    for city in all_cities
                ],
            }
            for e in employees
        ],
    }

    return {
        "employees": employees,
        "comparison": {
            "totals": [
                {"name": e["name"], "total": e["total_spend_fmt"], "raw": e["total_spend"]}
                for e in employees
            ],
            "by_city": comparison_cities,
        },
    }


_geocode_cache = {}
_location_coords = None


def _load_location_coords():
    import json

    global _location_coords
    if _location_coords is not None:
        return _location_coords

    path = str(LOCATION_COORDS_PATH)
    try:
        with open(path, encoding="utf-8") as f:
            _location_coords = json.load(f)
    except (OSError, json.JSONDecodeError):
        _location_coords = {}

    return _location_coords


def _geocode_nominatim(city, state, country):
    import json
    import urllib.parse
    import urllib.request

    country_name = "Canada" if country == "CAN" else "United States" if country == "USA" else country
    query = ", ".join(part for part in (city, state, country_name) if part)
    return _geocode_nominatim_address(query)


def _geocode_nominatim_address(address):
    import json
    import urllib.parse
    import urllib.request

    address = (address or "").strip()
    if not address:
        return None

    cache_key = f"osm|{address}"
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    try:
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"q": address, "format": "json", "limit": 1}
        )
        req = urllib.request.Request(url, headers={"User-Agent": "CashFluxHackathon/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        if data:
            coords = {"lat": float(data[0]["lat"]), "lng": float(data[0]["lon"])}
            _geocode_cache[cache_key] = coords
            return coords
    except Exception:
        pass

    _geocode_cache[cache_key] = None
    return None


def _geocode_address(address, api_key):
    import json
    import urllib.parse
    import urllib.request

    address = (address or "").strip()
    if not address:
        return None

    cache_key = f"addr|{address}"
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    coords = _geocode_address_google_only(address, api_key) if api_key else None
    if not coords:
        coords = _geocode_nominatim_address(address)
    if not coords:
        coords = _geocode_photon_address(address)
    if coords:
        _geocode_cache[cache_key] = coords
        return coords

    _geocode_cache[cache_key] = None
    return None


def _geocode_location(city, state, country, api_key, location_label=None):
    import json
    import urllib.parse
    import urllib.request

    query = ", ".join(part for part in (city, state, country) if part)
    if query in _geocode_cache:
        return _geocode_cache[query]

    if location_label:
        preset = _load_location_coords().get(location_label)
        if preset:
            _geocode_cache[query] = preset
            return preset

    if api_key:
        try:
            url = "https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode(
                {"address": query, "key": api_key}
            )
            with urllib.request.urlopen(url, timeout=6) as resp:
                data = json.loads(resp.read().decode())
            if data.get("status") == "OK" and data.get("results"):
                loc = data["results"][0]["geometry"]["location"]
                coords = {"lat": loc["lat"], "lng": loc["lng"]}
                _geocode_cache[query] = coords
                return coords
        except Exception:
            pass

    return _geocode_nominatim(city, state, country)


def _base_coords(
    city,
    state,
    country,
    postal,
    api_key,
    *,
    location_label=None,
    full_address=None,
    street_address=None,
):
    """Resolve coordinates — street address first when available."""
    if _valid_street(street_address):
        query = _street_geocode_query(street_address, city, state, country, postal)
        coords = _geocode_street_cached(query, street_address, postal, state, country, api_key)
        if coords:
            return coords

    if full_address:
        coords = _geocode_address(full_address, api_key)
        if coords:
            return coords

    if _valid_postal(postal):
        coords = _geocode_postal(postal, country)
        if coords:
            return coords

    if location_label:
        preset = _load_location_coords().get(location_label)
        if preset:
            return preset

    if _valid_city(city):
        coords = _geocode_location(city, state, country, api_key, location_label=location_label)
        if coords:
            return coords

    if _valid_postal(postal):
        query = ", ".join(part for part in (postal, state, country) if part)
        coords = _geocode_address(query, api_key)
        if coords:
            return coords

    return None


def get_map_locations(api_key=None, limit=40, employee_name=None):
    rows = scoped_expenses(employee_name)
    buckets = {}

    for row in rows:
        if not _mappable_row(row):
            continue

        key = row["location"]
        if key not in buckets:
            buckets[key] = {
                "location": key,
                "city": row.get("city") or "",
                "state": row.get("state") or "",
                "country": row.get("country") or "",
                "postal": row.get("postal") or "",
                "full_address": row.get("full_address") or "",
                "street_address": row.get("street_address") or "",
                "spend": 0.0,
                "transactions": 0,
                "flagged": 0,
                "employees": set(),
                "merchants": set(),
            }

        bucket = buckets[key]
        bucket["spend"] += row["amount"]
        bucket["transactions"] += 1
        bucket["employees"].add(row["employee"])
        bucket["merchants"].add((row["vendor"], row.get("postal") or ""))
        if row.get("flagged") == "yes":
            bucket["flagged"] += 1

    ranked = sorted(buckets.values(), key=lambda item: item["spend"], reverse=True)
    locations = []

    for bucket in ranked:
        if len(locations) >= limit:
            break

        coords = _base_coords(
            bucket["city"],
            bucket["state"],
            bucket["country"],
            bucket["postal"],
            api_key,
            location_label=bucket["location"],
            full_address=bucket.get("full_address"),
            street_address=bucket.get("street_address"),
        )
        if not coords:
            continue

        locations.append({
            "location": bucket["location"],
            "lat": coords["lat"],
            "lng": coords["lng"],
            "spend": round(bucket["spend"], 2),
            "spend_fmt": format_money(bucket["spend"]),
            "transactions": bucket["transactions"],
            "merchant_count": len(bucket["merchants"]),
            "flagged": bucket["flagged"],
            "employees": sorted(bucket["employees"]),
        })

    total_spend = sum(item["spend"] for item in locations)
    return {
        "locations": locations,
        "plotted": len(locations),
        "total_locations": len(buckets),
        "mapped_spend": round(total_spend, 2),
        "mapped_spend_fmt": format_money(total_spend),
    }


_postal_geocode_cache = {}
_merchant_index = None
_purchase_map_index = None
_purchase_map_index_mtime = None
_postal_coords_file = None
_street_coords_file = None
_street_coords_dirty = False


def _load_street_coords():
    global _street_coords_file
    import json

    if _street_coords_file is not None:
        return _street_coords_file

    path = str(STREET_COORDS_PATH)
    try:
        with open(path, encoding="utf-8") as f:
            _street_coords_file = json.load(f)
    except (OSError, json.JSONDecodeError):
        _street_coords_file = {}

    return _street_coords_file


def _save_street_coords():
    global _street_coords_dirty
    if not _street_coords_dirty:
        return
    import json
    STREET_COORDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    STREET_COORDS_PATH.write_text(json.dumps(_load_street_coords(), indent=2), encoding="utf-8")
    _street_coords_dirty = False


def _geocode_street_cached(query, street, postal, state, country, api_key, full_address=None):
    cache_key = _street_cache_key(street, postal, state, country)
    if not cache_key:
        return None

    cached = _load_street_coords().get(cache_key)
    if cached and _street_cache_verified(cached):
        return _street_cache_coords(cached)

    geocode_query = (full_address or query or "").strip()
    if not geocode_query:
        return None

    coords, source = _geocode_street_query(
        geocode_query,
        api_key,
        postal=postal,
        country=country,
    )
    if not coords:
        return None

    _load_street_coords()[cache_key] = {
        "lat": coords["lat"],
        "lng": coords["lng"],
        "verified": True,
        "source": source or "geocode",
    }
    _geocode_cache[f"addr|{geocode_query}"] = coords
    global _street_coords_dirty
    _street_coords_dirty = True
    return coords


def _load_postal_coords():
    global _postal_coords_file
    if _postal_coords_file is not None:
        return _postal_coords_file

    path = str(POSTAL_COORDS_PATH)
    try:
        with open(path, encoding="utf-8") as f:
            import json
            _postal_coords_file = json.load(f)
    except (OSError, json.JSONDecodeError):
        _postal_coords_file = {}

    return _postal_coords_file


def _geocode_postal(postal, country):
    import json
    import re
    import urllib.error
    import urllib.request

    cache_key = f"{postal}|{country}"
    if cache_key in _postal_geocode_cache:
        return _postal_geocode_cache[cache_key]

    preset = _load_postal_coords().get(cache_key)
    if preset:
        _postal_geocode_cache[cache_key] = preset
        return preset

    country = (country or "").upper()
    cleaned = re.sub(r"[^A-Z0-9]", "", postal.upper())
    url = None

    if country == "USA" and len(cleaned) >= 5:
        url = f"https://api.zippopotam.us/us/{cleaned[:5]}"
    elif country == "CAN" and len(cleaned) >= 3:
        url = f"https://api.zippopotam.us/ca/{cleaned[:3]}"

    if not url:
        _postal_geocode_cache[cache_key] = None
        return None

    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        place = data["places"][0]
        coords = {"lat": float(place["latitude"]), "lng": float(place["longitude"])}
        _postal_geocode_cache[cache_key] = coords
        return coords
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, ValueError, IndexError):
        _postal_geocode_cache[cache_key] = None
        return None


def _merchant_site_key(row) -> str:
    """Group multiple purchases at the same merchant address."""
    vendor = str(row.get("vendor") or "").strip().upper()
    sk = _street_cache_key(
        row.get("street_address"),
        row.get("postal"),
        row.get("state"),
        row.get("country"),
    )
    if sk:
        return f"{vendor}|{sk}"
    postal = str(row.get("postal") or "").strip().upper()
    location = str(row.get("location") or "").strip().upper()
    return f"{vendor}|{postal}|{location}"


def _row_to_site_fields(row) -> dict:
    return {
        "vendor": row["vendor"],
        "employee": row["employee"],
        "department": row.get("department") or "",
        "location": row["location"],
        "street_address": row.get("street_address") or "",
        "street_key": _street_cache_key(
            row.get("street_address"),
            row.get("postal"),
            row.get("state"),
            row.get("country"),
        ),
        "city": row.get("city") or "",
        "state": row.get("state") or "",
        "country": row.get("country") or "",
        "postal": row.get("postal") or "",
        "full_address": row.get("full_address") or "",
    }


def _resolve_merchant_coords(site: dict, api_key=None, street_cache=None) -> tuple[dict | None, str]:
    """Place a merchant at its street address when possible (no per-transaction jitter)."""
    street_cache = street_cache or _load_street_coords()
    sk = site.get("street_key") or ""

    if sk:
        cached = street_cache.get(sk)
        if cached and _street_cache_verified(cached):
            return _street_cache_coords(cached), "street"

    geocode_query = _merchant_geocode_query(site)
    if geocode_query and (_valid_street(site.get("street_address")) or site.get("full_address")):
        coords = _geocode_street_cached(
            geocode_query,
            site.get("street_address"),
            site.get("postal"),
            site.get("state"),
            site.get("country"),
            api_key,
            full_address=site.get("full_address"),
        )
        if coords:
            via = "street" if _valid_street(site.get("street_address")) else "geocode"
            return coords, via

    if api_key:
        coords = _base_coords(
            site.get("city") or "",
            site.get("state") or "",
            site.get("country") or "",
            site.get("postal") or "",
            api_key,
            location_label=site.get("location"),
            full_address=site.get("full_address"),
            street_address=site.get("street_address"),
        )
        if coords:
            return coords, "street" if _valid_street(site.get("street_address")) else "geocode"

    coords = _coords_from_cache_or_postal(site, street_cache)
    if coords:
        via = "street" if sk and sk in street_cache and _street_cache_verified(street_cache[sk]) else "postal"
        return coords, via
    return None, "missing"


def _separate_overlapping_markers(markers: list[dict]) -> None:
    """Only nudge apart different merchants that share the same coordinates."""
    buckets: dict[str, list[dict]] = {}
    for marker in markers:
        bucket_key = f"{round(marker['lat'], 5)}|{round(marker['lng'], 5)}"
        buckets.setdefault(bucket_key, []).append(marker)

    for group in buckets.values():
        if len(group) <= 1:
            continue
        base = {"lat": group[0]["lat"], "lng": group[0]["lng"]}
        for index, marker in enumerate(group):
            if index == 0:
                continue
            point = _offset_coords(base["lat"], base["lng"], marker["id"])
            marker["lat"] = point["lat"]
            marker["lng"] = point["lng"]


def _offset_coords(lat, lng, seed):
    import hashlib
    import math

    digest = hashlib.md5(seed.encode()).hexdigest()
    h = int(digest[:8], 16)
    angle = (h % 360) * math.pi / 180
    radius = 0.00015 + (h % 40) * 0.00001
    lat_rad = math.radians(lat)
    return {
        "lat": lat + radius * math.cos(angle),
        "lng": lng + (radius * math.sin(angle)) / max(math.cos(lat_rad), 0.2),
    }


def _purchase_row_id(row):
    dt = row["date"].strftime("%Y-%m-%d") if row.get("date") else ""
    return f"{row.get('employee_id', '')}|{dt}|{row.get('vendor', '')}|{row.get('amount', 0)}"


def _coords_from_cache_or_postal(d, street_cache=None):
    """Fast coordinate lookup: verified street cache, postal preset, or location preset."""
    street_cache = street_cache or _load_street_coords()
    sk = _street_cache_key(
        d.get("street_address"),
        d.get("postal"),
        d.get("state"),
        d.get("country"),
    )
    if sk and sk in street_cache:
        entry = street_cache[sk]
        if _street_cache_verified(entry):
            return _street_cache_coords(entry)

    if _valid_postal(d.get("postal")):
        coords = _geocode_postal(d.get("postal"), d.get("country"))
        if coords:
            return coords

    label = d.get("location")
    if label:
        preset = _load_location_coords().get(label)
        if preset:
            return preset

    return None


def _geocode_streets_for_purchases(purchases, api_key, geocode_budget=60):
    """Geocode uncached street addresses and refresh exact marker positions."""
    import time

    street_cache = _load_street_coords()
    remaining = max(int(geocode_budget or 0), 0) if api_key else len(purchases) + 1
    seen_keys: set[str] = set()

    for purchase in purchases:
        sk = purchase.get("street_key")
        if not sk or sk in seen_keys:
            continue
        seen_keys.add(sk)
        cached = street_cache.get(sk)
        if cached and _street_cache_verified(cached):
            continue
        if not _valid_street(purchase.get("street_address")) and not purchase.get("full_address"):
            continue
        if api_key and remaining <= 0:
            break
        query = _merchant_geocode_query(purchase)
        if _geocode_street_cached(
            query,
            purchase["street_address"],
            purchase.get("postal"),
            purchase.get("state"),
            purchase.get("country"),
            api_key,
            full_address=purchase.get("full_address"),
        ):
            if api_key:
                remaining -= 1
            else:
                time.sleep(1.05)

    for purchase in purchases:
        coords, via = _resolve_merchant_coords(purchase, api_key=None, street_cache=street_cache)
        if not coords:
            continue
        purchase["lat"] = coords["lat"]
        purchase["lng"] = coords["lng"]
        purchase["geocoded_via"] = via

    _separate_overlapping_markers(purchases)
    _save_street_coords()


def _build_purchase_map_index(api_key=None, geocode_budget=0):
    global _purchase_map_index, _purchase_map_index_mtime
    try:
        mtime = os.path.getmtime(_csv_path())
    except OSError:
        mtime = None
    if _purchase_map_index is not None and _purchase_map_index_mtime == mtime:
        return _purchase_map_index

    rows = load_expenses()
    groups: dict[str, dict] = {}
    street_cache = _load_street_coords()

    for row in rows:
        if not _mappable_row(row):
            continue

        key = _merchant_site_key(row)
        if key not in groups:
            site = _row_to_site_fields(row)
            groups[key] = {
                **site,
                "id": key,
                "transactions": 0,
                "spend": 0.0,
                "flagged": 0,
                "employees": set(),
                "dates": [],
            }

        group = groups[key]
        group["transactions"] += 1
        group["spend"] += row["amount"]
        if row.get("flagged") == "yes":
            group["flagged"] += 1
        group["employees"].add(row["employee"])
        group["dates"].append(row["date"].strftime("%b %d, %Y"))

    purchases: list[dict] = []
    remaining = max(int(geocode_budget or 0), 0)

    for key, group in groups.items():
        use_api = remaining > 0 and bool(api_key)
        coords, via = _resolve_merchant_coords(group, api_key if use_api else None, street_cache)
        if use_api and coords and via in ("street", "geocode"):
            remaining -= 1
        if not coords:
            continue

        dates = group["dates"]
        if len(dates) == 1:
            date_label = dates[0]
        elif dates:
            date_label = f"{dates[0]} – {dates[-1]}"
        else:
            date_label = ""

        employee_list = sorted(group["employees"])
        purchases.append({
            "id": key,
            "vendor": group["vendor"],
            "employee": employee_list[0] if len(employee_list) == 1 else f"{len(employee_list)} employees",
            "department": group["department"],
            "location": group["location"],
            "street_address": group["street_address"],
            "street_key": group["street_key"],
            "city": group["city"],
            "state": group["state"],
            "country": group["country"],
            "postal": group["postal"],
            "full_address": group["full_address"],
            "display_address": _merchant_display_address(group),
            "lat": coords["lat"],
            "lng": coords["lng"],
            "spend": round(group["spend"], 2),
            "spend_fmt": format_money(group["spend"]),
            "transactions": group["transactions"],
            "flagged": group["flagged"],
            "categories": [],
            "employees": employee_list,
            "date": date_label,
            "geocoded_via": via,
        })

    _separate_overlapping_markers(purchases)
    _save_street_coords()
    _purchase_map_index = purchases
    _purchase_map_index_mtime = mtime
    return purchases


def _merchant_coords(vendor, location, city, state, country, postal, api_key, full_address=None, street_address=None):
    cache_key = f"{vendor}|{location}|{postal}"
    if cache_key in _geocode_cache:
        cached = _geocode_cache[cache_key]
        if cached:
            return cached

    base = _base_coords(
        city, state, country, postal, api_key,
        location_label=location,
        full_address=full_address,
        street_address=street_address,
    )
    if not base:
        return None

    postal_seed = f"{postal}|{location}" if _valid_postal(postal) else location
    postal_point = _offset_coords(base["lat"], base["lng"], postal_seed)
    coords = _offset_coords(postal_point["lat"], postal_point["lng"], vendor)
    _geocode_cache[cache_key] = coords
    return coords


def _in_bounds(lat, lng, north, south, east, west):
    if lat < south or lat > north:
        return False
    if west <= east:
        return west <= lng <= east
    return lng >= west or lng <= east


def _build_merchant_index(api_key=None, geocode_budget=120):
    return _build_purchase_map_index(api_key, geocode_budget)


def get_map_merchants(api_key=None, north=None, south=None, east=None, west=None, limit=400, geocode_budget=60, employee_name=None):
    merchants = _build_purchase_map_index(api_key=api_key, geocode_budget=min(geocode_budget, 40))
    if employee_name:
        merchants = [
            m for m in merchants
            if employee_name in (m.get("employees") or [])
        ]
    has_bounds = None not in (north, south, east, west)

    if has_bounds:
        candidates = [
            m for m in merchants
            if _in_bounds(m["lat"], m["lng"], north, south, east, west)
        ]
    else:
        candidates = list(merchants)

    _geocode_streets_for_purchases(candidates, api_key, geocode_budget=geocode_budget)

    if has_bounds:
        filtered = [
            m for m in candidates
            if _in_bounds(m["lat"], m["lng"], north, south, east, west)
        ]
    else:
        filtered = candidates

    filtered.sort(key=lambda item: (-item["flagged"], -item["transactions"], -item["spend"], item["vendor"]))
    selected = filtered[:limit]

    return {
        "merchants": selected,
        "plotted": len(selected),
        "total_in_view": len(filtered),
        "total_merchants": len(merchants),
    }


def __getattr__(name: str):
    if name == "CSV_NAME":
        return _csv_name()
    raise AttributeError(name)
