#!/usr/bin/env bash
set -euo pipefail

INTERVAL_SECONDS=600
ONCE=0
APPLY_SAFE_FIXES=0
ALLOW_DERIVED_STATE_RESET=0
ALLOW_BINARY_SWAP=0
ALLOW_TARGETED_BLK_REPLACE=0
EXPECTED_DAEMON_SHA256=""
EXPECTED_CLI_SHA256=""
EXPECTED_CHECKSUMS_FILE=""
DONOR_BLOCKS_DIR=""
RPC_CLI="/home/ubuntu/PEPEPOW-cli"
DAEMON_BIN="/home/ubuntu/PEPEPOWd"
DATADIR="/home/ubuntu/.PEPEPOWcore"
STATE_FILE="/home/ubuntu/.PEPEPOWcore/backups/reindex-monitor/state.json"
REPORT_DIR="/home/ubuntu/.PEPEPOWcore/backups/reindex-monitor/reports"
FIXTURE_DIR="${PEPEPOWD_MONITOR_FIXTURE_DIR:-}"

declare -a CHANGES_MADE=()
declare -a RECOMMENDATION_LINES=()

usage() {
  cat <<'EOF'
Usage: pepepowd-reindex-monitor.sh [options]

Options:
  --interval-seconds N
  --once
  --state-file PATH
  --report-dir PATH
  --apply-safe-fixes
  --allow-derived-state-reset
  --allow-binary-swap
  --allow-targeted-blk-replace
  --expected-daemon-sha256 SHA256
  --expected-cli-sha256 SHA256
  --expected-checksums-file PATH
  --donor-blocks-dir PATH
  --rpc-cli PATH
  --daemon-bin PATH
  --datadir PATH
  --help
EOF
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

json_escape() {
  local value="${1-}"
  python3 - "$value" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1]))
PY
}

json_query() {
  local json_input="${1-}"
  local expression="${2-}"
  local default_value="${3-}"
  python3 - "$expression" "$default_value" /dev/fd/3 3<<<"$json_input" <<'PY'
import json
import sys

expr = sys.argv[1]
default = sys.argv[2]
path = sys.argv[3]
with open(path, "r", encoding="utf-8") as fh:
    raw = fh.read()
if not raw.strip():
    print(default)
    raise SystemExit(0)
try:
    data = json.loads(raw)
    value = eval(expr, {"__builtins__": {}}, {"data": data})
except Exception:
    print(default)
    raise SystemExit(0)
if value is None:
    print(default)
elif isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, (int, float)):
    print(value)
else:
    print(str(value))
PY
}

read_state_key() {
  local key="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    return 0
  fi
  python3 - "$STATE_FILE" "$key" <<'PY'
import json
import sys

path = sys.argv[1]
key = sys.argv[2]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    raise SystemExit(0)
value = data.get(key, "")
if isinstance(value, bool):
    print("true" if value else "false")
elif value is None:
    print("")
else:
    print(value)
PY
}

write_json_file() {
  local output_path="$1"
  local json_lines
  json_lines="$(cat)"
  WRITE_JSON_LINES="$json_lines" python3 - "$output_path" <<'PY'
import json
import os
import sys

out_path = sys.argv[1]
data = {}
for raw_line in os.environ.get("WRITE_JSON_LINES", "").splitlines():
    line = raw_line.rstrip("\n")
    if not line:
      continue
    parts = line.split("\t", 2)
    if len(parts) != 3:
        continue
    key, kind, value = parts
    if kind == "num":
        try:
            if "." in value:
                data[key] = float(value)
            else:
                data[key] = int(value)
        except ValueError:
            data[key] = value
    elif kind == "bool":
        data[key] = value.lower() == "true"
    elif kind == "null":
        data[key] = None
    else:
        data[key] = value
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
}

fixture_read() {
  local relative_path="$1"
  if [[ -n "$FIXTURE_DIR" && -f "$FIXTURE_DIR/$relative_path" ]]; then
    cat "$FIXTURE_DIR/$relative_path"
    return 0
  fi
  return 1
}

fixture_or_cmd() {
  local relative_path="$1"
  shift
  if ! fixture_read "$relative_path"; then
    "$@"
  fi
}

current_utc() {
  if ! fixture_or_cmd "date_utc.txt" date -u '+%Y-%m-%d %H:%M:%S UTC'; then
    date -u '+%Y-%m-%d %H:%M:%S UTC'
  fi
}

current_local() {
  if ! fixture_or_cmd "date_local.txt" date '+%Y-%m-%d %H:%M:%S %Z'; then
    date '+%Y-%m-%d %H:%M:%S %Z'
  fi
}

ensure_parent_dirs() {
  mkdir -p "$(dirname "$STATE_FILE")" "$REPORT_DIR"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --interval-seconds)
        INTERVAL_SECONDS="$2"
        shift 2
        ;;
      --once)
        ONCE=1
        shift
        ;;
      --state-file)
        STATE_FILE="$2"
        shift 2
        ;;
      --report-dir)
        REPORT_DIR="$2"
        shift 2
        ;;
      --apply-safe-fixes)
        APPLY_SAFE_FIXES=1
        shift
        ;;
      --allow-derived-state-reset)
        ALLOW_DERIVED_STATE_RESET=1
        shift
        ;;
      --allow-binary-swap)
        ALLOW_BINARY_SWAP=1
        shift
        ;;
      --allow-targeted-blk-replace)
        ALLOW_TARGETED_BLK_REPLACE=1
        shift
        ;;
      --expected-daemon-sha256)
        EXPECTED_DAEMON_SHA256="$2"
        shift 2
        ;;
      --expected-cli-sha256)
        EXPECTED_CLI_SHA256="$2"
        shift 2
        ;;
      --expected-checksums-file)
        EXPECTED_CHECKSUMS_FILE="$2"
        shift 2
        ;;
      --donor-blocks-dir)
        DONOR_BLOCKS_DIR="$2"
        shift 2
        ;;
      --rpc-cli)
        RPC_CLI="$2"
        shift 2
        ;;
      --daemon-bin)
        DAEMON_BIN="$2"
        shift 2
        ;;
      --datadir)
        DATADIR="$2"
        shift 2
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

