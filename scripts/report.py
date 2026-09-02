#!/usr/bin/env python3
"""Print a Markdown summary of one run's probe results, for $GITHUB_STEP_SUMMARY.

    python3 scripts/report.py <artifacts-dir>
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

PROBES = ("ping", "token", "manifest", "push", "pull")


def med(values: list[float]) -> str:
    return f"{statistics.median(values):.0f}" if values else "—"


def main() -> int:
    input_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not input_dir or not input_dir.is_dir():
        print("_No results to report._")
        return 0

    rows = []
    for path in sorted(input_dir.rglob("*.jsonl")):
        for line in path.read_text().splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue

    if not rows:
        print("_No results to report._")
        return 0

    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[row.get("runner_group", "unknown")].append(row)

    blob_mb = next(
        (
            r["probes"]["pull"]["bytes"] / 1048576
            for r in rows
            if r.get("probes", {}).get("pull", {}).get("bytes")
        ),
        0,
    )

    print("## ghcr.io probe results\n")
    print(f"Median across repetitions · {blob_mb:.0f} MB payload\n")
    print("| Runner | Reps | OK | Manifest | TLS | Push | Pull |")
    print("|---|---|---|---|---|---|---|")

    for group, items in sorted(groups.items()):
        ok = [r for r in items if all(r["probes"].get(p, {}).get("ok") for p in PROBES)]
        label = items[0].get("runner_label", group)

        def vals(probe: str, field: str, source: list[dict]) -> list[float]:
            out = []
            for row in source:
                value = row.get("probes", {}).get(probe, {}).get(field)
                if isinstance(value, (int, float)):
                    out.append(value)
            return out

        push = vals("push", "mbps", ok)
        pull = vals("pull", "mbps", ok)
        print(
            f"| `{label}` ({group}) | {len(items)} | {len(ok)}/{len(items)} "
            f"| {med(vals('manifest', 'ms', items))} ms "
            f"| {med(vals('ping', 'tls_ms', items))} ms "
            f"| {med(push)} MB/s | {med(pull)} MB/s |"
        )

    failures = [
        (row, probe)
        for row in rows
        for probe in PROBES
        if not row.get("probes", {}).get(probe, {}).get("ok")
    ]
    if failures:
        print(f"\n### Failed probes ({len(failures)})\n")
        for row, probe in failures[:20]:
            info = row["probes"][probe]
            detail = info.get("error") or f"HTTP {info.get('status')}"
            print(f"- `{row.get('runner_group')}` rep {row.get('rep')} — **{probe}**: {detail}")
    else:
        print("\nAll probes succeeded. ✅")

    return 0


if __name__ == "__main__":
    sys.exit(main())
