#!/usr/bin/env bash
#
# Delete all but the newest $KEEP versions of the probe container package.
# Every probe pushes a unique tag, so without this the package grows forever.
#
# Requires the gh CLI and GH_TOKEN. GITHUB_TOKEN is sufficient for a package
# owned by an organisation. A package owned by a user account is only reachable
# through the /user endpoints, which need a real user PAT with delete:packages -
# GITHUB_TOKEN is not one, so on a user-owned repository this script is expected
# to report that it could not prune until such a token is supplied.

set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${OWNER:?OWNER is required}"
: "${PACKAGE:?PACKAGE is required}"
KEEP="${KEEP:-30}"

# Organisations are addressed by name; a user's own packages only through
# /user (there is no deletable /users/{name} route). Try the org route first.
for scope in "orgs/${OWNER}" "user"; do
  base="${scope}/packages/container/${PACKAGE}"
  if ! versions=$(gh api --paginate "${base}/versions?per_page=100" \
      --jq '.[] | "\(.created_at) \(.id)"' 2>/dev/null); then
    continue
  fi

  total=$(printf '%s\n' "$versions" | grep -c . || true)
  [[ "$total" -eq 0 ]] && continue
  echo "Found ${total} version(s) via /${scope}; keeping newest ${KEEP}."
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

echo "Could not reach package ${PACKAGE} for ${OWNER} with this token; nothing pruned."
echo "A user-owned package needs a PAT with delete:packages in GH_TOKEN."
