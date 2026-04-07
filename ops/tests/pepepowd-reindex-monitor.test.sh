#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MONITOR="${REPO_ROOT}/ops/pepepowd-reindex-monitor.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected to find %s in %s\n' "$expected" "$file" >&2
    return 1
  fi
}

run_monitor() {
  local fixture_dir="$1"
  local state_file="$2"
  local report_dir="$3"
  shift 3
  PEPEPOWD_MONITOR_FIXTURE_DIR="$fixture_dir" \
    "$MONITOR" --once --state-file "$state_file" --report-dir "$report_dir" "$@"
}

write_base_fixture() {
  local dir="$1"
  local pgrep_line="${2:-1234 ./PEPEPOWd -daemon -reindex}"
  local blocks="${3:-0}"
  local headers="${4:-1929999}"
  local debug_log="${5:-}"
  local lsof_blk="${6:-blk00030.dat}"
  local blockchain_best="${7:-00000a308cc3b469703a3bc1aa55bc251a71c9287d7b413242592c0ab0a31f13}"
  mkdir -p "$dir"

  cat >"$dir/pgrep.txt" <<EOF
$pgrep_line
EOF
  cat >"$dir/ps_fp.txt" <<'EOF'
UID          PID    PPID  C STIME TTY          TIME CMD
ubuntu      1234       1 90 00:27 ?        00:34:18 ./PEPEPOWd -daemon -reindex
EOF
  cat >"$dir/ps_stats.txt" <<'EOF'
    PID ELAPSED %CPU %MEM   RSS    VSZ STAT CMD
1234    2200 93.5 11.8 715328 1871440 SLsl ./PEPEPOWd -daemon -reindex
EOF
  cat >"$dir/pid_lstart.txt" <<'EOF'
Sat Apr  5 00:27:00 2026
EOF
  cat >"$dir/proc_exe.txt" <<'EOF'
/home/ubuntu/PEPEPOWd
EOF
  cat >"$dir/proc_cmdline.txt" <<'EOF'
./PEPEPOWd -daemon -reindex
EOF
  cat >"$dir/getblockcount.txt" <<EOF
$blocks
EOF
  cat >"$dir/getblockchaininfo.json" <<EOF
{
  "chain": "main",
  "blocks": $blocks,
  "headers": $headers,
  "bestblockhash": "$blockchain_best"
}
EOF
  cat >"$dir/getnetworkinfo.json" <<'EOF'
{
  "connections": 8,
  "subversion": "/PEPEPOW Core:2.9.0.2/"
}
EOF
  cat >"$dir/getpeerinfo.json" <<'EOF'
[
  {"version":70521,"startingheight":4324964},
  {"version":70521,"startingheight":4325027}
]
EOF
  cat >"$dir/lsof.txt" <<EOF
PEPEPOWd 1234 ubuntu   28u      REG      8,1 134217693   263016 /home/ubuntu/.PEPEPOWcore/blocks/$lsof_blk
EOF
  cat >"$dir/sha256sum.txt" <<'EOF'
ced27b495478c1f6c4df38d0763a05bb5eb922ce7abc570fc00a662f5dbb333e  /home/ubuntu/PEPEPOWd
3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce  /home/ubuntu/PEPEPOW-cli
EOF
  cat >"$dir/stat_binaries.txt" <<'EOF'
  File: /home/ubuntu/PEPEPOWd
  Size: 11074624
  File: /home/ubuntu/PEPEPOW-cli
  Size: 3007520
EOF
  cat >"$dir/blocks_ls.txt" <<'EOF'
-rw------- 1 ubuntu ubuntu 128M May 23  2025 /home/ubuntu/.PEPEPOWcore/blocks/blk00027.dat
-rw------- 1 ubuntu ubuntu 128M May 26  2025 /home/ubuntu/.PEPEPOWcore/blocks/blk00028.dat
-rw-rw-r-- 1 ubuntu ubuntu 128M May 26  2025 /home/ubuntu/.PEPEPOWcore/blocks/blk00029.dat
-rw-rw-r-- 1 ubuntu ubuntu 128M May 26  2025 /home/ubuntu/.PEPEPOWcore/blocks/blk00030.dat
EOF
  cat >"$dir/blocks_stat.txt" <<'EOF'
/home/ubuntu/.PEPEPOWcore/blocks/blk00028.dat 134203994 2025-05-26 05:58:53.639960417 +0000 600
/home/ubuntu/.PEPEPOWcore/blocks/blk00029.dat 134217681 2025-05-26 13:49:12.692079831 +0000 664
/home/ubuntu/.PEPEPOWcore/blocks/rev00028.dat 24117248 2025-11-13 22:08:09.234764599 +0000 600
/home/ubuntu/.PEPEPOWcore/blocks/rev00029.dat 24117248 2025-11-14 02:23:56.494982907 +0000 664
EOF
  cat >"$dir/df.txt" <<'EOF'
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        45G   27G   18G  62% /
EOF
  cat >"$dir/free.txt" <<'EOF'
               total        used        free      shared  buff/cache   available
Mem:            5906        1863         135          14        4118        4042
Swap:           4095         237        3858
EOF
  cat >"$dir/dmesg_tail.txt" <<'EOF'
dmesg: read kernel buffer failed: Operation not permitted
EOF
  cat >"$dir/dmesg_grep.txt" <<'EOF'
dmesg: read kernel buffer failed: Operation not permitted
EOF
  cat >"$dir/date_utc.txt" <<'EOF'
2026-04-05 01:15:22 UTC
EOF
  cat >"$dir/date_local.txt" <<'EOF'
2026-04-05 01:15:22 UTC
EOF
  cat >"$dir/debug.log" <<EOF
$debug_log
EOF
}

