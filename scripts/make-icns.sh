#!/usr/bin/env bash
# Keep all native representations and the catalog in sync.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/generate-macos-icons.sh
