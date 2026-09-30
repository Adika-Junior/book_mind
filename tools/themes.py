#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Generate web/css/themes.css from three palettes and prove every text pair is readable.

    python tools/themes.py            # writes web/css/themes.css, prints the contrast report
    python tools/themes.py --check    # CI: exit 1 if the committed CSS is stale or a pair fails

Every colour of every source palette is given a *role* (background, ink, chrome, accent,
heading, link, secondary, highlight). Roles, not raw colours, are what the app uses, so a
palette can never put unreadable text on screen: each role pair is checked against WCAG 2.2
(4.5:1 for body text, 3:1 for large headings and UI parts). Source colours that are too light or
too saturated to carry text themselves (e.g. amber, ochre, wheat) are used as fills behind dark
text, as highlights, or as rules — never as text on a light page. See docs/READING-DESIGN.md.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "css" / "themes.css"


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def mix(a: str, b: str, t: float) -> str:
    """t=0 -> a, t=1 -> b (sRGB mix, fine for tints/shades)."""
    ra, rb = hex_to_rgb(a), hex_to_rgb(b)
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ra, rb, strict=True))


def rgba(h: str, alpha: float) -> str:
    r, g, b = hex_to_rgb(h)
    return f"rgba({r}, {g}, {b}, {alpha})"


def luminance(h: str) -> float:
    def ch(c: int) -> float:
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = hex_to_rgb(h)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


W, K = "#ffffff", "#000000"

# --------------------------------------------------------------------------------------------
# The three palettes, exactly as supplied, with the psychology that motivated each role.

PALETTES = {
    "golden": {
        "name": "Golden Hour",
        "mood": "Warm and focused — for long, immersive reading sessions.",
        "source": {"cream": "#fbf5a3", "amber": "#d8901e", "umber": "#7f400e", "espresso": "#1e0f0a"},
    },
    "coastal": {
        "name": "Coastal Linen",
        "mood": "Cool and calm — low arousal for careful, analytical reading.",
        "source": {"walnut": "#866644", "slate": "#8e9cab", "wheat": "#cfb27c", "mist": "#ccd0db", "sand": "#d3b89e"},
    },
    "terracotta": {
        "name": "Terracotta Garden",
        "mood": "Earthy and grounded — restorative greens and warm clay for study breaks and review.",
        "source": {"terracotta": "#a66348", "ochre": "#d89828", "moss": "#354728", "sandstone": "#c9a983", "indigo": "#232c42"},
    },
}


def golden(dark: bool) -> dict:
    c = PALETTES["golden"]["source"]
    if not dark:
        return {
            "bg": mix(c["cream"], W, 0.55), "surface": mix(c["cream"], W, 0.9), "surface-2": c["cream"],
            "ink": c["espresso"], "ink-soft": mix(c["espresso"], c["umber"], 0.55),
            "line": mix(c["cream"], c["umber"], 0.12), "line-strong": mix(c["cream"], c["umber"], 0.3),
            "accent": c["amber"], "accent-ink": c["espresso"], "accent-hover": mix(c["amber"], c["umber"], 0.2),
            "heading": c["umber"], "link": c["umber"], "secondary": c["amber"],
            "chrome": c["espresso"], "chrome-2": mix(c["espresso"], c["umber"], 0.25), "chrome-ink": c["cream"],
            "chrome-accent": c["amber"],
            "hl-reading": rgba(c["amber"], 0.34), "hl-spoken": rgba(c["amber"], 0.12), "hl-hit": rgba(c["umber"], 0.16),
            "term": c["umber"],
        }
    return {
        "bg": c["espresso"], "surface": mix(c["espresso"], c["umber"], 0.18), "surface-2": mix(c["espresso"], c["umber"], 0.3),
        "ink": c["cream"], "ink-soft": mix(c["cream"], c["espresso"], 0.22),
        "line": mix(c["espresso"], c["umber"], 0.45), "line-strong": mix(c["espresso"], c["umber"], 0.7),
        "accent": c["amber"], "accent-ink": c["espresso"], "accent-hover": mix(c["amber"], c["cream"], 0.25),
        "heading": mix(c["amber"], c["cream"], 0.25), "link": mix(c["amber"], c["cream"], 0.25), "secondary": c["amber"],
        "chrome": mix(c["espresso"], K, 0.3), "chrome-2": mix(c["espresso"], c["umber"], 0.2), "chrome-ink": c["cream"],
        "chrome-accent": c["amber"],
        "hl-reading": rgba(c["amber"], 0.36), "hl-spoken": rgba(c["amber"], 0.13), "hl-hit": rgba(c["cream"], 0.12),
        "term": mix(c["amber"], c["cream"], 0.25),
    }


