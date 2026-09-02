#!/usr/bin/env python3
"""Generate robots.txt and sitemap.xml, and point absolute URLs at the real site.

    python3 scripts/seo.py [base-url]

site/index.html ships with the project's own GitHub Pages URL written into its
canonical link, Open Graph tags and structured data, so opening the file
directly or deploying it untouched is already correct. Passing a base URL - the
publish workflow passes the one Pages reports - rewrites every occurrence, so
moving to a custom domain needs no edit in the HTML.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DEFAULT_BASE = "https://enescakir.github.io/registry-status/"


def main() -> int:
    base = (sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BASE).strip()
    if not base:
        base = DEFAULT_BASE
    if not base.endswith("/"):
        base += "/"

    index = SITE / "index.html"
    if not index.is_file():
        print(f"missing {index}")
        return 1

    if base != DEFAULT_BASE:
        html = index.read_text()
        count = html.count(DEFAULT_BASE)
        index.write_text(html.replace(DEFAULT_BASE, base))
        print(f"  rewrote {count} absolute URL(s) to {base}")
    else:
        print(f"  base URL unchanged ({base})")

    (SITE / "robots.txt").write_text(
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        f"Sitemap: {base}sitemap.xml\n"
    )
    print("  wrote site/robots.txt")

    # One page, and its numbers change every hour.
    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    (SITE / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        "  <url>\n"
        f"    <loc>{base}</loc>\n"
        f"    <lastmod>{stamp}</lastmod>\n"
        "    <changefreq>hourly</changefreq>\n"
        "    <priority>1.0</priority>\n"
        "  </url>\n"
        "</urlset>\n"
    )
    print("  wrote site/sitemap.xml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
