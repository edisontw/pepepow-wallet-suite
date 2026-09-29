#!/usr/bin/env bash
set -euo pipefail

# No-Docker v4.2 doctor for PEPEPOW Wallet Suite
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CODE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CODE_ROOT="${CODE_ROOT:-$DEFAULT_CODE_ROOT}"
ENV_FILE="${ENV_FILE:-/etc/pepepow/pepepow-wallet-api.env}"
PEPEW_ENV_FILE="${PEPEW_ENV_FILE:-/etc/pepepow/pepew-api.env}"

build_issues=()
deploy_issues=()
runtime_issues=()
config_issues=()

section() {
  printf "\n=== %s ===\n" "$1"
}

add_issue() {
  local bucket="$1"; shift
  local msg="$*"
  case "$bucket" in
    build)   build_issues+=("$msg") ;;
    deploy)  deploy_issues+=("$msg") ;;
    runtime) runtime_issues+=("$msg") ;;
    config)  config_issues+=("$msg") ;;
    *) echo "Unknown issue bucket: $bucket" ;;
  esac
}

print_issues() {
  local title="$1" ; shift
  local -n arr="$1"
  if [[ "${#arr[@]}" -eq 0 ]]; then
    printf -- "- %s: none\n" "$title"
  else
    printf -- "- %s: %s\n" "$title" "${#arr[@]}"
    for item in "${arr[@]}"; do
      printf "  - %s\n" "$item"
    done
  fi
}

collect_keys_from_example() {
  local file="$1"
  [[ -f "$file" ]] || return
  grep -E '^[A-Za-z0-9_]+\s*=' "$file" | sed 's/[[:space:]]*#.*$//' | cut -d'=' -f1 | sed '/^$/d' | sort -u
}

check_cmd() {
  local cmd="$1" desc="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf "%s: %s\n" "$desc" "$("$cmd" --version 2>/dev/null | head -n1 || true)"
  else
    add_issue build "$desc missing ($cmd)"
    printf "%s: missing\n" "$desc"
  fi
}

check_node_version() {
  local min_major=18
  if command -v node >/dev/null 2>&1; then
    local ver
    ver="$(node -v 2>/dev/null || true)"
    printf "Node.js: %s\n" "$ver"
    local major="${ver#v}"
    major="${major%%.*}"
    if [[ -n "$major" && "$major" -lt "$min_major" ]]; then
      add_issue build "Node.js >=${min_major} required (found ${ver})"
    fi
  else
    add_issue build "Node.js missing"
    echo "Node.js: missing"
  fi
}

check_port() {
  local port="$1" name="$2"
  [[ -z "$port" ]] && { echo "  port: not set"; return; }

  local listener=""
  if command -v ss >/dev/null 2>&1; then
    listener="$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $6}' | head -n1)"
  elif command -v lsof >/dev/null 2>&1; then
    listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1 "/" $2}')"
  fi

  if [[ -n "$listener" ]]; then
    echo "  port $port: listening ($listener)"
  else
    echo "  port $port: not listening"
    add_issue runtime "${name} is not listening on expected port $port"
  fi
}

check_systemd_unit() {
  local unit_file="$1" name="$2"
  [[ -z "$unit_file" ]] && return
  if [[ ! -f "$unit_file" ]]; then
    add_issue deploy "systemd unit missing for ${name} (${unit_file})"
    echo "  systemd: missing (${unit_file})"
    return
  fi

  local unit_name
  unit_name="$(basename "$unit_file")"
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$unit_name"; then
      echo "  systemd: active (${unit_name})"
    else
      echo "  systemd: inactive (${unit_name})"
      add_issue runtime "${name} service not active (${unit_name})"
    fi
    if systemctl is-enabled --quiet "$unit_name"; then
      echo "  systemd: enabled"
    else
      echo "  systemd: disabled"
      add_issue deploy "${name} service not enabled (${unit_name})"
    fi
  else
    echo "  systemd: unit present (${unit_name}), but systemctl unavailable"
  fi
}

collect_env_map() {
  local file="$1"
  declare -A env_map=()
  if [[ -f "$file" ]]; then
    while IFS='=' read -r key value; do
      [[ -z "$key" || "${key:0:1}" == "#" ]] && continue
      key="$(echo "$key" | xargs)"
      value="${value%%$'\r'}"
      env_map["$key"]="$value"
    done <"$file"
  fi

  for k in "${!env_map[@]}"; do
    printf "%s=%s\n" "$k" "${env_map[$k]}"
  done
}

section "Context"
echo "CODE_ROOT    : ${CODE_ROOT}"
echo "ENV_FILE     : ${ENV_FILE}"
echo "Run at       : $(date -Iseconds)"

