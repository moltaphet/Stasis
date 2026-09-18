#!/usr/bin/env bash
# Pure-ASCII gate (constitution Principle I).
# Fails if any tracked-relevant source file contains a byte outside 0x00-0x7F.
# Scans contracts, tests, scripts, specs, apps/web source, and top-level docs.
# Excludes vendored/build/cache directories.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Directories and paths to scan.
SCAN_PATHS=(contracts tests scripts specs .specify/memory)
# Add apps/web sources if present, skipping node_modules and build output.
if [ -d apps/web ]; then
  SCAN_PATHS+=(apps/web)
fi
# Top-level docs if present.
for f in README.md; do
  [ -f "$f" ] && SCAN_PATHS+=("$f")
done

EXCLUDE_DIRS_REGEX='/(node_modules|\.next|dist|build|__pycache__|\.git|\.cache)/'

fail=0
found_file=""

while IFS= read -r file; do
  # Skip excluded directories.
  if printf '%s' "/$file" | grep -Eq "$EXCLUDE_DIRS_REGEX"; then
    continue
  fi
  # Detect any non-ASCII byte.
  if LC_ALL=C grep -qP '[^\x00-\x7F]' "$file" 2>/dev/null; then
    echo "NON-ASCII: $file"
    LC_ALL=C grep -nP '[^\x00-\x7F]' "$file" | head -5
    fail=1
    found_file="$file"
  fi
done < <(find "${SCAN_PATHS[@]}" -type f \
  \( -name '*.py' -o -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
     -o -name '*.md' -o -name '*.sh' -o -name '*.json' -o -name '*.toml' -o -name '*.cfg' \
     -o -name '*.ini' -o -name '*.txt' -o -name '*.css' \) 2>/dev/null)

if [ "$fail" -ne 0 ]; then
  echo "FAIL: non-ASCII content detected (last: $found_file)."
  exit 1
fi

echo "OK: pure ASCII across all scanned files."
