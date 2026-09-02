#!/usr/bin/env bash
#
# Delete all but the newest $KEEP versions of the probe container package.
# Every probe pushes a unique tag, so without this the package grows forever.
#
# Requires the gh CLI and GH_TOKEN. GITHUB_TOKEN is sufficient for a package
# owned by an organisation; for a user-owned package GitHub requires a PAT with
# the delete:packages scope, so this script is expected to be best-effort.

set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${OWNER:?OWNER is required}"
: "${PACKAGE:?PACKAGE is required}"
KEEP="${KEEP:-30}"

# Organisation and user accounts use different endpoints; try the org one first.
for scope in "orgs/${OWNER}" "users/${OWNER}"; do
  base="${scope}/packages/container/${PACKAGE}"
  if ! versions=$(gh api --paginate "${base}/versions?per_page=100" \
      --jq '.[] | "\(.created_at) \(.id)"' 2>/dev/null); then
    continue
  fi

  total=$(printf '%s\n' "$versions" | grep -c . || true)
  echo "Found ${total} version(s) under ${scope}; keeping newest ${KEEP}."
  [[ "$total" -le "$KEEP" ]] && exit 0

  printf '%s\n' "$versions" | sort -r | tail -n +$((KEEP + 1)) | while read -r _ id; do
    [[ -z "$id" ]] && continue
    if gh api --silent -X DELETE "${base}/versions/${id}"; then
      echo "  deleted version ${id}"
    else
      echo "  could not delete version ${id}"
    fi
  done
  exit 0
done

echo "Package ${PACKAGE} not reachable under ${OWNER}; nothing pruned."