section "Host"
if command -v lsb_release >/dev/null 2>&1; then
  echo "OS           : $(lsb_release -ds)"
elif [[ -f /etc/os-release ]]; then
  os_name="$(source /etc/os-release && echo "$PRETTY_NAME")"
  echo "OS           : ${os_name}"
fi
echo "Kernel       : $(uname -sr)"
echo "CPU          : $(nproc) cores"
if command -v lscpu >/dev/null 2>&1; then lscpu | head -n5; fi
if command -v free >/dev/null 2>&1; then free -h; fi
if command -v df >/dev/null 2>&1; then df -h /; fi
echo "ulimit -n    : $(ulimit -n || true)"
if command -v timedatectl >/dev/null 2>&1; then
  echo "Timezone     : $(timedatectl show -p Timezone --value)"
else
  echo "Timezone     : $(date +%Z)"
fi

section "Toolchain"
check_node_version
check_cmd npm "npm"
check_cmd python3 "python3"
check_cmd g++ "g++"
check_cmd make "make"
check_cmd openssl "openssl"
check_cmd curl "curl"

section "Source checkout"
echo "CODE_ROOT: $CODE_ROOT"
if [[ ! -d "$CODE_ROOT" ]]; then
  add_issue deploy "Source checkout missing at ${CODE_ROOT}"
elif [[ ! -d "$CODE_ROOT/.git" ]]; then
  add_issue deploy "Source checkout is not a Git worktree (${CODE_ROOT})"
else
  echo "- git SHA: $(git -C "$CODE_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [[ -n "$(git -C "$CODE_ROOT" status --short 2>/dev/null || true)" ]]; then
    echo "- working tree: modified"
  else
    echo "- working tree: clean"
  fi
fi

section "Services"
services=(
  "wallet-api|${CODE_ROOT}/services/wallet-api|${ENV_FILE}|/etc/systemd/system/pepepow-wallet-api.service|9194|required"
  "pepew-api|${CODE_ROOT}/pepew-api/pepew-api|${PEPEW_ENV_FILE}||9193|optional"
)

for svc in "${services[@]}"; do
  IFS='|' read -r name path env_path unit_file default_port required <<< "$svc"
  echo "- ${name}"
  if [[ ! -d "$path" ]]; then
    add_issue deploy "${name} directory missing (${path})"
    echo "  path: missing (${path})"
    continue
  else
    echo "  path: ${path}"
  fi

  declare -A env_map=()
  while IFS='=' read -r k v; do
    [[ -z "$k" ]] && continue
    env_map["$k"]="$v"
  done < <(collect_env_map "$env_path")

  if [[ "$required" == "required" && ! -f "$env_path" ]]; then
    add_issue config "${name} env file missing (${env_path})"
  fi

  svc_port="$default_port"
  if [[ -n "${env_map[PORT]:-}" ]]; then
    svc_port="${env_map[PORT]}"
  fi
  check_port "$svc_port" "$name"
  check_systemd_unit "$unit_file" "$name"

  case "$name" in
    wallet-api)
      if [[ ! -f "${path}/dist/server.js" ]]; then
        add_issue build "wallet-api build output missing (${path}/dist/server.js)"
      fi
      ;;
    pepew-api)
      if [[ -d "$path" && -f "${path}/src/index.ts" && ! -f "${path}/dist/index.js" ]]; then
        add_issue build "pepew-api build output missing (${path}/dist/index.js)"
      fi
      ;;
  esac
done

if [[ ! -f "${CODE_ROOT}/packages/wallet-core/dist/index.js" ]]; then
  add_issue build "wallet-core build output missing (${CODE_ROOT}/packages/wallet-core/dist/index.js)"
fi
if [[ ! -f "${CODE_ROOT}/apps/web/dist/index.html" ]]; then
  add_issue build "web build output missing (${CODE_ROOT}/apps/web/dist/index.html)"
fi

section ".env validation"
expected_root_keys=(PORT PEPEW_LIGHT_API_BASE JWT_SECRET CORS_ORIGINS WALLET_BASE_URL)
declare -A root_env=()
while IFS='=' read -r k v; do
  [[ -z "$k" ]] && continue
  root_env["$k"]="$v"
done < <(collect_env_map "$ENV_FILE")

if [[ ! -f "$ENV_FILE" ]]; then
  add_issue config ".env missing at ${ENV_FILE}"
else
  missing_root=()
  for key in "${expected_root_keys[@]}"; do
    if [[ -z "${root_env[$key]:-}" ]]; then
      missing_root+=("$key")
    fi
  done
  if [[ "${#missing_root[@]}" -gt 0 ]]; then
    add_issue config "Missing keys in ${ENV_FILE}: ${missing_root[*]}"
  fi
fi

