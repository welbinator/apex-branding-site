#!/usr/bin/env python3
"""Remove em dashes (U+2014) and en dashes (U+2013) from site copy.
Spaced dash -> spaced hyphen; tight/placeholder dash -> hyphen."""
import pathlib, re

EM = "\u2014"
EN = "\u2013"
files = [
    "src/pages/index.astro",
    "src/pages/website.astro",
    "src/layouts/Layout.astro",
    "functions/api/audit.js",
    "functions/api/lead.js",
]
root = pathlib.Path(__file__).resolve().parent.parent
total = 0
for rel in files:
    p = root / rel
    s = p.read_text()
    before = s.count(EM) + s.count(EN)
    if not before:
        continue
    # spaced dash (with optional surrounding spaces) -> single spaced hyphen
    s = re.sub(r"\s*[" + EM + EN + r"]\s*", lambda m: " - " if (" " in m.group(0)) else "-", s)
    # collapse any accidental double spaces introduced
    s = s.replace("  - ", " - ").replace(" -  ", " - ")
    p.write_text(s)
    after = s.count(EM) + s.count(EN)
    total += before - after
    print(f"{rel}: removed {before-after} (remaining {after})")
print(f"TOTAL removed: {total}")