def coastal(dark: bool) -> dict:
    c = PALETTES["coastal"]["source"]
    walnut_ink = mix(c["walnut"], K, 0.62)
    if not dark:
        return {
            "bg": mix(c["mist"], W, 0.55), "surface": mix(c["sand"], W, 0.88), "surface-2": mix(c["sand"], W, 0.6),
            "ink": walnut_ink, "ink-soft": mix(c["walnut"], K, 0.38),
            "line": mix(c["mist"], W, 0.2), "line-strong": c["mist"],
            "accent": c["wheat"], "accent-ink": walnut_ink, "accent-hover": mix(c["wheat"], c["walnut"], 0.2),
            "heading": mix(c["walnut"], K, 0.22), "link": mix(c["slate"], K, 0.45), "secondary": c["slate"],
            "chrome": mix(c["slate"], K, 0.55), "chrome-2": mix(c["slate"], K, 0.42), "chrome-ink": mix(c["mist"], W, 0.6),
            "chrome-accent": c["wheat"],
            "hl-reading": rgba(c["wheat"], 0.42), "hl-spoken": rgba(c["wheat"], 0.16), "hl-hit": rgba(c["slate"], 0.24),
            "term": mix(c["slate"], K, 0.45),
        }
    return {
        "bg": mix(c["slate"], K, 0.8), "surface": mix(c["slate"], K, 0.74), "surface-2": mix(c["slate"], K, 0.66),
        "ink": mix(c["mist"], W, 0.5), "ink-soft": c["mist"],
        "line": mix(c["slate"], K, 0.58), "line-strong": mix(c["slate"], K, 0.42),
        "accent": c["wheat"], "accent-ink": walnut_ink, "accent-hover": mix(c["wheat"], W, 0.2),
        "heading": c["sand"], "link": mix(c["slate"], W, 0.45), "secondary": c["slate"],
        "chrome": mix(c["slate"], K, 0.86), "chrome-2": mix(c["slate"], K, 0.72), "chrome-ink": mix(c["mist"], W, 0.5),
        "chrome-accent": c["wheat"],
        "hl-reading": rgba(c["wheat"], 0.3), "hl-spoken": rgba(c["wheat"], 0.11), "hl-hit": rgba(c["mist"], 0.14),
        "term": mix(c["slate"], W, 0.45),
    }


def terracotta(dark: bool) -> dict:
    c = PALETTES["terracotta"]["source"]
    if not dark:
        return {
            "bg": mix(c["sandstone"], W, 0.62), "surface": mix(c["sandstone"], W, 0.9), "surface-2": mix(c["sandstone"], W, 0.7),
            "ink": c["indigo"], "ink-soft": mix(c["indigo"], c["sandstone"], 0.35),
            "line": mix(c["sandstone"], W, 0.45), "line-strong": c["sandstone"],
            "accent": c["ochre"], "accent-ink": c["indigo"], "accent-hover": mix(c["ochre"], c["terracotta"], 0.3),
            "heading": mix(c["terracotta"], K, 0.25), "link": c["moss"], "secondary": c["moss"],
            "chrome": c["indigo"], "chrome-2": mix(c["indigo"], c["moss"], 0.35), "chrome-ink": mix(c["sandstone"], W, 0.65),
            "chrome-accent": c["ochre"],
            "hl-reading": rgba(c["ochre"], 0.32), "hl-spoken": rgba(c["ochre"], 0.12), "hl-hit": rgba(c["moss"], 0.16),
            "term": c["moss"],
        }
    return {
        "bg": mix(c["indigo"], K, 0.35), "surface": c["indigo"], "surface-2": mix(c["indigo"], c["moss"], 0.3),
        "ink": mix(c["sandstone"], W, 0.6), "ink-soft": mix(c["sandstone"], W, 0.15),
        "line": mix(c["indigo"], W, 0.12), "line-strong": mix(c["indigo"], c["sandstone"], 0.3),
        "accent": c["ochre"], "accent-ink": mix(c["indigo"], K, 0.35), "accent-hover": mix(c["ochre"], W, 0.2),
        "heading": mix(c["terracotta"], W, 0.4), "link": mix(c["moss"], W, 0.55), "secondary": mix(c["moss"], W, 0.3),
        "chrome": mix(c["indigo"], K, 0.55), "chrome-2": mix(c["indigo"], c["moss"], 0.25), "chrome-ink": mix(c["sandstone"], W, 0.6),
        "chrome-accent": c["ochre"],
        "hl-reading": rgba(c["ochre"], 0.3), "hl-spoken": rgba(c["ochre"], 0.11), "hl-hit": rgba(c["moss"], 0.4),
        "term": mix(c["moss"], W, 0.55),
    }