sample_path() {
  local name="$1"
  printf '%s/%s\n' "$REPORT_DIR" "$name"
}

record_change() {
  CHANGES_MADE+=("$1")
}

add_recommendation() {
  RECOMMENDATION_LINES+=("$1")
}

bool_to_yes_no() {
  case "${1-}" in
    true|yes|1) printf 'yes\n' ;;
    *) printf 'no\n' ;;
  esac
}

collect_process_info() {
  local pgrep_output=""
  pgrep_output="$(fixture_or_cmd "pgrep.txt" pgrep -a PEPEPOWd || true)"
  PROCESS_PGREP_OUTPUT="$pgrep_output"
  if [[ -n "$pgrep_output" ]]; then
    PID="${pgrep_output%% *}"
    PROCESS_RUNNING="true"
  else
    PID=""
    PROCESS_RUNNING="false"
  fi

  if [[ -n "$FIXTURE_DIR" ]]; then
    PROCESS_FP_OUTPUT="$(fixture_read "ps_fp.txt" || true)"
    PROCESS_STATS_OUTPUT="$(fixture_read "ps_stats.txt" || true)"
    PID_LSTART="$(fixture_read "pid_lstart.txt" || true)"
    PROC_EXE_PATH="$(fixture_read "proc_exe.txt" || true)"
    PROC_CMDLINE_RAW="$(fixture_read "proc_cmdline.txt" || true)"
  elif [[ -n "$PID" ]]; then
    PROCESS_FP_OUTPUT="$(ps -fp "$PID" || true)"
    PROCESS_STATS_OUTPUT="$(ps -o pid,etimes,%cpu,%mem,rss,vsz,stat,cmd -p "$PID" || true)"
    PID_LSTART="$(ps -o lstart= -p "$PID" | sed 's/^ *//' || true)"
    PROC_EXE_PATH="$(readlink -f "/proc/$PID/exe" || true)"
    if [[ -r "/proc/$PID/cmdline" ]]; then
      PROC_CMDLINE_RAW="$(tr '\0' ' ' < "/proc/$PID/cmdline" | sed 's/[[:space:]]*$//')"
    else
      PROC_CMDLINE_RAW="$(ps -o args= -p "$PID" | sed 's/^ *//' || true)"
    fi
  else
    PROCESS_FP_OUTPUT=""
    PROCESS_STATS_OUTPUT=""
    PID_LSTART=""
    PROC_EXE_PATH=""
    PROC_CMDLINE_RAW=""
  fi

  if [[ -n "$PID_LSTART" ]]; then
    PID_START_UTC="$(date -u -d "$PID_LSTART" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || true)"
  else
    PID_START_UTC=""
  fi

  CMDLINE="$PROC_CMDLINE_RAW"
  if [[ -z "$CMDLINE" ]]; then
    CMDLINE="$(read_state_key cmdline)"
  fi

  PROCESS_RUNTIME=""
  PROCESS_CPU=""
  PROCESS_MEM=""
  if [[ -n "$PROCESS_STATS_OUTPUT" ]]; then
    read -r PROCESS_RUNTIME PROCESS_CPU PROCESS_MEM < <(
      python3 - /dev/fd/3 3<<<"$PROCESS_STATS_OUTPUT" <<'PY'
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    lines = [line.rstrip("\n") for line in fh if line.strip()]
if len(lines) < 2:
    print("", "", "")
    raise SystemExit(0)
parts = lines[1].split(None, 7)
if len(parts) < 8:
    print("", "", "")
    raise SystemExit(0)
print(parts[1], parts[2], parts[3])
PY
    )
  fi
  REINDEX_ACTIVE="false"
  if [[ "$CMDLINE" == *"-reindex"* ]]; then
    REINDEX_ACTIVE="true"
  fi
}

collect_chain_info() {
  if [[ -n "$FIXTURE_DIR" ]]; then
    GETBLOCKCOUNT_OUTPUT="$(fixture_read "getblockcount.txt" || true)"
    BLOCKCHAININFO_JSON="$(fixture_read "getblockchaininfo.json" || true)"
  else
    GETBLOCKCOUNT_OUTPUT="$("$RPC_CLI" getblockcount 2>&1 || true)"
    BLOCKCHAININFO_JSON="$("$RPC_CLI" getblockchaininfo 2>&1 || true)"
  fi

  BLOCKS="$(printf '%s\n' "$GETBLOCKCOUNT_OUTPUT" | tr -d '\r' | tail -n 1 | tr -d ' ')"
  if [[ ! "$BLOCKS" =~ ^-?[0-9]+$ ]]; then
    BLOCKS="$(json_query "$BLOCKCHAININFO_JSON" 'data.get("blocks", "")' "")"
  fi
  if [[ ! "$BLOCKS" =~ ^-?[0-9]+$ ]]; then
    BLOCKS=""
  fi

  HEADERS="$(json_query "$BLOCKCHAININFO_JSON" 'data.get("headers", "")' "")"
  BESTBLOCKHASH="$(json_query "$BLOCKCHAININFO_JSON" 'data.get("bestblockhash", "")' "")"
  CHAIN_NAME="$(json_query "$BLOCKCHAININFO_JSON" 'data.get("chain", "")' "")"

  RPC_OK="false"
  if [[ "$BLOCKCHAININFO_JSON" == *'"chain"'* ]]; then
    RPC_OK="true"
  fi
}

filter_current_run_log() {
  local log_source=""
  if [[ -n "$FIXTURE_DIR" ]]; then
    log_source="$FIXTURE_DIR/debug.log"
  else
    log_source="$DATADIR/debug.log"
  fi

  if [[ ! -f "$log_source" ]]; then
    CURRENT_RUN_LOG=""
    LAST_200_LOG_LINES=""
    return
  fi

  LAST_200_LOG_LINES="$(tail -n 200 "$log_source" || true)"
  if [[ -n "$PID_START_UTC" ]]; then
    CURRENT_RUN_LOG="$(awk -v start="$PID_START_UTC" '
      $1 ~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ {
        stamp = $1 " " $2
        if (stamp >= start) {
          print
        }
      }
    ' "$log_source")"
  else
    CURRENT_RUN_LOG="$LAST_200_LOG_LINES"
  fi
}

