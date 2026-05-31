"""Restore corrupted UI punctuation (? placeholders -> ·, —, …, ×)."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MID = "\u00b7"  # ·
EM = "\u2014"  # —
ELL = "\u2026"  # …
REPL = "\ufffd"  # replacement char from bad encoding


def fix_script(text: str) -> str:
    # Fix replacement-char middle dots first.
    text = text.replace(REPL, MID)

    em_pairs = [
        ("Session expired ? please sign in again.", f"Session expired {EM} please sign in again."),
        ("API not found ? restart the app with python app.py.", f"API not found {EM} restart the app with python app.py."),
        ("${data.quarter} ? set how much", f"${{data.quarter}} {EM} set how much"),
        ("Saved ? open Budgets to see updates", f"Saved {EM} open Budgets to see updates"),
        ("Reset to suggested ? click Save budgets to apply", f"Reset to suggested {EM} click Save budgets to apply"),
        ("Reset ? suggested ? click Save budgets to apply", f"Reset {EM} suggested {EM} click Save budgets to apply"),
        ("Saved ? updating scans?", f"Saved {EM} updating scans{ELL}"),
        ("Ready to import ? click Apply policy with Gemini", f"Ready to import {EM} click Apply policy with Gemini"),
        ("PDF, Markdown, or text ? max 15 MB", f"PDF, Markdown, or text {EM} max 15 MB"),
        ("Policy applied ? ${changeCount}", f"Policy applied {EM} ${{changeCount}}"),
        ("Policy applied ? review the rules below.", f"Policy applied {EM} review the rules below."),
        ("No card transaction matched ? you can still save this receipt", f"No card transaction matched {EM} you can still save this receipt"),
        ("No card transaction matched ? review the details below", f"No card transaction matched {EM} review the details below"),
        ("Hi ? I&apos;m Friday.", f"Hi {EM} I&apos;m Friday."),
        ("No proposals yet ? submit one using the form.", f"No proposals yet {EM} submit one using the form."),
        ("No trip reports yet ? submit one using the form.", f"No trip reports yet {EM} submit one using the form."),
        ("Submitted ? waiting for approval.", f"Submitted {EM} waiting for approval."),
        ("Submitted ? waiting for finance review.", f"Submitted {EM} waiting for finance review."),
        ("Budget projection ? ${fc.department}", f"Budget projection {EM} ${{fc.department}}"),
        ("Nothing waiting ? you're all caught up!", f"Nothing waiting {EM} you're all caught up!"),
        ("Nothing waiting ? you\\'re all caught up!", f"Nothing waiting {EM} you\\'re all caught up!"),
        ("Pick what you want to do ? everything is one click away.", f"Pick what you want to do {EM} everything is one click away."),
        ("Request budget for a project ? your manager or CEO will review it.", f"Request budget for a project {EM} your manager or CEO will review it."),
        ("Your starting point ? explore spending", f"Your starting point {EM} explore spending"),
        ("Every card transaction ? search by person", f"Every card transaction {EM} search by person"),
        ("Upload a photo ? we extract details", f"Upload a photo {EM} we extract details"),
        ("Where purchases happened ? each dot is a merchant", f"Where purchases happened {EM} each dot is a merchant"),
        ("} ? open Review to approve", f"}} {EM} open Review to approve"),
        ("preview only ? full list uses", f"preview only {EM} full list uses"),
        ("workflow strip removed ? sidebar", f"workflow strip removed {EM} sidebar"),
        ("Microphone blocked ? allow access in browser settings.", f"Microphone blocked {EM} allow access in browser settings."),
        ("Could not hear you ? try again.", f"Could not hear you {EM} try again."),
        ("Peer benchmark ? ${escapeHtml", f"Peer benchmark {EM} ${{escapeHtml"),
        ("Meal ? party of", f"Meal {MID} party of"),
    ]
    for old, new in em_pairs:
        text = text.replace(old, new)

    # Middle dots before template interpolations and list joins.
    text = text.replace(" ? ${", f" {MID} ${{")
    text = text.replace(f".toFixed(1)}} ? CA$", f".toFixed(1)}} {MID} CA$")
    text = text.replace(".join(' ? ')", f".join(' {MID} ')")
    text = text.replace("filter(Boolean).join(' ? ')", f"filter(Boolean).join(' {MID} ')")
    text = text.replace(" ? Score ", f" {MID} Score ")
    text = text.replace(" ? Credit score ", f" {MID} Credit score ")
    text = text.replace("' ? Flagged'", f"' {MID} Flagged'")
    text = text.replace("' ? Personal'", f"' {MID} Personal'")
    text = text.replace("PDF ? ${formatFileSize", f"PDF {MID} ${{formatFileSize")
    text = text.replace("Image ? ${formatFileSize", f"Image {MID} ${{formatFileSize")
    text = text.replace(" ? Using saved ", f" {MID} Using saved ")

    # Ellipsis in status / loading copy.
    for phrase in (
        "Loading?",
        "Loading purchases?",
        "Loading report?",
        "Loading expense reports?",
        "Loading flagged transactions?",
        "Select a project?",
        "Saving?",
        "Analyzing receipt?",
        "Scan complete?",
    ):
        text = text.replace(phrase, phrase[:-1] + ELL)

    text = text.replace(".slice(0, 69)}?", f".slice(0, 69)}}{ELL}")
    text = text.replace("loc.employees.length > 4 ? '?' : ''", "loc.employees.length > 4 ? '...' : ''")

    # Missing-value and close-button glyphs.
    text = text.replace("return '?';", f"return '{EM}';")
    text = text.replace("|| '?'", f"|| '{EM}'")
    text = text.replace('Remove">?</button>', 'Remove">×</button>')
    text = text.replace('Remove">\ufffd</button>', 'Remove">×</button>')
    text = text.replace('aria-label="Remove">?</button>', 'aria-label="Remove">×</button>')
    text = text.replace('aria-label="Remove">\ufffd</button>', 'aria-label="Remove">×</button>')

    return text


def fix_html(text: str) -> str:
    text = text.replace(REPL, MID)
    text = text.replace("on track ? <span", f"on track {MID} <span")
    text = text.replace("closely ? <span", f"closely {MID} <span")
    text = text.replace("restaurant / caf?", "restaurant / café")
    text = text.replace("Loading your eligible purchases?", f"Loading your eligible purchases{ELL}")
    text = text.replace("Loading projects?", f"Loading projects{ELL}")
    text = text.replace("Loading?", f"Loading{ELL}")
    text = text.replace("Psst ? type", f"Psst {EM} type")
    text = text.replace("PNG, JPG, or PDF ? max 10 MB", f"PNG, JPG, or PDF {EM} max 10 MB")
    text = text.replace("PDF ? max 15 MB", f"PDF {EM} max 15 MB")
    text = text.replace("PDF ? max 10 MB", f"PDF {EM} max 10 MB")
    text = text.replace(
        "{{ (current_user.display_name or '?')[:2]|upper }}",
        "{{ (current_user.display_name or 'CF')[:2]|upper }}",
    )
    return text


def main() -> None:
    script_path = ROOT / "static" / "script.js"
    index_path = ROOT / "templates" / "index.html"
    script_path.write_text(fix_script(script_path.read_text(encoding="utf-8")), encoding="utf-8")
    index_path.write_text(fix_html(index_path.read_text(encoding="utf-8")), encoding="utf-8")
    remaining = script_path.read_text(encoding="utf-8").count(" ? ")
    repl = script_path.read_text(encoding="utf-8").count(REPL)
    print(f"Fixed UI punctuation ({remaining} ' ? ' left in script.js, {repl} replacement chars left)")


if __name__ == "__main__":
    main()
