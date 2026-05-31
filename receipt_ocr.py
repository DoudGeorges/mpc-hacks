"""Receipt OCR — Gemini Vision extraction + CSV transaction matching."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from typing import Any

from expense_data import scoped_expenses
from formatting import EMPTY_LABEL, sanitize_display_text
from guardian_data import employees_by_name

RECEIPT_PROMPT = """You are a precise receipt-data-extraction system for a corporate expense platform.

Read the ENTIRE receipt carefully. Extract structured fields and respond ONLY with JSON:
{
  "merchant_name": "STATION AXIA",
  "transaction_description": "STATION AXIA MONTREAL QC",
  "amount": 25.50,
  "date": "2025-09-15",
  "type": "Debit",
  "mcc": "5541",
  "expense_category": "Fuel",
  "tax": 3.32,
  "tip": null,
  "merchant_city": "MONTREAL",
  "merchant_state": "QC",
  "merchant_country": "CAN",
  "merchant_postal_code": "H2X 1Y4",
  "currency": "CAD",
  "conversion_rate": 0,
  "line_items": [{"description": "Regular Unleaded 30.5L", "amount": 22.18}],
  "business_relevant": true,
  "business_relevance": "clear_business",
  "relevance_note": "Fuel for business travel"
}

Rules:
- merchant_name: legal business name in ALL CAPS, not guessed from logos
- date: YYYY-MM-DD or null
- amount: grand total after tax/tip (float, 2 decimals)
- expense_category: one of Fuel, Meals & Entertainment, Lodging, Transportation, Vehicle Maintenance, Permits & Fees, Office Supplies, Software & Subscriptions, Telecommunications, General Business
- type: Debit or Credit
- is_restaurant_or_cafe: true when this is a restaurant, café, coffee shop, bar, or other sit-down / take-out meal venue (not grocery or fuel)
- business_relevant: false when the purchase is personal, recreational, or unrelated to a B2B professional services / analytics company (e.g. collectibles, blind boxes, toys, hobby gaming, lottery, personal apparel, streaming subscriptions, gym, salon)
- business_relevance: one of clear_business, unclear, likely_personal, non_business
- relevance_note: one short sentence explaining why (required when business_relevant is false or business_relevance is not clear_business)