parse_log_signals() {
  local parsed=""
  parsed="$(python3 - /dev/fd/3 3<<<"$CURRENT_RUN_LOG" <<'PY'
import re
import sys

current_blk = ""
last_reindex_line = ""
last_loaded_line = ""
last_error_line = ""
last_error_blk = ""
pow_seen = False
deserialize_seen = False
reindex_count = 0
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    lines = [line.rstrip("\n") for line in fh if line.strip()]

error_patterns = (
    "LoadExternalBlockFile",
    "Deserialize",
    "incorrect proof of work",
    "ReadBlockFromDisk",
    "Error opening block database",
    "InvalidChainFound",
    "SetBestChain",
    "UpdateTip",
)

for line in lines:
    reindex_match = re.search(r"Reindexing block file (blk\d+\.dat)", line)
    if reindex_match:
        current_blk = reindex_match.group(1)
        last_reindex_line = line
        reindex_count += 1
    if "Loaded " in line and " blocks from external file" in line:
        last_loaded_line = line
    if any(pattern in line for pattern in error_patterns):
        last_error_line = line
        if current_blk:
            last_error_blk = current_blk
    if "incorrect proof of work at 1930000" in line:
        pow_seen = True
    if "LoadExternalBlockFile" in line or "Deserialize" in line:
        deserialize_seen = True

print(f"last_reindex_line\t{last_reindex_line}")
print(f"last_loaded_line\t{last_loaded_line}")
print(f"last_error_line\t{last_error_line}")
print(f"last_error_blk\t{last_error_blk}")
print(f"last_log_blk\t{current_blk}")
print(f"pow_seen\t{'true' if pow_seen else 'false'}")
print(f"deserialize_seen\t{'true' if deserialize_seen else 'false'}")
print(f"reindex_count\t{reindex_count}")
PY
)"
  LAST_REINDEX_LINE=""
  LAST_LOADED_BLOCKS_LINE=""
  LAST_ERROR_LINE=""
  LAST_ERROR_BLK_FILE=""
  LAST_LOG_BLK_FILE=""
  CURRENT_RUN_POW1930000_SEEN="false"
  CURRENT_RUN_DESERIALIZE_SEEN="false"
  CURRENT_RUN_MIXED_ERROR_SEEN="false"
  CURRENT_RUN_REINDEX_COUNT="0"

  while IFS=$'\t' read -r key value; do
    case "$key" in
      last_reindex_line) LAST_REINDEX_LINE="$value" ;;
      last_loaded_line) LAST_LOADED_BLOCKS_LINE="$value" ;;
      last_error_line) LAST_ERROR_LINE="$value" ;;
      last_error_blk) LAST_ERROR_BLK_FILE="$value" ;;
      last_log_blk) LAST_LOG_BLK_FILE="$value" ;;
      pow_seen) CURRENT_RUN_POW1930000_SEEN="$value" ;;
      deserialize_seen) CURRENT_RUN_DESERIALIZE_SEEN="$value" ;;
      reindex_count) CURRENT_RUN_REINDEX_COUNT="$value" ;;
    esac
  done <<<"$parsed"

  if [[ "$CURRENT_RUN_POW1930000_SEEN" == "true" && "$CURRENT_RUN_DESERIALIZE_SEEN" == "true" ]]; then
    CURRENT_RUN_MIXED_ERROR_SEEN="true"
  fi

  LAST_ERROR_SIGNATURE=""
  if [[ -n "$LAST_ERROR_LINE" ]]; then
    case "$LAST_ERROR_LINE" in
      *"incorrect proof of work at 1930000"*)
        LAST_ERROR_SIGNATURE="incorrect proof of work at 1930000"
        ;;
      *"LoadExternalBlockFile"*)
        LAST_ERROR_SIGNATURE="LoadExternalBlockFile deserialize or I/O error"
        ;;
      *"Deserialize"*)
        LAST_ERROR_SIGNATURE="deserialize error"
        ;;
      *"Error opening block database"*)
        LAST_ERROR_SIGNATURE="Error opening block database"
        ;;
      *)
        LAST_ERROR_SIGNATURE="$LAST_ERROR_LINE"
        ;;
    esac
  fi
}

collect_lsof_blk_file() {
  if [[ -n "$FIXTURE_DIR" ]]; then
    LSOF_OUTPUT="$(fixture_read "lsof.txt" || true)"
  elif [[ -n "$PID" ]]; then
    LSOF_OUTPUT="$(lsof -p "$PID" 2>/dev/null | grep "$DATADIR" || true)"
  else
    LSOF_OUTPUT=""
  fi

  CURRENT_BLK_FILE="$(printf '%s\n' "$LSOF_OUTPUT" | sed -n 's#.*\(blk[0-9]\{5\}\.dat\).*#\1#p' | tail -n 1)"
  if [[ -z "$CURRENT_BLK_FILE" ]]; then
    CURRENT_BLK_FILE="$LAST_LOG_BLK_FILE"
  fi
  if [[ -z "$LAST_ERROR_BLK_FILE" ]]; then
    LAST_ERROR_BLK_FILE="$CURRENT_BLK_FILE"
  fi
}

