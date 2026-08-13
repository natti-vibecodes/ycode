#!/usr/bin/env bash
#
# Blue-green rebuild of the :3003 review server (SCA-1347).
#
# The old procedure built INTO the directory the running server was serving from:
#
#     rm -rf .next-review/cache && NEXT_DIST_DIR=.next-review next build
#
# For the ~35 seconds that took, :3003 answered requests out of a half-replaced dist. It did not
# error — it served a coherent-looking page from whatever generation happened to still be on disk,
# which is worse. On 2026-08-13 a lane read /case-studies during that window and reported a
# 21-card grid that existed in no database row, plus /dynamic rendering zero cards, and filed it
# as a publish-integrity incident. Nothing was wrong with the data; they had read a directory
# mid-overwrite. Natalia's "the site keeps reloading after publish" is the same window seen from
# a browser.
#
# So: build to a scratch dist the server is not reading, then stop, swap, start. The bad window
# collapses from ~35s of confident wrong answers to ~2s of connection-refused — a failure a
# reader cannot mistake for a result.
#
# Usage:  npm run review:rebuild
set -euo pipefail

PORT=3003
LIVE=".next-review"
STAGING=".next-review-staging"
PREVIOUS=".next-review-previous"

cd "$(dirname "$0")/.."

# `next` lives in node_modules/.bin, which npm puts on PATH for `npm run` — but NOT when this
# script is invoked directly, as the watcher does. Without this the watcher's rebuild died with
# "next: command not found" while npm run review:rebuild worked fine, so the failure only appeared
# once something other than a human ran it.
export PATH="$PWD/node_modules/.bin:$PATH"

# The dirs this script creates MUST be gitignored. Tailwind v4 auto-detects sources and skips
# only gitignored paths, so an un-ignored build output gets scanned, its compiled CSS ingested as
# class candidates, and the generated stylesheet can come out unparseable — which 500s every route
# on the DEV server, with an error naming an innocent source file. That is exactly what shipping
# this script without a .gitignore update did on 2026-08-13. Assert it rather than remember it.
for dir in "$STAGING" "$PREVIOUS"; do
  if ! git check-ignore -q "$dir" 2>/dev/null; then
    echo "!! $dir is NOT gitignored. Tailwind will scan it and can emit an unparseable" >&2
    echo "!! stylesheet that 500s every route on :3002. Add '.next-review*' to .gitignore." >&2
    exit 1
  fi
done

echo "==> [1/4] Building into $STAGING (live server untouched, still serving $LIVE)"
rm -rf "$STAGING"
NEXT_DIST_DIR="$STAGING" next build

# Only now does anything the server reads change.
echo "==> [2/4] Stopping :$PORT"
if PIDS=$(lsof -ti:$PORT 2>/dev/null) && [ -n "$PIDS" ]; then
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  for _ in $(seq 1 20); do
    lsof -ti:$PORT >/dev/null 2>&1 || break
    sleep 0.25
  done
  # shellcheck disable=SC2046
  kill -9 $(lsof -ti:$PORT 2>/dev/null) 2>/dev/null || true
fi

echo "==> [3/4] Swapping $STAGING -> $LIVE"
rm -rf "$PREVIOUS"
[ -d "$LIVE" ] && mv "$LIVE" "$PREVIOUS"
mv "$STAGING" "$LIVE"

echo "==> [4/4] Starting :$PORT"
NEXT_DIST_DIR="$LIVE" PUBLISH_ALLOWED= nohup next start -p $PORT > /tmp/ycode-review-$PORT.log 2>&1 &

# Readiness is part of the job: reporting "rebuilt" while the port still refuses connections is
# how a stale-surface announcement gets made in the first place.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    echo "==> READY on :$PORT (log: /tmp/ycode-review-$PORT.log)"
    echo "    Previous build kept at $PREVIOUS — delete when you no longer need the rollback."
    exit 0
  fi
  sleep 0.5
done

echo "!! :$PORT did not become ready within 30s. Log tail:" >&2
tail -20 "/tmp/ycode-review-$PORT.log" >&2
echo "!! Roll back with:  rm -rf $LIVE && mv $PREVIOUS $LIVE && npm run review:start" >&2
exit 1
