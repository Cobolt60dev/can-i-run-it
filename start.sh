#!/usr/bin/env sh
# Can I Run It? — Linux / macOS launcher (runs from source; needs Node.js 20+)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required to run from source: https://nodejs.org"
  echo "Or download the standalone build for your system from the GitHub Releases page."
  exit 1
fi
exec node server.js --open