collect_peer_info() {
  if [[ -n "$FIXTURE_DIR" ]]; then
    NETWORKINFO_JSON="$(fixture_read "getnetworkinfo.json" || true)"
    PEERINFO_JSON="$(fixture_read "getpeerinfo.json" || true)"
  else
    NETWORKINFO_JSON="$("$RPC_CLI" getnetworkinfo 2>&1 || true)"
    PEERINFO_JSON="$("$RPC_CLI" getpeerinfo 2>&1 || true)"
  fi

  read -r PEER_COUNT PEER_HEIGHT_MIN PEER_HEIGHT_MAX PEER_VERSIONS PEERS_AHEAD <<<"$(
    python3 - /dev/fd/3 3<<<"$PEERINFO_JSON" <<'PY'
import json
import sys

peer_count = 0
min_height = ""
max_height = ""
versions = []
peers_ahead = "false"

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    raw = fh.read()
try:
    peers = json.loads(raw)
except Exception:
    print("0   unknown false")
    raise SystemExit(0)

if isinstance(peers, list):
    peer_count = len(peers)
    heights = [peer.get("startingheight") for peer in peers if isinstance(peer.get("startingheight"), int)]
    versions = sorted({str(peer.get("version")) for peer in peers if peer.get("version") is not None})
    if heights:
        min_height = str(min(heights))
        max_height = str(max(heights))
if peer_count and max_height not in ("", "0"):
    peers_ahead = "true"
print(peer_count, min_height or "unknown", max_height or "unknown", ",".join(versions) or "unknown", peers_ahead)
PY
  )"
  NETWORK_CONNECTIONS="$(json_query "$NETWORKINFO_JSON" 'data.get("connections", "")' "")"
  NETWORK_SUBVERSION="$(json_query "$NETWORKINFO_JSON" 'data.get("subversion", "")' "")"
}

collect_binary_info() {
  if [[ -n "$FIXTURE_DIR" ]]; then
    SHA256_OUTPUT="$(fixture_read "sha256sum.txt" || true)"
    STAT_BINARIES_OUTPUT="$(fixture_read "stat_binaries.txt" || true)"
  else
    SHA256_OUTPUT="$(sha256sum "$DAEMON_BIN" "$RPC_CLI" 2>&1 || true)"
    STAT_BINARIES_OUTPUT="$(stat "$DAEMON_BIN" "$RPC_CLI" 2>&1 || true)"
  fi

  DAEMON_SHA256="$(printf '%s\n' "$SHA256_OUTPUT" | awk -v path="$DAEMON_BIN" '$2 == path {print $1}' | tail -n 1)"
  CLI_SHA256="$(printf '%s\n' "$SHA256_OUTPUT" | awk -v path="$RPC_CLI" '$2 == path {print $1}' | tail -n 1)"
  ACTIVE_BINARY_PATH="$PROC_EXE_PATH"
  if [[ -z "$ACTIVE_BINARY_PATH" ]]; then
    ACTIVE_BINARY_PATH="$DAEMON_BIN"
  fi
}

parse_checksums_file() {
  local file_path="$1"
  local daemon_expected=""
  local cli_expected=""
  if [[ -f "$file_path" ]]; then
    daemon_expected="$(awk '$2 ~ /(^|\/)PEPEPOWd$/ {print $1}' "$file_path" | tail -n 1)"
    cli_expected="$(awk '$2 ~ /(^|\/)PEPEPOW-cli$/ {print $1}' "$file_path" | tail -n 1)"
  fi
  printf '%s\n%s\n' "$daemon_expected" "$cli_expected"
}

evaluate_binary_integrity() {
  BINARY_REFERENCE_AVAILABLE="false"
  BINARY_REFERENCE_SOURCE=""
  EFFECTIVE_EXPECTED_DAEMON_SHA256="$EXPECTED_DAEMON_SHA256"
  EFFECTIVE_EXPECTED_CLI_SHA256="$EXPECTED_CLI_SHA256"

  if [[ -z "$EFFECTIVE_EXPECTED_DAEMON_SHA256" || -z "$EFFECTIVE_EXPECTED_CLI_SHA256" ]]; then
    if [[ -n "$EXPECTED_CHECKSUMS_FILE" && -f "$EXPECTED_CHECKSUMS_FILE" ]]; then
      mapfile -t checksum_values < <(parse_checksums_file "$EXPECTED_CHECKSUMS_FILE")
      if [[ -z "$EFFECTIVE_EXPECTED_DAEMON_SHA256" ]]; then
        EFFECTIVE_EXPECTED_DAEMON_SHA256="${checksum_values[0]:-}"
      fi
      if [[ -z "$EFFECTIVE_EXPECTED_CLI_SHA256" ]]; then
        EFFECTIVE_EXPECTED_CLI_SHA256="${checksum_values[1]:-}"
      fi
      BINARY_REFERENCE_SOURCE="$EXPECTED_CHECKSUMS_FILE"
    fi
  fi

  if [[ -n "$EFFECTIVE_EXPECTED_DAEMON_SHA256" && -n "$EFFECTIVE_EXPECTED_CLI_SHA256" ]]; then
    BINARY_REFERENCE_AVAILABLE="true"
    if [[ -z "$BINARY_REFERENCE_SOURCE" ]]; then
      BINARY_REFERENCE_SOURCE="explicit sha256 flags"
    fi
  fi

  BINARY_MISMATCH_PROVEN="false"
  BINARY_MATCH_PROVEN="false"
  if [[ "$BINARY_REFERENCE_AVAILABLE" == "true" ]]; then
    if [[ "$DAEMON_SHA256" == "$EFFECTIVE_EXPECTED_DAEMON_SHA256" && "$CLI_SHA256" == "$EFFECTIVE_EXPECTED_CLI_SHA256" ]]; then
      BINARY_MATCH_PROVEN="true"
    else
      BINARY_MISMATCH_PROVEN="true"
    fi
  fi

  REPLACEMENT_DAEMON_BIN=""
  REPLACEMENT_CLI_BIN=""
  if [[ -n "$EXPECTED_CHECKSUMS_FILE" ]]; then
    local checksum_dir
    checksum_dir="$(cd "$(dirname "$EXPECTED_CHECKSUMS_FILE")" && pwd)"
    if [[ -f "$checksum_dir/PEPEPOWd" ]]; then
      REPLACEMENT_DAEMON_BIN="$checksum_dir/PEPEPOWd"
    fi
    if [[ -f "$checksum_dir/PEPEPOW-cli" ]]; then
      REPLACEMENT_CLI_BIN="$checksum_dir/PEPEPOW-cli"
    fi
  fi
}

