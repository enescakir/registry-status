#!/usr/bin/env python3
"""Turn raw probe results (JSON Lines) into the small JSON files the site reads.

Reads   data/<registry>/YYYY-MM.jsonl
Writes  site/data/<registry>.json  and  site/data/registries.json

Standard library only, on purpose: the whole pipeline stays `python3 script.py`.
"""

from __future__ import annotations

import json
import math
import os
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Overridable so the pipeline can be exercised against scratch data locally.
DATA_DIR = Path(os.environ.get("REGISTRY_STATUS_DATA_DIR", ROOT / "data"))
OUT_DIR = Path(os.environ.get("REGISTRY_STATUS_OUT_DIR", ROOT / "site" / "data"))

# Probes that must all succeed for a sample to count as "up".
API_PROBES = ("ping", "token", "manifest")
TRANSFER_PROBES = ("push", "pull")
ALL_PROBES = API_PROBES + TRANSFER_PROBES

WINDOWS = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
SERIES_WINDOW = timedelta(days=7)
DAILY_WINDOW = timedelta(days=90)
MONTH_FILES_READ = 5  # enough to cover the 90-day daily rollup

def rel(path: Path) -> str:
    """Path for logging; OUT_DIR may sit outside the repo during local runs."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def pct(values: list[float], q: float) -> float | None:
    """Linearly interpolated percentile. Returns None for an empty sample.

    Interpolating rather than picking a nearest rank matters most when the
    sample is small, which is exactly when these figures are first read: on an
    even count a nearest-rank p50 has to break a tie between the two middle
    values, and with six samples that choice can move the headline number by
    tens of milliseconds. This agrees with statistics.median at q=0.5.
    """
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 1)

    pos = q * (len(ordered) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return round(ordered[lo], 1)
    frac = pos - lo
    return round(ordered[lo] * (1 - frac) + ordered[hi] * frac, 1)


def median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def load_samples(registry_dir: Path) -> list[dict]:
    files = sorted(registry_dir.glob("*.jsonl"))[-MONTH_FILES_READ:]
    samples: list[dict] = []
    for path in files:
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                record["_ts"] = parse_ts(record["ts"])
            except (ValueError, KeyError) as exc:
                print(f"  skipping {path.name}:{lineno}: {exc}")
                continue
            samples.append(record)
    samples.sort(key=lambda r: r["_ts"])
    return samples


def probe(sample: dict, name: str) -> dict:
    return sample.get("probes", {}).get(name) or {}


def probe_ok(sample: dict, name: str) -> bool:
    return bool(probe(sample, name).get("ok"))


def sample_up(sample: dict) -> bool:
    return all(probe_ok(sample, name) for name in ALL_PROBES)


def metric(sample: dict, name: str, field: str) -> float | None:
    value = probe(sample, name).get(field)
    return value if isinstance(value, (int, float)) else None


def collect(samples: list[dict], name: str, field: str) -> list[float]:
    return [v for v in (metric(s, name, field) for s in samples) if v is not None]


def availability(samples: list[dict]) -> float | None:
    if not samples:
        return None
    return round(100.0 * sum(1 for s in samples if sample_up(s)) / len(samples), 3)


def window_stats(samples: list[dict]) -> dict:
    """Headline numbers for one time window."""
    ok = [s for s in samples if sample_up(s)]
    return {
        "samples": len(samples),
        "failed_samples": len(samples) - len(ok),
        "availability": availability(samples),
        "api_availability": (
            round(
                100.0
                * sum(1 for s in samples if all(probe_ok(s, p) for p in API_PROBES))
                / len(samples),
                3,
            )
            if samples
            else None
        ),
        # Latency percentiles use every sample that answered at all; throughput
        # percentiles use only successful transfers, where the number is meaningful.
        "manifest_p50_ms": pct(collect(samples, "manifest", "ms"), 0.50),
        "manifest_p95_ms": pct(collect(samples, "manifest", "ms"), 0.95),
        "dns_p50_ms": pct(collect(samples, "ping", "dns_ms"), 0.50),
        "tcp_p50_ms": pct(collect(samples, "ping", "tcp_ms"), 0.50),
        "tls_p50_ms": pct(collect(samples, "ping", "tls_ms"), 0.50),
        "ttfb_p50_ms": pct(collect(samples, "ping", "ttfb_ms"), 0.50),
        "pull_p50_mbps": pct(collect(ok, "pull", "mbps"), 0.50),
        "pull_p95_ms": pct(collect(ok, "pull", "ms"), 0.95),
        "push_p50_mbps": pct(collect(ok, "push", "mbps"), 0.50),
        "push_p95_ms": pct(collect(ok, "push", "ms"), 0.95),
    }


def run_points(samples: list[dict]) -> list[dict]:
    """One point per workflow run: the median across that run's repetitions."""
    runs: dict[str, list[dict]] = defaultdict(list)
    for sample in samples:
        runs[str(sample.get("run_id", sample["ts"]))].append(sample)

    points = []
    for run_id, reps in runs.items():
        ok = [s for s in reps if sample_up(s)]
        points.append(
            {
                "run_id": run_id,
                "ts": min(s["_ts"] for s in reps).isoformat().replace("+00:00", "Z"),
                "reps": len(reps),
                "up": len(ok) == len(reps),
                "availability": availability(reps),
                "manifest_ms": median(collect(reps, "manifest", "ms")),
                "ttfb_ms": median(collect(reps, "ping", "ttfb_ms")),
                "pull_ms": median(collect(ok, "pull", "ms")),
                "push_ms": median(collect(ok, "push", "ms")),
                "pull_mbps": median(collect(ok, "pull", "mbps")),
                "push_mbps": median(collect(ok, "push", "mbps")),
            }
        )
    points.sort(key=lambda p: p["ts"])
    return points


