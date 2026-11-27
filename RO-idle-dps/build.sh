#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source_root=ro-idle-client-src-df6277909
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
curl -fsSL "https://ro-idle.app/source/$source_root.tar.gz" -o "$build_dir/client.tar.gz"
tar -xzf "$build_dir/client.tar.gz" -C "$build_dir"
cp simulator.ts "$build_dir/$source_root/dps-entry.ts"
npx --yes esbuild@0.25.12 "$build_dir/$source_root/dps-entry.ts" \
  --bundle --minify --format=esm --platform=browser \
  --banner:js='/* RO-idle combat engine, GPL-3.0. Corresponding source and build instructions: README.md. */' \
  --outfile=engine.js