collect_block_data_clues() {
  if [[ -n "$FIXTURE_DIR" ]]; then
    BLOCKS_LS_OUTPUT="$(fixture_read "blocks_ls.txt" || true)"
    BLOCKS_STAT_OUTPUT="$(fixture_read "blocks_stat.txt" || true)"
  else
    BLOCKS_LS_OUTPUT="$(ls -lh "$DATADIR/blocks" 2>/dev/null | tail -n 40 || true)"
    BLOCKS_STAT_OUTPUT="$(stat "$DATADIR"/blocks/blk*.dat "$DATADIR"/blocks/rev*.dat 2>/dev/null | tail -n 120 || true)"
  fi

  TARGET_REV_FILE=""
  if [[ -n "$LAST_ERROR_BLK_FILE" ]]; then
    TARGET_REV_FILE="${LAST_ERROR_BLK_FILE/blk/rev}"
  fi
}

collect_environment_info() {
  if [[ -n "$FIXTURE_DIR" ]]; then
    DF_OUTPUT="$(fixture_read "df.txt" || true)"
    FREE_OUTPUT="$(fixture_read "free.txt" || true)"
    DMESG_TAIL_OUTPUT="$(fixture_read "dmesg_tail.txt" || true)"
    DMESG_GREP_OUTPUT="$(fixture_read "dmesg_grep.txt" || true)"
  else
    DF_OUTPUT="$(df -h 2>&1 || true)"
    FREE_OUTPUT="$(free -m 2>&1 || true)"
    DMESG_TAIL_OUTPUT="$( (dmesg 2>&1 || true) | tail -n 100 )"
    DMESG_GREP_OUTPUT="$( (dmesg 2>&1 || true) | grep -i -E 'oom|kill|error|ext4|xfs|disk|i/o' | tail -n 100 || true )"
  fi
}

progress_value() {
  local prev_blocks="$1"
  local prev_blk="$2"
  local prev_reindex="$3"
  local prev_loaded="$4"
  local blocks="$5"
  local blk="$6"
  local reindex="$7"
  local loaded="$8"

  if [[ -n "$prev_blocks" && -n "$blocks" && "$blocks" =~ ^-?[0-9]+$ && "$prev_blocks" =~ ^-?[0-9]+$ && "$blocks" -gt "$prev_blocks" ]]; then
    printf 'blocks\n'
    return
  fi
  if [[ -n "$blk" && "$blk" != "$prev_blk" ]]; then
    printf 'block-file\n'
    return
  fi
  if [[ -n "$reindex" && "$reindex" != "$prev_reindex" ]]; then
    printf 'reindex-log\n'
    return
  fi
  if [[ -n "$loaded" && "$loaded" != "$prev_loaded" ]]; then
    printf 'loaded-log\n'
    return
  fi
  printf 'none\n'
}

classify_state() {
  local prev_blocks prev_blk prev_reindex prev_loaded prev_no_progress prev_pow prev_mixed
  prev_blocks="$(read_state_key blocks)"
  prev_blk="$(read_state_key current_blk_file)"
  prev_reindex="$(read_state_key last_reindex_line)"
  prev_loaded="$(read_state_key last_loaded_blocks_line)"
  prev_no_progress="$(read_state_key consecutive_no_progress_cycles)"
  prev_pow="$(read_state_key current_run_pow1930000_seen)"
  prev_mixed="$(read_state_key current_run_mixed_error_seen)"

  PROGRESS_REASON="$(progress_value "$prev_blocks" "$prev_blk" "$prev_reindex" "$prev_loaded" "$BLOCKS" "$CURRENT_BLK_FILE" "$LAST_REINDEX_LINE" "$LAST_LOADED_BLOCKS_LINE")"
  PROGRESS_SINCE_LAST_CHECK="false"
  if [[ "$PROGRESS_REASON" != "none" ]]; then
    PROGRESS_SINCE_LAST_CHECK="true"
    CONSECUTIVE_NO_PROGRESS_CYCLES=0
  else
    if [[ "$prev_no_progress" =~ ^[0-9]+$ ]]; then
      CONSECUTIVE_NO_PROGRESS_CYCLES=$((prev_no_progress + 1))
    else
      CONSECUTIVE_NO_PROGRESS_CYCLES=1
    fi
  fi

  CLASSIFICATION=""
  if [[ "$PROCESS_RUNNING" != "true" || "$RPC_OK" != "true" ]]; then
    CLASSIFICATION="crashed"
  elif [[ "$PROGRESS_REASON" == "blocks" ]]; then
    CLASSIFICATION="progressing"
  elif [[ "$PROGRESS_REASON" != "none" ]]; then
    CLASSIFICATION="slow but progressing"
  elif [[ "$CURRENT_RUN_MIXED_ERROR_SEEN" == "true" && "$prev_mixed" == "true" ]]; then
    CLASSIFICATION="mixed data+validation failure"
  elif [[ "$CURRENT_RUN_POW1930000_SEEN" == "true" && "$prev_pow" == "true" ]]; then
    CLASSIFICATION="deterministic fork failure"
  elif [[ "$CONSECUTIVE_NO_PROGRESS_CYCLES" -ge 2 ]]; then
    CLASSIFICATION="stalled"
  else
    CLASSIFICATION="stalled"
  fi
}

derived_state_paths() {
  printf '%s\n' "$DATADIR/blocks/index" "$DATADIR/chainstate" "$DATADIR/indexes"
}

capture_restart_args() {
  RESTART_ARGS=()
  if [[ -n "$CMDLINE" ]]; then
    # The daemon command line on this host is simple and space-delimited.
    read -r -a RESTART_ARGS <<<"$CMDLINE"
  fi
  if [[ "${#RESTART_ARGS[@]}" -eq 0 ]]; then
    RESTART_ARGS=("$DAEMON_BIN" "-daemon" "-reindex")
  fi
  local has_reindex=0
  local arg
  for arg in "${RESTART_ARGS[@]}"; do
    if [[ "$arg" == "-reindex" ]]; then
      has_reindex=1
      break
    fi
  done
  if [[ "$has_reindex" -eq 0 ]]; then
    RESTART_ARGS+=("-reindex")
  fi
}