test_progressing_blocks() {
  local case_dir="$TMP_ROOT/progressing"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture_a="$case_dir/a"
  local fixture_b="$case_dir/b"
  write_base_fixture "$fixture_a" "1234 ./PEPEPOWd -daemon -reindex" "100" "1930200" $'2026-04-05 00:30:00 Reindexing block file blk00030.dat...\n2026-04-05 00:31:00 UpdateTip: new best=abc height=100'
  write_base_fixture "$fixture_b" "1234 ./PEPEPOWd -daemon -reindex" "101" "1930201" $'2026-04-05 00:30:00 Reindexing block file blk00030.dat...\n2026-04-05 00:31:30 UpdateTip: new best=def height=101'

  run_monitor "$fixture_a" "$state_file" "$report_dir" >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture_b" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "- progressing"
  assert_contains "$output" "- Progress since last check: yes"
}

test_slow_progress_via_blk_advance() {
  local case_dir="$TMP_ROOT/slow-progress"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture_a="$case_dir/a"
  local fixture_b="$case_dir/b"
  write_base_fixture "$fixture_a" "1234 ./PEPEPOWd -daemon -reindex" "0" "1929999" $'2026-04-05 00:58:06 Reindexing block file blk00028.dat...' "blk00028.dat"
  write_base_fixture "$fixture_b" "1234 ./PEPEPOWd -daemon -reindex" "0" "1929999" $'2026-04-05 01:11:11 Reindexing block file blk00030.dat...' "blk00030.dat"

  run_monitor "$fixture_a" "$state_file" "$report_dir" >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture_b" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "- slow but progressing"
  assert_contains "$output" "current blk file: blk00030.dat"
}

test_two_cycle_stall() {
  local case_dir="$TMP_ROOT/stalled"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "0" "1929999" $'2026-04-05 01:11:11 Reindexing block file blk00030.dat...' "blk00030.dat"

  run_monitor "$fixture" "$state_file" "$report_dir" >/dev/null
  run_monitor "$fixture" "$state_file" "$report_dir" >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "- stalled"
  assert_contains "$output" "stop monitoring loop and inspect the current block file plus fresh logs before any write action"
}

test_deterministic_pow_failure() {
  local case_dir="$TMP_ROOT/pow"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "1929999" "1929999" $'2026-04-05 01:00:00 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000' "blk00030.dat"

  run_monitor "$fixture" "$state_file" "$report_dir" >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "- deterministic fork failure"
  assert_contains "$output" "obtain a local official checksum or artifact before any binary swap"
}

test_mixed_failure() {
  local case_dir="$TMP_ROOT/mixed"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "1929999" "1929999" $'2026-04-05 00:58:06 Reindexing block file blk00028.dat...\n2026-04-05 01:00:32 LoadExternalBlockFile: Deserialize or I/O error - Read attempted past buffer limit: iostream error\n2026-04-05 01:00:33 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000' "blk00028.dat"

  run_monitor "$fixture" "$state_file" "$report_dir" --expected-daemon-sha256 ced27b495478c1f6c4df38d0763a05bb5eb922ce7abc570fc00a662f5dbb333e --expected-cli-sha256 3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" --expected-daemon-sha256 ced27b495478c1f6c4df38d0763a05bb5eb922ce7abc570fc00a662f5dbb333e --expected-cli-sha256 3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce >"$output"
  assert_contains "$output" "- mixed data+validation failure"
  assert_contains "$output" "replace only blk00028.dat and rev00028.dat from a known-good node"
}

