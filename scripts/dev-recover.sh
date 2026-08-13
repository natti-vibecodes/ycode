#!/usr/bin/env bash
#
# Recover the :3002 dev server from a corrupt incremental build (SCA-1352/1353).
#
# Twice on 2026-08-13 the dev server served 500s on every route from build state, not code:
# a stale artifact still requiring a deleted `instrumentation.ts` (MODULE_UNPARSABLE), and a
# Tailwind codegen that emitted an unparseable selector after scanning un-gitignored build output.
# Both survived a restart and both cleared with `rm -rf .next`.
#
# The reason this needs a script rather than a note is that the error message LIES ABOUT ITS
# LOCATION. It named `app/globals.css:9358` — a real file, 403 lines long, clean against HEAD and
# innocent — because the corruption was in generated output derived from it. A reader who trusts
# the message hunts for a bad selector in a file that never contained one. Knowing to stop looking
# at source and wipe the build directory is the whole trick, so it belongs in a command.
#
# Usage:  npm run dev:recover
set -euo pipefail

PORT=3002
cd "$(dirname "$0")/.."

echo "==> [1/3] Stopping :$PORT"
if PIDS=$(lsof -ti:$PORT 2>/dev/null) && [ -n "$PIDS" ]; then
  # Only kill things that are actually the dev server — browsers and helper processes hold
  # connections on this port too, and killing those is rude and useless.
  for pid in $PIDS; do
    if ps -o command= -p "$pid" 2>/dev/null | grep -qE 'next-server|next dev'; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
fi

echo "==> [2/3] Removing .next (the corruption lives in GENERATED output, not in your source)"
rm -rf .next

echo "==> [3/3] Starting :$PORT — first compile is slow, this waits for a real 200"
nohup next dev -p $PORT > /tmp/ycode-dev-$PORT.log 2>&1 &

for _ in $(seq 1 120); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "http://localhost:$PORT/" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    echo "==> READY: / returns 200 (log: /tmp/ycode-dev-$PORT.log)"
    echo "    NOTE: / is the heaviest route and answers in ~1s in dev. A probe with a"
    echo "    sub-second timeout reports 000 and reads as 'server down'. Use >=5s."
    exit 0
  fi
  sleep 2
done

echo "!! :$PORT still not serving 200 after 4 minutes. Log tail:" >&2
tail -30 "/tmp/ycode-dev-$PORT.log" >&2
echo "!! If the error names a source file, check its LINE COUNT first — a line number past the" >&2
echo "!! end of the file means you are reading generated output and the source is innocent." >&2
exit 1