stop_daemon() {
  if [[ "$PROCESS_RUNNING" != "true" || -z "$PID" || -n "$FIXTURE_DIR" ]]; then
    return 0
  fi
  "$RPC_CLI" stop >/dev/null 2>&1 || true
  local waited=0
  while kill -0 "$PID" >/dev/null 2>&1; do
    if [[ "$waited" -ge 30 ]]; then
      kill -TERM "$PID" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  waited=0
  while kill -0 "$PID" >/dev/null 2>&1; do
    if [[ "$waited" -ge 30 ]]; then
      fail "PEPEPOWd did not exit after TERM"
    fi
    sleep 1
    waited=$((waited + 1))
  done
  record_change "Stopped PEPEPOWd PID $PID"
}

restart_daemon() {
  capture_restart_args
  if [[ -n "$FIXTURE_DIR" ]]; then
    record_change "Would restart PEPEPOWd with: ${RESTART_ARGS[*]}"
    return 0
  fi
  "${RESTART_ARGS[@]}" >/dev/null 2>&1
  record_change "Restarted PEPEPOWd with: ${RESTART_ARGS[*]}"
}

backup_into() {
  local source_path="$1"
  local destination_dir="$2"
  mkdir -p "$destination_dir"
  if [[ -n "$FIXTURE_DIR" ]]; then
    record_change "Would back up $source_path into $destination_dir"
    return 0
  fi
  cp -a "$source_path" "$destination_dir/"
  record_change "Backed up $source_path into $destination_dir"
}

rename_into() {
  local source_path="$1"
  local destination_dir="$2"
  if [[ ! -e "$source_path" ]]; then
    return 0
  fi
  mkdir -p "$destination_dir"
  if [[ -n "$FIXTURE_DIR" ]]; then
    record_change "Would move $source_path into $destination_dir"
    return 0
  fi
  mv "$source_path" "$destination_dir/"
  record_change "Moved $source_path into $destination_dir"
}

maybe_apply_binary_swap() {
  local stamp="$1"
  if [[ "$APPLY_SAFE_FIXES" -ne 1 || "$ALLOW_BINARY_SWAP" -ne 1 ]]; then
    return 1
  fi
  if [[ "$BINARY_MISMATCH_PROVEN" != "true" ]]; then
    return 1
  fi
  if [[ -z "$REPLACEMENT_DAEMON_BIN" || -z "$REPLACEMENT_CLI_BIN" ]]; then
    return 1
  fi

  local backup_dir="$DATADIR/backups/reindex-monitor/binaries/$stamp"
  local derived_dir="$DATADIR/backups/reindex-monitor/derived-state/$stamp"
  stop_daemon
  backup_into "$DAEMON_BIN" "$backup_dir"
  backup_into "$RPC_CLI" "$backup_dir"
  if [[ -n "$FIXTURE_DIR" ]]; then
    record_change "Would replace $DAEMON_BIN from $REPLACEMENT_DAEMON_BIN"
    record_change "Would replace $RPC_CLI from $REPLACEMENT_CLI_BIN"
  else
    install -m 0755 "$REPLACEMENT_DAEMON_BIN" "$DAEMON_BIN"
    install -m 0755 "$REPLACEMENT_CLI_BIN" "$RPC_CLI"
    record_change "Replaced PEPEPOWd binary from $REPLACEMENT_DAEMON_BIN"
    record_change "Replaced PEPEPOW-cli binary from $REPLACEMENT_CLI_BIN"
  fi
  while IFS= read -r path; do
    rename_into "$path" "$derived_dir"
  done < <(derived_state_paths)
  restart_daemon
  return 0
}

maybe_apply_targeted_blk_replace() {
  local stamp="$1"
  if [[ "$APPLY_SAFE_FIXES" -ne 1 || "$ALLOW_TARGETED_BLK_REPLACE" -ne 1 ]]; then
    return 1
  fi
  if [[ "$BINARY_MATCH_PROVEN" != "true" ]]; then
    return 1
  fi
  if [[ -z "$LAST_ERROR_BLK_FILE" || -z "$DONOR_BLOCKS_DIR" ]]; then
    return 1
  fi
  local source_blk="$DONOR_BLOCKS_DIR/$LAST_ERROR_BLK_FILE"
  local source_rev="$DONOR_BLOCKS_DIR/$TARGET_REV_FILE"
  if [[ ! -f "$source_blk" || ! -f "$source_rev" ]]; then
    return 1
  fi

  local backup_dir="$DATADIR/backups/reindex-monitor/block-pairs/$stamp"
  local derived_dir="$DATADIR/backups/reindex-monitor/derived-state/$stamp"
  stop_daemon
  backup_into "$DATADIR/blocks/$LAST_ERROR_BLK_FILE" "$backup_dir"
  backup_into "$DATADIR/blocks/$TARGET_REV_FILE" "$backup_dir"
  if [[ -n "$FIXTURE_DIR" ]]; then
    record_change "Would replace $DATADIR/blocks/$LAST_ERROR_BLK_FILE from $source_blk"
    record_change "Would replace $DATADIR/blocks/$TARGET_REV_FILE from $source_rev"
  else
    install -m 0600 "$source_blk" "$DATADIR/blocks/$LAST_ERROR_BLK_FILE"
    install -m 0600 "$source_rev" "$DATADIR/blocks/$TARGET_REV_FILE"
    record_change "Replaced $LAST_ERROR_BLK_FILE from donor directory"
    record_change "Replaced $TARGET_REV_FILE from donor directory"
  fi
  while IFS= read -r path; do
    rename_into "$path" "$derived_dir"
  done < <(derived_state_paths)
  restart_daemon
  return 0
}

maybe_apply_derived_state_reset() {
  local stamp="$1"
  if [[ "$APPLY_SAFE_FIXES" -ne 1 || "$ALLOW_DERIVED_STATE_RESET" -ne 1 ]]; then
    return 1
  fi
  local derived_dir="$DATADIR/backups/reindex-monitor/derived-state/$stamp"
  stop_daemon
  while IFS= read -r path; do
    rename_into "$path" "$derived_dir"
  done < <(derived_state_paths)
  restart_daemon
  return 0
}