test_historical_pow_does_not_trigger_failure() {
  local case_dir="$TMP_ROOT/historical"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture_a="$case_dir/a"
  local fixture_b="$case_dir/b"
  write_base_fixture "$fixture_a" "1234 ./PEPEPOWd -daemon -reindex" "0" "1929999" $'2026-04-04 21:00:30 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000\n2026-04-05 00:58:06 Reindexing block file blk00028.dat...' "blk00028.dat"
  write_base_fixture "$fixture_b" "1234 ./PEPEPOWd -daemon -reindex" "0" "1929999" $'2026-04-04 21:00:30 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000\n2026-04-05 01:11:11 Reindexing block file blk00030.dat...' "blk00030.dat"

  run_monitor "$fixture_a" "$state_file" "$report_dir" >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture_b" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "- slow but progressing"
}

test_dmesg_permission_denied_is_nonfatal() {
  local case_dir="$TMP_ROOT/dmesg"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "0" "1929999" $'2026-04-05 01:11:11 Reindexing block file blk00030.dat...' "blk00030.dat"

  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "Read-only diagnostics only"
}

test_binary_mismatch_recommendation() {
  local case_dir="$TMP_ROOT/mismatch"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "1929999" "1929999" $'2026-04-05 01:00:00 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000' "blk00030.dat"

  run_monitor "$fixture" "$state_file" "$report_dir" --expected-daemon-sha256 deadbeef --expected-cli-sha256 3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" --expected-daemon-sha256 deadbeef --expected-cli-sha256 3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce >"$output"
  assert_contains "$output" "replace only /home/ubuntu/PEPEPOWd and /home/ubuntu/PEPEPOW-cli from the verified local release artifact"
}

test_no_reference_never_swaps_binary() {
  local case_dir="$TMP_ROOT/no-reference"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "1929999" "1929999" $'2026-04-05 01:00:00 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000' "blk00030.dat"

  run_monitor "$fixture" "$state_file" "$report_dir" >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" >"$output"
  assert_contains "$output" "current hashes: PEPEPOWd="
}

test_targeted_replace_without_donor_is_recommend_only() {
  local case_dir="$TMP_ROOT/no-donor"
  local state_file="$case_dir/state.json"
  local report_dir="$case_dir/reports"
  mkdir -p "$case_dir"

  local fixture="$case_dir/f"
  write_base_fixture "$fixture" "1234 ./PEPEPOWd -daemon -reindex" "1929999" "1929999" $'2026-04-05 00:58:06 Reindexing block file blk00028.dat...\n2026-04-05 01:00:32 LoadExternalBlockFile: Deserialize or I/O error - Read attempted past buffer limit: iostream error\n2026-04-05 01:00:33 ERROR: ContextualCheckBlockHeader : incorrect proof of work at 1930000' "blk00028.dat"

  run_monitor "$fixture" "$state_file" "$report_dir" --expected-daemon-sha256 ced27b495478c1f6c4df38d0763a05bb5eb922ce7abc570fc00a662f5dbb333e --expected-cli-sha256 3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce >/dev/null
  local output="$case_dir/output.txt"
  run_monitor "$fixture" "$state_file" "$report_dir" --expected-daemon-sha256 ced27b495478c1f6c4df38d0763a05bb5eb922ce7abc570fc00a662f5dbb333e --expected-cli-sha256 3abd35abef4a46ae86273e3c6b5059a2afb45cf2dc242825ce3c004aab6d41ce >"$output"
  assert_contains "$output" "replace only blk00028.dat and rev00028.dat from a known-good node"
}

main() {
  chmod +x "$MONITOR"
  test_progressing_blocks
  test_slow_progress_via_blk_advance
  test_two_cycle_stall
  test_deterministic_pow_failure
  test_mixed_failure
  test_historical_pow_does_not_trigger_failure
  test_dmesg_permission_denied_is_nonfatal
  test_binary_mismatch_recommendation
  test_no_reference_never_swaps_binary
  test_targeted_replace_without_donor_is_recommend_only
  printf 'All pepepowd reindex monitor tests passed.\n'
}

main "$@"