Company context: employees work for a professional B2B analytics / consulting firm. Reasonable expenses include client travel, software, office supplies, conferences, team/client meals, and fuel. Flag blind boxes, Pop Mart, Labubu, figurines, trading cards, plush toys, gacha, video-game collectibles, and similar items with no plausible work purpose.
"""

DINING_MCC = {5812, 5813, 5814, 5462, 5499}

DINING_CATEGORY_KEYWORDS = (
    "meal", "restaurant", "food", "entertainment", "dining", "cafe", "café", "coffee",
)

DINING_MERCHANT_KEYWORDS = (
    "restaurant", "cafe", "café", "coffee", "starbucks", "tim hort", "bistro", "grill",
    "deli", "pizza", "sushi", "pub", "tavern", "bar ", "kitchen", "eatery", "brasserie",
    "bakery", "bagel", "diner", "steakhouse", "wings", "burrito", "subway", "mcdonald",
    "schwartz", "st-hubert", "rotisserie",
)

DEFAULT_IRRELEVANT_KEYWORDS = (
    "blind box", "blindbox", "pop mart", "popmart", "labubu", "gacha", "collectible",
    "figurine", "funko", "plush", "trading card", "pokemon card", "yugioh", "magic the gathering",
    "lottery", "scratch ticket", "steam game", "playstation", "xbox game", "nintendo",
    "anime merch", "k-pop merch", "sticker pack", "surprise box", "mystery box",
    "toy store", "hobby shop", "comic book", "action figure", "lego set",
)


def _irrelevant_business_keywords() -> tuple[str, ...]:
    try:
        from policy_engine import load_policy_rules

        rules = load_policy_rules()
        keywords = rules.get("irrelevant_business_keywords") or []
        if keywords:
            return tuple(str(k).lower() for k in keywords if str(k).strip())
    except Exception:
        pass
    return DEFAULT_IRRELEVANT_KEYWORDS


def _receipt_content_blob(extracted: dict) -> str:
    parts = [
        str(extracted.get("merchant_name") or ""),
        str(extracted.get("transaction_description") or ""),
        str(extracted.get("expense_category") or ""),
        str(extracted.get("relevance_note") or ""),
    ]
    for item in extracted.get("line_items") or []:
        if isinstance(item, dict):
            parts.append(str(item.get("description") or ""))
        else:
            parts.append(str(item))
    return " ".join(parts).lower()


def _keyword_irrelevance_hit(blob: str) -> str | None:
    for keyword in _irrelevant_business_keywords():
        if keyword and keyword in blob:
            return keyword
    return None


def check_business_relevance(extracted: dict, matched: dict | None = None) -> list[dict]:
    """Flag receipts that look personal or unrelated to company business."""
    violations: list[dict] = []
    if not extracted or extracted.get("error"):
        return violations

    blob = _receipt_content_blob(extracted)
    if matched:
        blob = " ".join([
            blob,
            str(matched.get("merchant_name") or "").lower(),
            str(matched.get("category") or "").lower(),
        ])

    ai_relevant = extracted.get("business_relevant")
    ai_level = str(extracted.get("business_relevance") or "").strip().lower()
    ai_note = str(extracted.get("relevance_note") or "").strip()

    if ai_relevant is False or ai_level in ("likely_personal", "non_business"):
        note = ai_note or "Purchase appears unrelated to company business."
        violations.append({
            "type": "non_business_expense",
            "description": sanitize_display_text(f"Not a valid business expense. {note}"),
            "severity": "high",
        })
        return violations

    if ai_level == "unclear" and ai_note:
        violations.append({
            "type": "unclear_business_purpose",
            "description": sanitize_display_text(f"Business purpose unclear. {ai_note}"),
            "severity": "medium",
        })
        return violations

    hit = _keyword_irrelevance_hit(blob)
    if hit:
        violations.append({
            "type": "non_business_expense",
            "description": (
                f"Likely non-business purchase ('{hit}'). "
                "Collectibles, blind boxes, toys, and hobby items are not reimbursable."
            ),
            "severity": "high",
        })

    return violations


def is_dining_receipt(extracted: dict | None, matched: dict | None = None) -> bool:
    """True when the receipt looks like a restaurant, café, or meal purchase."""
    ext = extracted or {}
    if ext.get("is_restaurant_or_cafe") is True:
        return True
    if ext.get("is_restaurant_or_cafe") is False:
        pass  # model may still be wrong; fall through to heuristics

    cat = str(ext.get("expense_category") or "").lower()
    if any(k in cat for k in DINING_CATEGORY_KEYWORDS):
        return True

    mcc = ext.get("mcc")
    try:
        if mcc is not None and int(float(mcc)) in DINING_MCC:
            return True
    except (TypeError, ValueError):
        pass

    merchant = str(ext.get("merchant_name") or "").lower()
    if any(k in merchant for k in DINING_MERCHANT_KEYWORDS):
        return True

    if matched:
        mcat = str(matched.get("category") or "").lower()
        if "meal" in mcat:
            return True

    return False


def _safe_json(text: str) -> dict:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": "Could not parse receipt data", "raw": text[:500]}


def _transaction_key(row: dict) -> str:
    date_str = row["date"].strftime("%Y-%m-%d") if row.get("date") else ""
    return f"{row.get('employee_id', '')}|{date_str}|{row.get('vendor', '')}|{round(float(row.get('amount') or 0), 2)}"


def _merchant_matches(receipt_merchant: str, vendor: str) -> bool:
    if not receipt_merchant or not vendor:
        return False
    a = re.sub(r"[^a-z0-9]+", "", receipt_merchant.lower())[:15]
    b = re.sub(r"[^a-z0-9]+", "", vendor.lower())
    return bool(a and (a in b or b in a))


def find_matching_transaction(
    extracted: dict,
    *,
    employee_id: str | None = None,
    employee_name: str | None = None,
) -> dict | None:
    rows = scoped_expenses(employee_name)
    if employee_id:
        rows = [r for r in rows if r.get("employee_id") == employee_id]

    receipt_amount = extracted.get("amount")
    receipt_date = extracted.get("date")
    merchant = extracted.get("merchant_name") or ""

    try:
        amt = float(receipt_amount) if receipt_amount is not None else None
    except (TypeError, ValueError):
        amt = None

    dt = None
    if receipt_date:
        try:
            dt = datetime.strptime(str(receipt_date)[:10], "%Y-%m-%d")
        except ValueError:
            dt = None

    candidates = []
    for row in rows:
        if amt is not None:
            tolerance = max(amt * 0.02, 0.50)
            if abs(float(row["amount"]) - amt) > tolerance:
                continue
        if merchant and not _merchant_matches(merchant, row.get("vendor", "")):
            continue
        if dt and row.get("date"):
            delta = abs((row["date"].date() - dt.date()).days)
            if delta > 1:
                continue
        candidates.append(row)

    if not candidates:
        return None

    best = candidates[0]
    return {
        "transaction_id": _transaction_key(best),
        "employee_id": best.get("employee_id"),
        "employee_name": best.get("employee"),
        "merchant_name": best.get("vendor"),
        "amount_cad": round(float(best.get("amount") or 0), 2),
        "transaction_date": best["date"].strftime("%Y-%m-%d") if best.get("date") else "",
        "department": best.get("department"),
        "category": best.get("category"),
    }


def check_violations(extracted: dict, matched: dict | None) -> list[dict]:
    violations: list[dict] = []
    tip = extracted.get("tip")
    amount = float(extracted.get("amount") or 0)
    tax = float(extracted.get("tax") or 0)
    tip_val = float(tip or 0)
    subtotal = amount - tax - tip_val

    if tip_val and subtotal > 0:
        tip_pct = (tip_val / subtotal) * 100
        category = str(extracted.get("expense_category") or "").lower()
        if "meal" in category or "restaurant" in category or "food" in category or "entertainment" in category:
            if tip_pct > 20:
                violations.append({
                    "type": "excessive_tip",
                    "description": f"Meal tip {tip_pct:.1f}% exceeds 20% limit",
                    "severity": "low",
                })
        elif tip_pct > 15:
            violations.append({
                "type": "excessive_tip",
                "description": f"Service tip {tip_pct:.1f}% exceeds 15% limit",
                "severity": "low",
            })

    if matched and amount:
        diff = abs(amount - float(matched.get("amount_cad") or 0))
        if diff > 1.0:
            violations.append({
                "type": "amount_mismatch",
                "description": (
                    f"Receipt ${amount:.2f} differs from transaction "
                    f"${float(matched.get('amount_cad') or 0):.2f} by ${diff:.2f}"
                ),
                "severity": "medium",
            })

    violations.extend(check_business_relevance(extracted, matched))

    for violation in violations:
        if violation.get("description"):
            violation["description"] = sanitize_display_text(violation["description"])

    return violations


def _gemini_api_key() -> str | None:
    from dotenv import load_dotenv
    load_dotenv()
    key = os.getenv("API") or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    return key.strip() if key else None


def analyze_receipt(image_bytes: bytes, mime_type: str = "image/jpeg") -> dict:
    from google import genai
    from google.genai import types

    api_key = _gemini_api_key()
    if not api_key:
        return {"error": "Gemini API key not configured (set API or GEMINI_API_KEY in .env)"}

    client = genai.Client(api_key=api_key)
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                        types.Part.from_text(text=RECEIPT_PROMPT),
                    ],
                )
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.0,
            ),
        )
        return _safe_json(response.text)
    except Exception as exc:
        return {"error": str(exc)}


def process_receipt(
    file_bytes: bytes,
    mime_type: str,
    *,
    employee_id: str | None = None,
    employee_name: str | None = None,
) -> dict[str, Any]:
    extracted = analyze_receipt(file_bytes, mime_type=mime_type)
    if extracted.get("error"):
        return {
            "extracted_data": extracted,
            "matched_transaction": None,
            "violations": [],
        }

    if not employee_id and employee_name:
        meta = employees_by_name().get(employee_name, {})
        employee_id = meta.get("employee_id") or ""

    matched = find_matching_transaction(
        extracted,
        employee_id=employee_id,
        employee_name=employee_name,
    )
    violations = check_violations(extracted, matched)

    return {
        "extracted_data": extracted,
        "matched_transaction": matched,
        "violations": violations,
        "is_dining": is_dining_receipt(extracted, matched),
    }


from formatting import fmt_date as _fmt_date_base, fmt_money


def _fmt_money(value) -> str:
    try:
        return fmt_money(float(value))
    except (TypeError, ValueError):
        return EMPTY_LABEL


def _fmt_date(value) -> str:
    if not value:
        return EMPTY_LABEL
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").strftime("%b %d, %Y")
    except ValueError:
        return _fmt_date_base(value)


def build_receipt_card(result: dict) -> dict:
    """Shape scan result for chat receipt card UI."""
    ext = result.get("extracted_data") or {}
    matched = result.get("matched_transaction")
    violations = result.get("violations") or []

    fields = [
        {"label": "Merchant", "value": ext.get("merchant_name") or EMPTY_LABEL},
        {"label": "Amount", "value": _fmt_money(ext.get("amount"))},
        {"label": "Date", "value": _fmt_date(ext.get("date"))},
        {"label": "Category", "value": ext.get("expense_category") or EMPTY_LABEL},
        {"label": "Tax", "value": _fmt_money(ext.get("tax")) if ext.get("tax") is not None else EMPTY_LABEL},
        {"label": "Tip", "value": _fmt_money(ext.get("tip")) if ext.get("tip") is not None else EMPTY_LABEL},
    ]
    if ext.get("merchant_city"):
        loc = ", ".join(
            p for p in [ext.get("merchant_city"), ext.get("merchant_state"), ext.get("merchant_country")] if p
        )
        fields.append({"label": "Location", "value": loc})

    if matched:
        footer = (
            f"Matched to card transaction — {_fmt_money(matched.get('amount_cad'))} — "
            f"{_fmt_date(matched.get('transaction_date'))}"
        )
    else:
        footer = "No card transaction matched. Save this receipt if the details look correct."

    if violations:
        footer += f" — {len(violations)} compliance note(s)"
        if any(v.get("type") == "non_business_expense" for v in violations):
            footer += " — flagged as non-business"

    dining = is_dining_receipt(ext, matched)

    return {
        "fields": fields,
        "footer": footer,
        "matched_transaction_id": matched.get("transaction_id") if matched else None,
        "violations": violations,
        "extracted_data": ext,
        "is_dining": dining,
        "business_relevant": ext.get("business_relevant"),
        "business_relevance": ext.get("business_relevance"),
    }


def build_scan_reply(result: dict) -> str:
    ext = result.get("extracted_data") or {}
    if ext.get("error"):
        return f"I couldn't read that receipt: {ext['error']}"
    merchant = ext.get("merchant_name") or "the merchant"
    amount = _fmt_money(ext.get("amount"))
    matched = result.get("matched_transaction")
    violations = result.get("violations") or []
    non_business = [v for v in violations if v.get("type") == "non_business_expense"]
    base = (
        f"I scanned your receipt from {merchant} ({amount}) and matched it to an existing card transaction."
        if matched
        else f"I scanned your receipt from {merchant} ({amount}). No card transaction matched. Review the details and save if they look correct."
    )
    if non_business:
        return (
            f"{base} This looks like a personal or non-business purchase "
            f"({non_business[0].get('description', 'not work related')}). Finance will likely deny reimbursement."
        )
    if any(v.get("type") == "unclear_business_purpose" for v in violations):
        return f"{base} I couldn't confirm a clear business purpose. Add context or choose personal use if applicable."
    return base