set_recommendations() {
  RECOMMENDATION_LINES=()
  local remediation_applied="false"
  local stamp="$1"

  case "$CLASSIFICATION" in
    progressing|"slow but progressing")
      add_recommendation "continue monitoring"
      ;;
    "deterministic fork failure")
      if [[ "$BINARY_REFERENCE_AVAILABLE" != "true" ]]; then
        add_recommendation "stop monitoring loop and obtain a local official checksum or artifact before any binary swap"
        add_recommendation "current hashes: PEPEPOWd=$DAEMON_SHA256 PEPEPOW-cli=$CLI_SHA256"
      elif [[ "$BINARY_MISMATCH_PROVEN" == "true" ]]; then
        if maybe_apply_binary_swap "$stamp"; then
          remediation_applied="true"
          add_recommendation "applied minimal safe remediation: swapped verified binaries, reset derived state, restarted PEPEPOWd with -reindex"
        else
          add_recommendation "stop monitoring loop and replace only /home/ubuntu/PEPEPOWd and /home/ubuntu/PEPEPOW-cli from the verified local release artifact, then remove only derived state and restart -reindex"
        fi
      else
        add_recommendation "stop monitoring loop and continue diagnosis: binary matches the supplied reference, so focus on block data near the fork boundary"
      fi
      ;;
    "mixed data+validation failure")
      if [[ "$BINARY_REFERENCE_AVAILABLE" != "true" ]]; then
        add_recommendation "stop monitoring loop and obtain a local official checksum or artifact before attempting remediation"
        add_recommendation "current hashes: PEPEPOWd=$DAEMON_SHA256 PEPEPOW-cli=$CLI_SHA256"
      elif [[ "$BINARY_MISMATCH_PROVEN" == "true" ]]; then
        if maybe_apply_binary_swap "$stamp"; then
          remediation_applied="true"
          add_recommendation "applied binary replacement and derived-state reset because the running binaries do not match the supplied reference"
        else
          add_recommendation "stop monitoring loop and replace the PEPEPOWd and PEPEPOW-cli binaries from the verified local release artifact"
        fi
      elif [[ -n "$LAST_ERROR_BLK_FILE" && -n "$TARGET_REV_FILE" ]]; then
        if maybe_apply_targeted_blk_replace "$stamp"; then
          remediation_applied="true"
          add_recommendation "applied targeted blk/rev replacement, removed derived state, and restarted PEPEPOWd with -reindex"
        else
          add_recommendation "stop monitoring loop and replace only $LAST_ERROR_BLK_FILE and $TARGET_REV_FILE from a known-good node, then remove derived state and rerun -reindex"
        fi
      else
        add_recommendation "stop monitoring loop and capture the exact blk/rev pair being processed when the deserialize error occurs"
      fi
      ;;
    crashed)
      if [[ "$LAST_ERROR_LINE" == *"Error opening block database"* ]]; then
        if maybe_apply_derived_state_reset "$stamp"; then
          remediation_applied="true"
          add_recommendation "applied derived-state reset and restarted PEPEPOWd with -reindex"
        else
          add_recommendation "stop monitoring loop and remove only derived state directories before restarting PEPEPOWd with -reindex"
        fi
      else
        add_recommendation "stop monitoring loop and review the last 200 log lines plus process exit evidence before any write action"
      fi
      ;;
    stalled)
      add_recommendation "stop monitoring loop and inspect the current block file plus fresh logs before any write action"
      ;;
    *)
      add_recommendation "continue monitoring"
      ;;
  esac

  REMEDIATION_APPLIED="$remediation_applied"
}

