#!/usr/bin/env bash
#
# Probe ghcr.io from the current runner and append one JSON record per
# repetition to $OUT_FILE (JSON Lines).
#
# Each repetition measures:
#   ping     - GET /v2/            (unauthenticated liveness, 401 is a healthy answer)
#   token    - GET /token          (auth handshake latency)
#   push     - docker push         (upload throughput, fresh incompressible blob)
#   manifest - GET /v2/.../manifests/<tag>
#   pull     - docker pull         (download throughput, cold local cache)
#
# A fresh random blob per repetition is deliberate: ghcr deduplicates layers by
# digest, so re-pushing an identical layer measures nothing but the API call.

set -uo pipefail

: "${GHCR_OWNER:?GHCR_OWNER is required}"
: "${GHCR_PACKAGE:?GHCR_PACKAGE is required}"
: "${GHCR_TOKEN:?GHCR_TOKEN is required}"
: "${PROBE_GROUP:?PROBE_GROUP is required}"
: "${PROBE_RUNNER:?PROBE_RUNNER is required}"

GHCR_USER="${GHCR_USER:-github-actions}"
OUT_FILE="${OUT_FILE:-results.jsonl}"
REPS="${REPS:-3}"
BLOB_MB="${BLOB_MB:-20}"
RUN_ID="${RUN_ID:-local}"
PROBE_REGION="${PROBE_REGION:-unknown}"

REGISTRY="ghcr.io"
ACCEPT_MANIFEST="application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"

repo_path="$(printf '%s/%s' "$GHCR_OWNER" "$GHCR_PACKAGE" | tr '[:upper:]' '[:lower:]')"
image="${REGISTRY}/${repo_path}"
blob_bytes=$((BLOB_MB * 1024 * 1024))

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

now_ms() { date +%s%3N; }
sec_to_ms() { awk -v v="$1" 'BEGIN { printf "%.1f", v * 1000 }'; }
throughput() { # bytes ms -> MB/s
  awk -v b="$1" -v ms="$2" 'BEGIN { if (ms <= 0) print "null"; else printf "%.2f", (b / 1048576) / (ms / 1000) }'
}

# curl_probe <name> <ok_code_regex> <outfile> <url> [curl args...]
# Emits a JSON key/value pair: "name":{...}
# outfile is explicit because curl maps repeated -o flags to successive URLs,
# so a caller-supplied -o would be silently ignored.
curl_probe() {
  local name=$1 ok_re=$2 out=$3 url=$4
  shift 4
  local raw code dns tcp tls ttfb total ip ok

  raw=$(curl -sS --output "$out" --max-time 30 \
    -w '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{remote_ip}' \
    "$@" "$url" 2>/dev/null)

  if [[ -z "$raw" ]]; then
    printf '"%s":{"ok":false,"status":0,"error":"no_response"}' "$name"
    return
  fi

  read -r code dns tcp tls ttfb total ip <<<"$raw"
  if [[ "$code" =~ ^($ok_re)$ ]]; then ok=true; else ok=false; fi

  printf '"%s":{"ok":%s,"status":%s,"ms":%s,"dns_ms":%s,"tcp_ms":%s,"tls_ms":%s,"ttfb_ms":%s,"remote_ip":"%s"}' \
    "$name" "$ok" "$code" \
    "$(sec_to_ms "$total")" "$(sec_to_ms "$dns")" "$(sec_to_ms "$tcp")" \
    "$(sec_to_ms "$tls")" "$(sec_to_ms "$ttfb")" "$ip"
}

# transfer_probe <name> <command...> -> emits "name":{...} with throughput
transfer_probe() {
  local name=$1
  shift
  local start end ms ok
  start=$(now_ms)
  if "$@" >"$workdir/docker.log" 2>&1; then ok=true; else ok=false; fi
  end=$(now_ms)
  ms=$((end - start))

  if [[ "$ok" == true ]]; then
    printf '"%s":{"ok":true,"ms":%s,"bytes":%s,"mbps":%s}' "$name" "$ms" "$blob_bytes" "$(throughput "$blob_bytes" "$ms")"
  else
    printf '"%s":{"ok":false,"ms":%s,"bytes":%s,"mbps":null,"error":%s}' "$name" "$ms" "$blob_bytes" \
      "$(tail -n 1 "$workdir/docker.log" | tr -d '"\\' | awk '{ printf "\"%s\"", substr($0, 1, 200) }')"
  fi
}

# Fail loudly and record nothing if we cannot log in. A credentials or
# configuration problem is ours, not the registry's, and writing it as five
# failed probes would report it on the status page as a ghcr.io outage.
echo "::group::Registry login"
if ! echo "$GHCR_TOKEN" | docker login "$REGISTRY" -u "$GHCR_USER" --password-stdin; then
  echo "::endgroup::"
  echo "::error title=Registry login failed::Could not log in to ${REGISTRY} as ${GHCR_USER}. No measurements recorded for this runner." >&2
  exit 1
fi
echo "::endgroup::"

for rep in $(seq 1 "$REPS"); do
  tag="probe-${PROBE_GROUP}-${RUN_ID}-${rep}"
  ref="${image}:${tag}"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  parts=()

  echo "::group::Repetition ${rep}/${REPS} (${ref})"

  # Build a unique, incompressible image so push/pull move real bytes.
  rm -rf "$workdir/ctx" && mkdir -p "$workdir/ctx"
  head -c "$blob_bytes" /dev/urandom >"$workdir/ctx/blob.bin"
  printf 'FROM scratch\nCOPY blob.bin /blob.bin\n' >"$workdir/ctx/Dockerfile"
  docker build --quiet --tag "$ref" "$workdir/ctx" >/dev/null

  parts+=("$(curl_probe ping '200|401' /dev/null "https://${REGISTRY}/v2/")")
  parts+=("$(curl_probe token '200' "$workdir/token.json" \
    "https://${REGISTRY}/token?service=${REGISTRY}&scope=repository:${repo_path}:pull" \
    -u "${GHCR_USER}:${GHCR_TOKEN}")")

  parts+=("$(transfer_probe push docker push "$ref")")

  bearer="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$workdir/token.json" 2>/dev/null)"
  if [[ -n "$bearer" ]]; then
    parts+=("$(curl_probe manifest '200' /dev/null "https://${REGISTRY}/v2/${repo_path}/manifests/${tag}" \
      -H "Authorization: Bearer ${bearer}" -H "Accept: ${ACCEPT_MANIFEST}")")
  else
    parts+=('"manifest":{"ok":false,"status":0,"error":"no_token"}')
  fi

  # Drop every local trace of the layer so the pull is a real download.
  docker rmi -f "$ref" >/dev/null 2>&1
  docker image prune -f >/dev/null 2>&1
  parts+=("$(transfer_probe pull docker pull "$ref")")
  docker rmi -f "$ref" >/dev/null 2>&1

  printf '{"ts":"%s","registry":"%s","runner_group":"%s","runner_label":"%s","region":"%s","run_id":"%s","rep":%s,"tag":"%s","probes":{%s}}\n' \
    "$ts" "$REGISTRY" "$PROBE_GROUP" "$PROBE_RUNNER" "$PROBE_REGION" "$RUN_ID" "$rep" "$tag" \
    "$(IFS=,; echo "${parts[*]}")" >>"$OUT_FILE"

  tail -n 1 "$OUT_FILE"
  echo "::endgroup::"
done

docker logout "$REGISTRY" >/dev/null 2>&1 || true