section "Node dependency sanity"
export NODE_PATH="${CODE_ROOT}/node_modules:${CODE_ROOT}/services/wallet-api/node_modules:${CODE_ROOT}/apps/web/node_modules:${CODE_ROOT}/packages/wallet-core/node_modules:${CODE_ROOT}/pepew-api/pepew-api/node_modules"
if command -v node >/dev/null 2>&1; then
  if node --input-type=module - <<'NODE'
const mods = ['express','node-fetch','jsonwebtoken','grammy','bitcoinjs-lib','bip39','bs58check'];
Promise.all(mods.map(m => import(m)))
  .then(() => { console.log('module imports ok'); })
  .catch(err => { console.error(err); process.exit(1); });
NODE
  then
    echo "Imports: ok"
  else
    add_issue build "Node module import failed (see above)"
  fi
else
  echo "Node unavailable, skipping module imports"
fi

section "Connectivity checks"
light_base="${root_env[PEPEW_LIGHT_API_BASE]:-https://light.pepepow.net}"
light_base="${light_base%/}"
if command -v curl >/dev/null 2>&1; then
  echo "PEPEW Light API: ${light_base}/api/status"
  if curl -fsS --max-time 8 "${light_base}/api/status" >/tmp/pepew_light_status.json 2>/dev/null; then
    if (command -v jq >/dev/null 2>&1 && jq -e '.ok == true' /tmp/pepew_light_status.json >/dev/null 2>&1) || grep -q '"ok"[[:space:]]*:[[:space:]]*true' /tmp/pepew_light_status.json; then
      echo "  Light API status ok"
    else
      echo "  Light API status not ok"
      add_issue runtime "PEPEW Light API /api/status did not report ok=true"
    fi
  else
    echo "  Light API unreachable"
    add_issue runtime "PEPEW Light API unreachable (${light_base})"
  fi
fi

redis_url=""
if [[ -f "${PEPEW_ENV_FILE}" ]]; then
  redis_url="$(grep -E '^REDIS_URL=' "${PEPEW_ENV_FILE}" | tail -n1 | cut -d'=' -f2-)"
fi
if [[ -n "$redis_url" ]]; then
  echo "REDIS_URL set (masked)"
  if command -v redis-cli >/dev/null 2>&1; then
    if redis-cli -u "$redis_url" PING >/dev/null 2>&1; then
      echo "  redis ping ok"
    else
      echo "  redis ping failed"
      add_issue runtime "Redis not reachable (${redis_url})"
    fi
  else
    add_issue deploy "redis-cli not installed (REDIS_URL is set)"
  fi
fi

bot_token="${root_env[BOT_TOKEN]:-}"
if [[ -n "$bot_token" ]] && command -v curl >/dev/null 2>&1; then
  echo "Telegram bot: token present (masked)"
  if curl -s --max-time 5 -H "X-Telegram-Bot-Api-Secret-Token: ${root_env[BOT_SECRET_TOKEN]:-}" "https://api.telegram.org/bot${bot_token}/getMe" >/tmp/tg_getme.json 2>/dev/null; then
    if grep -q '"ok":true' /tmp/tg_getme.json; then
      echo "  telegram getMe ok"
    else
      echo "  telegram getMe failed"
      add_issue runtime "Telegram getMe failed (check BOT_TOKEN/BOT_SECRET_TOKEN/network)"
    fi
  fi
fi

section "Summary"
print_issues "Build-time" build_issues
print_issues "Deploy-time" deploy_issues
print_issues "Runtime" runtime_issues
print_issues "Config" config_issues

exit_code=0
if [[ "${#config_issues[@]}" -gt 0 ]]; then
  exit_code=40
elif [[ "${#build_issues[@]}" -gt 0 ]]; then
  exit_code=10
elif [[ "${#deploy_issues[@]}" -gt 0 ]]; then
  exit_code=20
elif [[ "${#runtime_issues[@]}" -gt 0 ]]; then
  exit_code=30
fi

echo "Exit code: ${exit_code} (0 ok, 10 build, 20 deploy, 30 runtime, 40 config)"

if [[ "$exit_code" -ne 0 ]]; then
  echo "Next actions:"
  [[ "${#build_issues[@]}" -gt 0 ]] && echo "  - Rebuild missing artifacts or reinstall dependencies."
  [[ "${#deploy_issues[@]}" -gt 0 ]] && echo "  - Fix the Git checkout path, service files, or systemd enablement."
  [[ "${#runtime_issues[@]}" -gt 0 ]] && echo "  - Resolve port conflicts and connectivity to external services."
  [[ "${#config_issues[@]}" -gt 0 ]] && echo "  - Populate missing .env keys."
else
  echo "Next actions: none, environment looks healthy."
fi

exit "$exit_code"