write_state_and_reports() {
  local utc_stamp="$1"
  local report_name="${utc_stamp//[: ]/-}"
  local text_report json_report
  local state_tsv
  text_report="$(sample_path "${report_name}.txt")"
  json_report="$(sample_path "${report_name}.json")"

  {
    printf '## Timestamp\n'
    printf '%s\n' "$TIMESTAMP_UTC"
    printf '%s\n' "$TIMESTAMP_LOCAL"
    printf '\n## Status\n'
    printf -- '- Running: %s\n' "$(bool_to_yes_no "$PROCESS_RUNNING")"
    printf -- '- PID: %s\n' "${PID:-}"
    printf -- '- Current height: %s\n' "${BLOCKS:-unknown}"
    printf -- '- Reindex active: %s\n' "$(bool_to_yes_no "$REINDEX_ACTIVE")"
    printf -- '- Progress since last check: %s\n' "$(bool_to_yes_no "$PROGRESS_SINCE_LAST_CHECK")"
    if [[ -n "$PROCESS_RUNTIME" || -n "$PROCESS_CPU" || -n "$PROCESS_MEM" ]]; then
      printf -- '- Runtime/CPU/Mem: %ss / %s%% / %s%%\n' "${PROCESS_RUNTIME:-unknown}" "${PROCESS_CPU:-unknown}" "${PROCESS_MEM:-unknown}"
    fi

    printf '\n## Fresh Evidence\n'
    if [[ -n "$LAST_REINDEX_LINE" ]]; then
      printf -- '- %s\n' "$LAST_REINDEX_LINE"
    else
      printf -- '- No current-run reindex line found\n'
    fi
    if [[ -n "$LAST_LOADED_BLOCKS_LINE" ]]; then
      printf -- '- %s\n' "$LAST_LOADED_BLOCKS_LINE"
    fi
    if [[ -n "$LAST_ERROR_LINE" ]]; then
      printf -- '- %s\n' "$LAST_ERROR_LINE"
    else
      printf -- '- No current-run validation or deserialize error line found\n'
    fi
    printf -- '- current blk file: %s\n' "${CURRENT_BLK_FILE:-unknown}"
    printf -- '- peer status: connections=%s peer_count=%s protocol_versions=%s peer_height_max=%s peers_ahead=%s\n' "${NETWORK_CONNECTIONS:-unknown}" "${PEER_COUNT:-0}" "${PEER_VERSIONS:-unknown}" "${PEER_HEIGHT_MAX:-unknown}" "$(bool_to_yes_no "$PEERS_AHEAD")"

    printf '\n## Assessment\n'
    printf -- '- %s\n' "$CLASSIFICATION"

    printf '\n## Recommended Action\n'
    local line
    for line in "${RECOMMENDATION_LINES[@]}"; do
      printf -- '- %s\n' "$line"
    done

    printf '\n## What You Changed\n'
    if [[ "${#CHANGES_MADE[@]}" -eq 0 ]]; then
      printf -- '- Read-only diagnostics only\n'
    else
      for line in "${CHANGES_MADE[@]}"; do
        printf -- '- %s\n' "$line"
      done
    fi

    printf '\n## Next Check\n'
    if [[ "$CLASSIFICATION" == "progressing" || "$CLASSIFICATION" == "slow but progressing" || "$REMEDIATION_APPLIED" == "true" ]]; then
      printf -- '- %s minutes from now\n' "$((INTERVAL_SECONDS / 60))"
      printf -- '- unless a failure condition requires immediate action\n'
    else
      printf -- '- monitoring loop stops here pending diagnosis or approved remediation\n'
    fi
  } | tee "$text_report"

  state_tsv="$({
    printf 'last_sample_utc\tstr\t%s\n' "$utc_stamp"
    printf 'pid\tstr\t%s\n' "${PID:-}"
    printf 'pid_start_utc\tstr\t%s\n' "${PID_START_UTC:-}"
    printf 'cmdline\tstr\t%s\n' "${CMDLINE:-}"
    printf 'blocks\t%s\t%s\n' "$( [[ "${BLOCKS:-}" =~ ^-?[0-9]+$ ]] && printf 'num' || printf 'str' )" "${BLOCKS:-}"
    printf 'headers\t%s\t%s\n' "$( [[ "${HEADERS:-}" =~ ^-?[0-9]+$ ]] && printf 'num' || printf 'str' )" "${HEADERS:-}"
    printf 'bestblockhash\tstr\t%s\n' "${BESTBLOCKHASH:-}"
    printf 'current_blk_file\tstr\t%s\n' "${CURRENT_BLK_FILE:-}"
    printf 'last_reindex_line\tstr\t%s\n' "${LAST_REINDEX_LINE:-}"
    printf 'last_loaded_blocks_line\tstr\t%s\n' "${LAST_LOADED_BLOCKS_LINE:-}"
    printf 'last_error_signature\tstr\t%s\n' "${LAST_ERROR_SIGNATURE:-}"
    printf 'last_error_blk_file\tstr\t%s\n' "${LAST_ERROR_BLK_FILE:-}"
    printf 'peer_count\tnum\t%s\n' "${PEER_COUNT:-0}"
    printf 'peer_height_max\tstr\t%s\n' "${PEER_HEIGHT_MAX:-}"
    printf 'classification\tstr\t%s\n' "$CLASSIFICATION"
    printf 'consecutive_no_progress_cycles\tnum\t%s\n' "$CONSECUTIVE_NO_PROGRESS_CYCLES"
    printf 'current_run_mixed_error_seen\tbool\t%s\n' "$CURRENT_RUN_MIXED_ERROR_SEEN"
    printf 'current_run_pow1930000_seen\tbool\t%s\n' "$CURRENT_RUN_POW1930000_SEEN"
    printf 'progress_since_last_check\tbool\t%s\n' "$PROGRESS_SINCE_LAST_CHECK"
    printf 'progress_reason\tstr\t%s\n' "$PROGRESS_REASON"
    printf 'running\tbool\t%s\n' "$PROCESS_RUNNING"
    printf 'reindex_active\tbool\t%s\n' "$REINDEX_ACTIVE"
    printf 'daemon_sha256\tstr\t%s\n' "${DAEMON_SHA256:-}"
    printf 'cli_sha256\tstr\t%s\n' "${CLI_SHA256:-}"
    printf 'binary_reference_available\tbool\t%s\n' "$BINARY_REFERENCE_AVAILABLE"
    printf 'binary_reference_source\tstr\t%s\n' "$BINARY_REFERENCE_SOURCE"
    printf 'binary_match_proven\tbool\t%s\n' "$BINARY_MATCH_PROVEN"
    printf 'binary_mismatch_proven\tbool\t%s\n' "$BINARY_MISMATCH_PROVEN"
    printf 'peer_versions\tstr\t%s\n' "${PEER_VERSIONS:-}"
    printf 'peers_ahead\tbool\t%s\n' "$PEERS_AHEAD"
    printf 'active_binary_path\tstr\t%s\n' "${ACTIVE_BINARY_PATH:-}"
    printf 'recommendation_summary\tstr\t%s\n' "$(printf '%s | ' "${RECOMMENDATION_LINES[@]}" | sed 's/ | $//')"
    printf 'changes_made\tstr\t%s\n' "$(printf '%s | ' "${CHANGES_MADE[@]}" | sed 's/ | $//')"
  })"

  printf '%s\n' "$state_tsv" | write_json_file "$STATE_FILE"
  printf '%s\n' "$state_tsv" | write_json_file "$json_report"
}

run_cycle() {
  CHANGES_MADE=()
  RECOMMENDATION_LINES=()

  TIMESTAMP_UTC="$(current_utc)"
  TIMESTAMP_LOCAL="$(current_local)"
  SAMPLE_UTC_NOZONE="${TIMESTAMP_UTC% UTC}"

  collect_process_info
  collect_chain_info
  filter_current_run_log
  parse_log_signals
  collect_lsof_blk_file
  collect_peer_info
  collect_binary_info
  evaluate_binary_integrity
  collect_block_data_clues
  collect_environment_info
  classify_state
  set_recommendations "${SAMPLE_UTC_NOZONE//[: ]/-}"
  write_state_and_reports "$SAMPLE_UTC_NOZONE"
}

should_continue_loop() {
  if [[ "$REMEDIATION_APPLIED" == "true" ]]; then
    return 0
  fi
  case "$CLASSIFICATION" in
    progressing|"slow but progressing")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

main() {
  parse_args "$@"
  ensure_parent_dirs

  while true; do
    run_cycle
    if [[ "$ONCE" -eq 1 ]]; then
      break
    fi
    if ! should_continue_loop; then
      break
    fi
    sleep "$INTERVAL_SECONDS"
  done
}

main "$@"
