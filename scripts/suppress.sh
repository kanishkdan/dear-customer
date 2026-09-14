#!/usr/bin/env bash
# Hide a business from the public Wall right away, for example after a removal request.
# Usage: scripts/suppress.sh "Business Name" "reason"
# Undo:  scripts/suppress.sh --undo "Business Name"
set -euo pipefail
cd "$(dirname "$0")/../community"
UNDO=0; if [ "${1:-}" = "--undo" ]; then UNDO=1; shift; fi
NAME="${1:?business name as shown on the Wall}"
REASON="${2:-removal request}"
KEY=$(node -e 'process.stdout.write(String(process.argv[1]).toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim())' "$NAME")
[ -n "$KEY" ] || { echo "empty name"; exit 1; }
REASON_SQL=$(node -e 'process.stdout.write(String(process.argv[1]).replace(/\x27/g,"\x27\x27"))' "$REASON")
if [ "$UNDO" = 1 ]; then
  npx wrangler d1 execute bouncer-list --remote --command "DELETE FROM suppressed WHERE name_key = '$KEY';"
  echo "Restored: $KEY"
else
  npx wrangler d1 execute bouncer-list --remote --command "INSERT OR REPLACE INTO suppressed (name_key, reason, created_at) VALUES ('$KEY', '$REASON_SQL', strftime('%s','now'));"
  echo "Hidden: $KEY. Public pages update within a minute."
fi
