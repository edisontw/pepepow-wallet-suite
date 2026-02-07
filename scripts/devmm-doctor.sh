#!/usr/bin/env bash
set -euo pipefail

TG_USER_ID="${1:-1948568791}"
UNIT="${2:-pepepow-trade-api}"
API_BASE="${API_BASE:-http://127.0.0.1:9195}"
LINES="${LINES:-1200}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not found in PATH"
  exit 1
fi

echo "== DevMM Doctor =="
echo "tg_user_id=${TG_USER_ID}"
echo "systemd_unit=${UNIT}"
echo "api_base=${API_BASE}"
echo

echo "== Status Snapshot =="
curl -s "${API_BASE}/v1/devmm/status?tg_user_id=${TG_USER_ID}" \
  | jq '.exchanges[] | {exchange,status,pauseReason,lastDecision,openOrders,pendingCount,phase,bootstrapDone,bootstrapBypassActive,turnoverUsed,turnoverCap,turnoverRemaining}'
echo

echo "== Recent Decision Logs =="
sudo journalctl -u "${UNIT}" -n "${LINES}" --no-pager \
  | egrep -i "devmmRunner|DAILY_CAP|BOOTSTRAP|orderAttempt|orderResult|PENDING_NOT_VISIBLE|MAX_OPEN_ORDERS_SOFT|NO_CROSSING|MIN_NOTIONAL|ORDER_NOT_VISIBLE|TICKER_FALLBACK|ZERO_SPREAD|DEVMM_OWNS_PAIR" \
  | tail -n 250 || true
echo

echo "== Scheduler MM/DevMM Collision Check =="
sudo journalctl -u "${UNIT}" -n "${LINES}" --no-pager \
  | egrep -i "\\[scheduler\\] (dispatch strategy=MM|skip strategy=MM|DEVMM_OWNS_PAIR)" \
  | tail -n 120 || true

