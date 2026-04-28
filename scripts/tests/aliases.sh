#!/usr/bin/env bash
# Source this file to install shell aliases for project test scripts:
#   source scripts/tests/aliases.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
RUN="NODE_OPTIONS=--conditions=require tsx"

alias swap-buy-uni="$RUN \"$ROOT/scripts/tests/swap-buy-uni.ts\""
alias swap-sell-uni="$RUN \"$ROOT/scripts/tests/swap-sell-uni.ts\""
alias llm-probe="$RUN \"$ROOT/scripts/tests/zerog-llm-probe.ts\""
alias llm-probe-streaming="$RUN \"$ROOT/scripts/tests/zerog-llm-probe-streaming.ts\""

cat <<EOF
Project test-script aliases available in this shell:

  swap-buy-uni           0.5 USDC -> UNI on Unichain (real swap, opens Position)
  swap-sell-uni          0.1 UNI  -> USDC on Unichain (closes most-recent UNI Position)
  llm-probe              One trivial inference via configured 0G provider
  llm-probe-streaming    Streaming inference via configured 0G provider

To install permanently, add this line to your ~/.zshrc or ~/.bashrc:
  source "$ROOT/scripts/tests/aliases.sh"
EOF