def daily_points(samples: list[dict]) -> list[dict]:
    days: dict[str, list[dict]] = defaultdict(list)
    for sample in samples:
        days[sample["_ts"].date().isoformat()].append(sample)

    out = []
    for day, reps in sorted(days.items()):
        ok = [s for s in reps if sample_up(s)]
        out.append(
            {
                "date": day,
                "samples": len(reps),
                "availability": availability(reps),
                "manifest_p50_ms": pct(collect(reps, "manifest", "ms"), 0.50),
                "pull_p50_mbps": pct(collect(ok, "pull", "mbps"), 0.50),
                "push_p50_mbps": pct(collect(ok, "push", "mbps"), 0.50),
            }
        )
    return out


def latest_state(samples: list[dict]) -> dict | None:
    """Status from the most recent run, aggregated over its repetitions."""
    if not samples:
        return None
    newest_run = str(samples[-1].get("run_id", samples[-1]["ts"]))
    reps = [s for s in samples if str(s.get("run_id", s["ts"])) == newest_run]
    ok = [s for s in reps if sample_up(s)]

    if not ok:
        status = "down"
    elif len(ok) < len(reps):
        status = "degraded"
    else:
        status = "operational"

    failing = sorted(
        {name for s in reps for name in ALL_PROBES if not probe_ok(s, name)}
    )
    return {
        "ts": reps[0]["ts"],
        "status": status,
        "reps": len(reps),
        "failing_probes": failing,
        "manifest_ms": median(collect(reps, "manifest", "ms")),
        "ttfb_ms": median(collect(reps, "ping", "ttfb_ms")),
        "tls_ms": median(collect(reps, "ping", "tls_ms")),
        "tcp_ms": median(collect(reps, "ping", "tcp_ms")),
        "dns_ms": median(collect(reps, "ping", "dns_ms")),
        "pull_ms": median(collect(ok, "pull", "ms")),
        "push_ms": median(collect(ok, "push", "ms")),
        "pull_mbps": median(collect(ok, "pull", "mbps")),
        "push_mbps": median(collect(ok, "push", "mbps")),
        "remote_ip": probe(reps[-1], "ping").get("remote_ip"),
        "blob_bytes": probe(reps[-1], "pull").get("bytes"),
        "run_id": newest_run,
    }


