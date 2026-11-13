#!/bin/sh
set -e
dir="$(cd "$(dirname "$0")" && pwd)"
WRANGLER="${WRANGLER:-/Users/gamer/gmitch215/drupflare/dashboard/node_modules/.bin/wrangler}"
"$WRANGLER" delete spike-memory-boundary --config "$dir/wrangler.jsonc"
