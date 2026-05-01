#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AXL_DIR="${ROOT_DIR}/vendors/gensyn-axl"
AXL_REPO_URL="${AXL_REPO_URL:-https://github.com/gensyn-ai/axl.git}"

mkdir -p "${ROOT_DIR}/vendors"

if [ ! -d "${AXL_DIR}/.git" ]; then
  echo "[pull-axl] cloning ${AXL_REPO_URL} -> ${AXL_DIR}"
  git clone "${AXL_REPO_URL}" "${AXL_DIR}"
else
  echo "[pull-axl] updating ${AXL_DIR}"
  git -C "${AXL_DIR}" fetch --all --prune
  git -C "${AXL_DIR}" pull --ff-only
fi

if [ -f "${AXL_DIR}/Makefile" ]; then
  echo "[pull-axl] building AXL binary"
  make -C "${AXL_DIR}" build
fi

echo "[pull-axl] done"
