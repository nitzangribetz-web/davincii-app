#!/usr/bin/env bash
# Universal Permission Approval Gate
# Usage: approval-gate.sh "Description of what needs approval" '{"tool":"name","args":"..."}'
# Exit codes: 0 = approved, 1 = timeout/error, 2 = denied

set -euo pipefail

DESCRIPTION="${1:?Usage: approval-gate.sh \"description\" [context_json]}"
CONTEXT="${2:-{}}"
CACHE_FILE="$HOME/.claude/approval-cache.json"
ENV_FILE="$HOME/.claude/approval-env"
POLL_INTERVAL=3
MAX_POLLS=100  # 5 minutes at 3s intervals

# --- Load environment ---
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Missing $ENV_FILE" >&2
  echo "Create it with:" >&2
  echo "  SUPABASE_URL=https://your-project.supabase.co" >&2
  echo "  SUPABASE_ANON_KEY=your-anon-key" >&2
  echo "  SUPABASE_FUNCTION_URL=https://your-project.supabase.co/functions/v1" >&2
  exit 1
fi
source "$ENV_FILE"

# --- Compute prompt hash ---
PROMPT_HASH=$(echo -n "$DESCRIPTION" | shasum -a 256 | cut -d' ' -f1)

# --- Check local cache ---
if [[ -f "$CACHE_FILE" ]]; then
  CACHED=$(cat "$CACHE_FILE" | python3 -c "
import sys, json
try:
    cache = json.load(sys.stdin)
    entry = cache.get('$PROMPT_HASH')
    if entry and entry.get('approved'):
        print('hit')
    else:
        print('miss')
except:
    print('miss')
" 2>/dev/null || echo "miss")

  if [[ "$CACHED" == "hit" ]]; then
    echo "Auto-approved from cache"
    exit 0
  fi
fi

# --- Create approval request via edge function ---
echo "Requesting approval: $DESCRIPTION"

RESPONSE=$(curl -s -X POST \
  "${SUPABASE_FUNCTION_URL}/create-approval-request" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -d "$(python3 -c "
import json, sys
print(json.dumps({
    'description': $(python3 -c "import json; print(json.dumps('$DESCRIPTION'))"),
    'context': $CONTEXT,
    'prompt_hash': '$PROMPT_HASH',
    'source': '${APPROVAL_SOURCE:-claude-code}'
}))
")")

REQUEST_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)

if [[ -z "$REQUEST_ID" ]]; then
  echo "ERROR: Failed to create approval request" >&2
  echo "Response: $RESPONSE" >&2
  exit 1
fi

echo "Approval request created: $REQUEST_ID"
echo "Waiting for response..."

# --- Poll for response ---
for ((i=1; i<=MAX_POLLS; i++)); do
  STATUS_RESPONSE=$(curl -s \
    "${SUPABASE_URL}/rest/v1/approval_requests?id=eq.${REQUEST_ID}&select=status" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}")

  STATUS=$(echo "$STATUS_RESPONSE" | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
    if rows and len(rows) > 0:
        print(rows[0].get('status', 'pending'))
    else:
        print('pending')
except:
    print('pending')
" 2>/dev/null || echo "pending")

  if [[ "$STATUS" == "approved" ]]; then
    echo "APPROVED"

    # Cache the approval
    mkdir -p "$(dirname "$CACHE_FILE")"
    if [[ -f "$CACHE_FILE" ]]; then
      python3 -c "
import json
try:
    with open('$CACHE_FILE', 'r') as f:
        cache = json.load(f)
except:
    cache = {}
cache['$PROMPT_HASH'] = {'approved': True, 'description': $(python3 -c "import json; print(json.dumps('$DESCRIPTION'))")}
with open('$CACHE_FILE', 'w') as f:
    json.dump(cache, f, indent=2)
"
    else
      python3 -c "
import json
cache = {'$PROMPT_HASH': {'approved': True, 'description': $(python3 -c "import json; print(json.dumps('$DESCRIPTION'))")}}
with open('$CACHE_FILE', 'w') as f:
    json.dump(cache, f, indent=2)
"
    fi

    exit 0
  elif [[ "$STATUS" == "denied" ]]; then
    echo "DENIED"
    exit 2
  fi

  sleep $POLL_INTERVAL
done

echo "TIMEOUT: No response after $((MAX_POLLS * POLL_INTERVAL)) seconds" >&2
exit 1
