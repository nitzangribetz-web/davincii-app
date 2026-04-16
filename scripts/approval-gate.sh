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
  CACHED=$(python3 <<PYEOF
import json
try:
    with open("${CACHE_FILE}", "r") as f:
        cache = json.load(f)
    entry = cache.get("${PROMPT_HASH}")
    if entry and entry.get("approved"):
        print("hit")
    else:
        print("miss")
except:
    print("miss")
PYEOF
)

  if [[ "$CACHED" == "hit" ]]; then
    echo "Auto-approved from cache"
    exit 0
  fi
fi

# --- Create approval request directly in Supabase ---
echo "Requesting approval: $DESCRIPTION"
SOURCE="${APPROVAL_SOURCE:-claude-code}"

BODY=$(python3 <<PYEOF
import json
desc = """${DESCRIPTION}"""
ctx_raw = """${CONTEXT}"""
try:
    ctx = json.loads(ctx_raw)
except:
    ctx = {}
print(json.dumps({
    "prompt_hash": "${PROMPT_HASH}",
    "description": desc,
    "context": ctx,
    "source": "${SOURCE}",
    "status": "pending"
}))
PYEOF
)

# Insert directly via Supabase REST API
RESPONSE=$(curl -s -X POST \
  "${SUPABASE_URL}/rest/v1/approval_requests" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "$BODY")

REQUEST_ID=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list) and len(data) > 0:
        print(data[0].get('id',''))
    elif isinstance(data, dict):
        print(data.get('id',''))
    else:
        print('')
except:
    print('')
" 2>/dev/null)

if [[ -z "$REQUEST_ID" ]]; then
  echo "ERROR: Failed to create approval request" >&2
  echo "Response: $RESPONSE" >&2
  exit 1
fi

echo "Approval request created: $REQUEST_ID"

# --- Send Slack notification directly ---
if [[ -n "${SLACK_BOT_TOKEN:-}" && -n "${SLACK_CHANNEL_ID:-}" ]]; then
  SLACK_BODY=$(python3 <<PYEOF
import json
desc = """${DESCRIPTION}"""
ctx_raw = """${CONTEXT}"""
source = "${SOURCE}"
request_id = "${REQUEST_ID}"
try:
    ctx = json.loads(ctx_raw)
except:
    ctx = {}
context_lines = "\n".join([f"*{k}:* {v}" for k, v in ctx.items()])
blocks = [
    {"type": "header", "text": {"type": "plain_text", "text": "\u26a0\ufe0f Approval Required", "emoji": True}},
    {"type": "section", "text": {"type": "mrkdwn", "text": f"*{desc}*"}},
]
if context_lines:
    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": context_lines}})
blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"Source: \`{source}\`"}]})
blocks.append({"type": "actions", "elements": [
    {"type": "button", "text": {"type": "plain_text", "text": "Approve", "emoji": True}, "style": "primary", "action_id": "approve", "value": request_id},
    {"type": "button", "text": {"type": "plain_text", "text": "Deny", "emoji": True}, "style": "danger", "action_id": "deny", "value": request_id},
]})
print(json.dumps({"channel": "${SLACK_CHANNEL_ID}", "text": f"Approval required: {desc}", "blocks": blocks}))
PYEOF
)

  SLACK_RESPONSE=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "$SLACK_BODY")

  SLACK_OK=$(echo "$SLACK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null)

  if [[ "$SLACK_OK" == "True" ]]; then
    echo "Slack notification sent"
    # Update the row with slack_ts
    SLACK_TS=$(echo "$SLACK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ts',''))" 2>/dev/null)
    curl -s -X PATCH \
      "${SUPABASE_URL}/rest/v1/approval_requests?id=eq.${REQUEST_ID}" \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"slack_ts\":\"${SLACK_TS}\",\"slack_channel\":\"${SLACK_CHANNEL_ID}\"}" > /dev/null
  else
    echo "WARNING: Slack notification failed" >&2
    echo "$SLACK_RESPONSE" >&2
  fi
else
  echo "WARNING: SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not set — no notification sent" >&2
fi

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
    python3 <<PYEOF
import json, os
cache_file = "${CACHE_FILE}"
prompt_hash = "${PROMPT_HASH}"
desc = """${DESCRIPTION}"""
try:
    with open(cache_file, 'r') as f:
        cache = json.load(f)
except:
    cache = {}
cache[prompt_hash] = {"approved": True, "description": desc}
with open(cache_file, 'w') as f:
    json.dump(cache, f, indent=2)
PYEOF

    exit 0
  elif [[ "$STATUS" == "denied" ]]; then
    echo "DENIED"
    exit 2
  fi

  sleep $POLL_INTERVAL
done

echo "TIMEOUT: No response after $((MAX_POLLS * POLL_INTERVAL)) seconds" >&2
exit 1