BUILDERS = {"golden": golden, "coastal": coastal, "terracotta": terracotta}

# (foreground, background, minimum ratio, what it is)
CHECKS = [
    ("ink", "surface", 7.0, "body text on the page (AAA)"),
    ("ink", "bg", 4.5, "text on the app background"),
    ("ink", "surface-2", 4.5, "text on cards"),
    ("ink-soft", "surface", 4.5, "secondary text"),
    ("ink-soft", "bg", 4.5, "secondary text on background"),
    ("heading", "surface", 4.5, "headings"),
    ("heading", "bg", 4.5, "headings on background"),
    ("link", "surface", 4.5, "links and citations"),
    ("term", "surface", 4.5, "defined-term underlines"),
    ("accent-ink", "accent", 4.5, "button labels"),
    ("chrome-ink", "chrome", 7.0, "toolbar text"),
    ("chrome-ink", "chrome-2", 4.5, "toolbar controls"),
    ("chrome-accent", "chrome", 3.0, "toolbar accents / focus"),
    ("line-strong", "surface", 1.3, "visible rules"),
]


def build() -> tuple[str, list[str], bool]:
    css = [
        "/* SPDX-License-Identifier: AGPL-3.0-or-later */",
        "/* GENERATED by tools/themes.py — edit that file, then run it. Do not edit by hand. */",
        "",
    ]
    report, ok = [], True
    for key, meta in PALETTES.items():
        src = meta["source"]
        stripe = ", ".join(src.values())
        light, dark = BUILDERS[key](False), BUILDERS[key](True)
        for mode, tokens in (("light", light), ("dark", dark)):
            for fg, bg, minimum, what in CHECKS:
                ratio = contrast(tokens[fg], tokens[bg])
                passed = ratio >= minimum
                ok &= passed
                report.append(f"{'PASS' if passed else 'FAIL'}  {meta['name']:<17} {mode:<5} {fg:>13} on {bg:<10} {ratio:5.2f}:1 (≥{minimum}) {what}")

        def block(tokens: dict, scheme: str, stripe: str = stripe) -> list[str]:
            out = [f"  --{k}: {v};" for k, v in tokens.items()]
            out += [
                f"  --focus: {tokens['heading'] if scheme == 'light' else tokens['accent']};",
                f"  --selection: {rgba(tokens['accent'][:7], 0.38) if tokens['accent'].startswith('#') else tokens['hl-reading']};",
                f"  --chrome-soft: {rgba(tokens['chrome-ink'], 0.72)};",
                f"  --chrome-line: {rgba(tokens['chrome-ink'], 0.18)};",
                f"  --palette-stripe: linear-gradient(90deg, {stripe});",
                f"  --shadow: 0 10px 30px {rgba(K, 0.18 if scheme == 'light' else 0.5)};",
                f"  color-scheme: {scheme};",
            ]
            return out

        sel = f':root[data-palette="{key}"]'
        default = ":root:not([data-palette]), " if key == "golden" else ""
        css.append(f"/* {meta['name']} — {meta['mood']} Source: {', '.join(f'{n} {h}' for n, h in src.items())} */")
        css.append(f"{default}{sel} {{")
        css += block(light, "light")
        css.append("}")
        dark_sel = f'{sel}:not([data-theme="light"])'
        if key == "golden":
            dark_sel = ':root:not([data-palette]):not([data-theme="light"]), ' + dark_sel
        css.append("@media (prefers-color-scheme: dark) {")
        css.append(f"{dark_sel} {{")
        css += block(dark, "dark")
        css.append("}\n}")
        dark_forced = f'{sel}[data-theme="dark"]'
        if key == "golden":
            dark_forced = ':root:not([data-palette])[data-theme="dark"], ' + dark_forced
        css.append(f"{dark_forced} {{")
        css += block(dark, "dark")
        css.append("}\n")
        # Swatches for the palette picker (always the raw source colours).
        swatch = ", ".join(f"{h} {i * 100 // len(src)}% {(i + 1) * 100 // len(src)}%" for i, h in enumerate(src.values()))
        css.append(f'.swatch[data-palette="{key}"] {{ background: linear-gradient(90deg, {swatch}); }}\n')
    return "\n".join(css), report, ok


def main() -> int:
    css, report, ok = build()
    print("\n".join(report))
    if "--check" in sys.argv:
        stale = not OUT.exists() or OUT.read_text(encoding="utf-8") != css
        if stale:
            print("web/css/themes.css is stale — run: python tools/themes.py")
        return 0 if ok and not stale else 1
    if not ok:
        print("\nContrast check failed — themes.css NOT written.")
        return 1
    OUT.write_text(css, encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
