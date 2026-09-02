# registry-status

Hourly availability and performance measurements for **ghcr.io**, taken from two
places at once: Ubicloud runners in Europe and GitHub-hosted runners in the
United States. The results are committed to this repository and published as a
static site.

The point is the comparison. ghcr.io is fronted by an anycast edge, so how far
it really is from a European CI runner - and whether that differs from a
GitHub-hosted runner in the US - is an empirical question rather than a given.
This measures it, stage by stage, instead of assuming an answer.

- **Site:** GitHub Pages, published from `site/` by [`publish.yml`](.github/workflows/publish.yml)
- **Data:** append-only JSON Lines under [`data/`](data/) — no database
- **Dependencies:** none. `bash`, `curl`, `docker` and `python3`, all already on the runners.

## Setting it up

1. **Allow workflows to write.** Settings → Actions → General → Workflow
   permissions: **Read and write**. Nothing works until this is set: it is what
   lets the workflow commit results and create the Pages site. While it is
   read-only, every `permissions:` block in the workflows is capped to nothing
   and the publish job fails with *Resource not accessible by integration*.
2. **Check the Ubicloud runner label.** The matrix in
   [`monitor.yml`](.github/workflows/monitor.yml) uses `ubicloud`. Change it if
   your installation exposes a different label (`ubicloud-standard-4`, an ARM
   variant, and so on), and update `region` in the same entry so the site
   labels it correctly.
3. **Run it once by hand.** Actions → *Monitor ghcr.io* → Run workflow. The
   first run creates the `registry-status-probe` package, appends results to
   `data/ghcr/`, and deploys the site. `configure-pages` switches Pages on
   itself, so there is no separate setup step — if that is blocked for the
   repository, set Settings → Pages → Source: **GitHub Actions** by hand.
4. **Make the probe package public** (recommended — see *Traffic* below).
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
scripts/seo.py              robots.txt, sitemap.xml, absolute URLs
scripts/report.py           per-run Markdown table for the job summary
scripts/prune-packages.sh   delete old probe image versions
data/ghcr/YYYY-MM.jsonl     every measurement ever taken, one JSON per line
site/                       the published site: no build step, no npm
site/og.png                 social preview card, 1200x630
```

`site/data/`, `site/robots.txt` and `site/sitemap.xml` are generated at publish
time and are not committed.

### Absolute URLs

The canonical link, the Open Graph tags and the JSON-LD in `site/index.html`
carry this project's Pages URL, so the file is correct opened directly or
deployed untouched. The publish workflow runs `scripts/seo.py` with the base URL
Pages reports and rewrites every occurrence, so pointing a custom domain at the
site needs no edit to the HTML.

`site/og.png` is checked in rather than generated, since rendering it needs a
browser. Regenerate it by hand if the title or the palette changes.

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
python3 scripts/seo.py                # robots.txt + sitemap.xml (optional)
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

`site/` is plain static files. For Cloudflare Pages, set the output directory to
`site` and the build command to:

```bash
python3 scripts/aggregate.py && python3 scripts/seo.py https://your-domain/
```

Passing the domain keeps the canonical link, the Open Graph tags and the sitemap
pointing at wherever the site actually lives.

---

Measured on and powered by [Ubicloud runners](https://www.ubicloud.com/use-cases/github-actions).
