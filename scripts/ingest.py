#!/usr/bin/env python3
"""Merge probe results from a run into the append-only data files.

    python3 scripts/ingest.py <input-dir>

<input-dir> is scanned recursively for *.jsonl (i.e. the downloaded artifacts).
Records are appended to data/<registry>/<YYYY-MM>.jsonl.

Idempotent by design: a record is keyed on (run_id, runner_group, rep) and
skipped if that key is already on file. The publishing job can therefore
re-run the ingest after a rebase, and a re-run of the workflow will not
duplicate rows.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
REQUIRED = ("ts", "registry", "runner_group", "run_id", "rep", "probes")


def key(record: dict) -> tuple:
    return (str(record["run_id"]), record["runner_group"], str(record["rep"]))


def registry_slug(registry: str) -> str:
    """ghcr.io -> ghcr, so the data directory stays a plain path segment."""
    return registry.split(".")[0]


def read_incoming(input_dir: Path) -> list[dict]:
    records = []
    for path in sorted(input_dir.rglob("*.jsonl")):
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError as exc:
                print(f"  invalid JSON at {path}:{lineno}: {exc}")
                continue
            missing = [f for f in REQUIRED if f not in record]
            if missing:
                print(f"  incomplete record at {path}:{lineno}: missing {missing}")
                continue
            records.append(record)
    return records


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    input_dir = Path(sys.argv[1])
    if not input_dir.is_dir():
        print(f"input directory not found: {input_dir}")
        return 1

    incoming = read_incoming(input_dir)
    if not incoming:
        print("no valid records found; nothing to ingest")
        return 0

    # registry slug -> month -> records
    buckets: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for record in incoming:
        month = datetime.fromisoformat(record["ts"].replace("Z", "+00:00")).strftime("%Y-%m")
        buckets[registry_slug(record["registry"])][month].append(record)

    added = skipped = 0
    for slug, months in sorted(buckets.items()):
        target_dir = DATA_DIR / slug
        target_dir.mkdir(parents=True, exist_ok=True)

        for month, records in sorted(months.items()):
            path = target_dir / f"{month}.jsonl"
            existing = set()
            if path.exists():
                for line in path.read_text().splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        existing.add(key(json.loads(line)))
                    except (ValueError, KeyError):
                        continue

            fresh = []
            for record in sorted(records, key=lambda r: (r["ts"], r["runner_group"], r["rep"])):
                if key(record) in existing:
                    skipped += 1
                    continue
                existing.add(key(record))
                fresh.append(json.dumps(record, separators=(",", ":")))

            if fresh:
                with path.open("a") as fh:
                    fh.write("\n".join(fresh) + "\n")
            added += len(fresh)
            print(f"  {path.relative_to(ROOT)}: +{len(fresh)} records")

    print(f"ingested {added} records ({skipped} already on file)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
