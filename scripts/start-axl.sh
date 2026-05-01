#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AXL_DIR="${ROOT_DIR}/vendors/gensyn-axl"

if [ ! -d "${AXL_DIR}" ]; then
  echo "[start-axl] missing ${AXL_DIR}; run ./scripts/pull-axl.sh first"
  exit 1
fi

cd "${AXL_DIR}"

if [ -f Makefile ]; then
  echo "[start-axl] make build in ${AXL_DIR}"
  make build
fi

if [ ! -f private.pem ]; then
  echo "[start-axl] generating ed25519 key at private.pem"
  openssl genpkey -algorithm ed25519 -out private.pem
fi

echo "[start-axl] ./node -config node-config.json"
exec ./node -config node-config.json
