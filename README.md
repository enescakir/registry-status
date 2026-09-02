# registry-status

Hourly availability and performance measurements for **ghcr.io**, taken from two
places at once: Ubicloud runners in Europe and GitHub-hosted runners in the
United States. The results are committed to this repository and published as a
static site.

The point is the comparison. GitHub's registry lives in the US; a European CI
runner pays for that distance on every `docker pull`. This measures how much.

- **Site:** GitHub Pages, published from `site/` by [`publish.yml`](.github/workflows/publish.yml)
- **Data:** append-only JSON Lines under [`data/`](data/) — no database
- **Dependencies:** none. `bash`, `curl`, `docker` and `python3`, all already on the runners.

## Setting it up

1. **Enable Pages.** Settings → Pages → Source: **GitHub Actions**.
2. **Allow the workflow to commit.** Settings → Actions → General → Workflow
   permissions: **Read and write**.
3. **Check the Ubicloud runner label.** The matrix in
   [`monitor.yml`](.github/workflows/monitor.yml) uses `ubicloud`. Change it if
   your installation exposes a different label (`ubicloud-standard-4`, an ARM
   variant, and so on), and update `region` in the same entry so the site
   labels it correctly.
4. **Run it once by hand.** Actions → *Monitor ghcr.io* → Run workflow. The
   first run creates the `registry-status-probe` package, appends results to
   `data/ghcr/`, and deploys the site.
5. **Make the probe package public** (recommended — see *Traffic* below).
   Packages → `registry-status-probe` → Package settings → Change visibility.

Until the first run finishes the site publishes fine and says it is waiting for
measurements.

## What gets measured

[`probes/ghcr.sh`](probes/ghcr.sh) runs three repetitions per runner per hour.
Each repetition times five stages:

| Probe | What it measures |
|---|---|
| `ping` | `GET /v2/` — liveness, plus the DNS / TCP / TLS / first-byte breakdown |
| `token` | `GET /token` — the auth handshake |
| `push` | `docker push` of a freshly built image |
| `manifest` | authenticated manifest read of the tag just pushed |
| `pull` | `docker pull` with the local layer cache cleared |

Two details matter for the numbers to mean anything:

**The payload is new every repetition.** Registries deduplicate layers by
digest, so pushing the same image twice measures an API call and nothing else.
Each repetition builds `FROM scratch` over 20 MB of `/dev/urandom`, which is
incompressible and unique, so push and pull both move real bytes.

**The size is fixed.** Timing a moving target like `python:latest` makes numbers
from different months incomparable.

## Repository layout

```
probes/ghcr.sh              measure ghcr.io from the current runner -> JSON Lines
scripts/ingest.py           merge a run's results into data/, idempotently
scripts/aggregate.py        data/ -> site/data/*.json (the site's only input)
scripts/report.py           per-run Markdown table for the job summary
scripts/prune-packages.sh   delete old probe image versions
data/ghcr/YYYY-MM.jsonl     every measurement ever taken, one JSON per line
site/                       the published site: no build step, no npm
```

`site/data/` is generated at publish time and is not committed.

### Data format

One JSON object per line, appended and never rewritten:

```json
{"ts":"2026-09-02T14:17:03Z","registry":"ghcr.io","runner_group":"ubicloud",
 "runner_label":"ubicloud","region":"eu-central","run_id":"1234","rep":1,
 "tag":"probe-ubicloud-1234-1",
 "probes":{"ping":{"ok":true,"status":401,"ms":363.4,"dns_ms":7.6,"tcp_ms":34.7,
                   "tls_ms":156.8,"ttfb_ms":363.4,"remote_ip":"140.82.121.34"},
           "push":{"ok":true,"ms":2100,"bytes":20971520,"mbps":9.52}}}
```

Records are keyed on `(run_id, runner_group, rep)`. `ingest.py` skips a key it
already holds, so re-running a workflow never duplicates rows.

A sample counts as *available* only if all five probes succeeded. Availability
percentages are the share of samples in a window that did.

## Traffic

At the defaults — 20 MB, 3 repetitions, 2 runners, hourly — this transfers about
**5.8 GB/day** to and from ghcr.io, and uses roughly two runner-minutes an hour.

GitHub does not bill bandwidth for **public** packages, which is why step 5 above
suggests making the probe package public. On a private package the same traffic
is billable. To cut it down, lower `BLOB_MB` or `REPS` in
[`monitor.yml`](.github/workflows/monitor.yml), or run the schedule less often.

`prune-packages.sh` keeps the newest 30 versions. `GITHUB_TOKEN` can delete
versions of an **organisation**-owned package; a user-owned package needs a PAT
with `delete:packages` exposed as a secret. The step is `continue-on-error`, so a
failure to prune never fails a measurement — but check it, or the package grows
by 144 versions a day.

## Local development

```bash
python3 scripts/aggregate.py          # data/ -> site/data/
python3 -m http.server -d site 8000   # then open http://localhost:8000
```

Both scripts accept `REGISTRY_STATUS_DATA_DIR` and `REGISTRY_STATUS_OUT_DIR` if
you want to work against a scratch copy.

To try the probe without a workflow:

```bash
GHCR_OWNER=<org> GHCR_PACKAGE=registry-status-probe \
GHCR_USER=<you> GHCR_TOKEN=<pat with write:packages> \
PROBE_GROUP=local PROBE_RUNNER=$(uname -m) PROBE_REGION=local \
REPS=1 BLOB_MB=5 OUT_FILE=/tmp/results.jsonl ./probes/ghcr.sh
```

## Adding another registry

The pipeline is already keyed by registry — `data/<registry>/`, one JSON file
per registry, and the site reads whichever it is pointed at. To add Docker Hub or
ECR:

1. Copy `probes/ghcr.sh`, change the endpoints and the login. Keep the output
   schema: `ingest.py` and `aggregate.py` need `ts`, `registry`, `runner_group`,
   `run_id`, `rep` and `probes`.
2. Add a job to `monitor.yml` that runs it and uploads a `results-*` artifact.
   `ingest.py` routes records by their own `registry` field, so nothing else
   changes.
3. Point the site at the new file (`DATA_URL` in `site/assets/app.js`), or serve
   a page per registry — `site/data/registries.json` lists what exists.

## Hosting elsewhere

`site/` is plain static files. For Cloudflare Pages, set the build command to
`python3 scripts/aggregate.py` and the output directory to `site`.

---

Measured on and powered by [Ubicloud runners](https://www.ubicloud.com/use-cases/github-actions).