def recent_incidents(samples: list[dict], limit: int = 12) -> list[dict]:
    """Failures grouped by run, not by repetition.

    A bad ten minutes at the registry shows up as three failed repetitions of
    the same run; listing them separately would report one incident as three.
    """
    run_sizes: dict[str, int] = defaultdict(int)
    for sample in samples:
        run_sizes[str(sample.get("run_id", sample["ts"]))] += 1

    runs: dict[str, dict] = {}
    for sample in samples:
        failing = [name for name in ALL_PROBES if not probe_ok(sample, name)]
        if not failing:
            continue

        run_id = str(sample.get("run_id", sample["ts"]))
        entry = runs.setdefault(
            run_id,
            {
                "ts": sample["ts"],
                "run_id": sample.get("run_id"),
                "reps_failed": 0,
                "reps_total": run_sizes[run_id],
                "probes": {},
            },
        )
        entry["reps_failed"] += 1
        entry["ts"] = min(entry["ts"], sample["ts"])
        for name in failing:
            info = probe(sample, name)
            status = info.get("status")
            entry["probes"].setdefault(
                name,
                info.get("error") or (f"HTTP {status}" if status else "failed"),
            )

    return sorted(runs.values(), key=lambda r: r["ts"], reverse=True)[:limit]


def build_registry(registry_dir: Path) -> dict:
    samples = load_samples(registry_dir)
    now = datetime.now(timezone.utc)

    groups = {}
    for group in sorted({s.get("runner_group", "unknown") for s in samples}):
        rows = [s for s in samples if s.get("runner_group") == group]
        # Display names live in site/assets/app.js; this file only reports what
        # the probes actually recorded.
        groups[group] = {
            "key": group,
            "runner_label": rows[-1].get("runner_label") if rows else None,
            "region": rows[-1].get("region") if rows else None,
            "latest": latest_state(rows),
            "windows": {
                name: window_stats([s for s in rows if s["_ts"] >= now - delta])
                for name, delta in WINDOWS.items()
            },
            "series": run_points([s for s in rows if s["_ts"] >= now - SERIES_WINDOW]),
            "daily": daily_points([s for s in rows if s["_ts"] >= now - DAILY_WINDOW]),
            "incidents": recent_incidents(rows),
        }

    return {
        "registry": registry_dir.name,
        "repository": os.environ.get("GITHUB_REPOSITORY") or None,
        "display_name": {"ghcr": "ghcr.io"}.get(registry_dir.name, registry_dir.name),
        "generated_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "total_samples": len(samples),
        "first_sample": samples[0]["ts"] if samples else None,
        "groups": groups,
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    registries = []

    if not DATA_DIR.is_dir():
        print(f"no data directory at {rel(DATA_DIR)}; nothing to aggregate")

    dirs = sorted(p for p in DATA_DIR.iterdir() if p.is_dir()) if DATA_DIR.is_dir() else []
    for registry_dir in dirs:
        payload = build_registry(registry_dir)
        target = OUT_DIR / f"{registry_dir.name}.json"
        target.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
        registries.append(
            {
                "key": payload["registry"],
                "display_name": payload["display_name"],
                "file": f"data/{registry_dir.name}.json",
                "total_samples": payload["total_samples"],
            }
        )
        print(
            f"  {registry_dir.name}: {payload['total_samples']} samples "
            f"-> {rel(target)} ({target.stat().st_size} bytes)"
        )

    index = OUT_DIR / "registries.json"
    index.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
                "registries": registries,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    print(f"  index -> {rel(index)}")


if __name__ == "__main__":
    main()
