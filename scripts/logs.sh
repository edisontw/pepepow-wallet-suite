#!/usr/bin/env bash
set -euo pipefail

journalctl -u pepew-api -u pepepow-wallet-api -f --no-pager "$@"
