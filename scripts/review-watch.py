#!/usr/bin/env python3
"""
Keep the :3003 review server automatically fresh (SCA-1357).

Five times on 2026-08-13 a lane measured :3003, found content that matched no database row, and
reported a publish-integrity incident. Every one was the same thing: a press had landed and I had
not rebuilt the mirror yet. Two of those consumed a lane's evening and one froze Natalia twice.
Rebuilding on announcement cannot keep up — three presses arrived in 47 minutes, at her
discretion, and she owes nobody a heads-up.

So this removes the human step. It watches what actually matters — the SERVED OUTPUT of :3002 —
and rebuilds :3003 when it changes.

Why served content rather than the published_at / custom_code_body timestamps:
  * Those live behind /ycode/api, which is session-gated (401), and hunting for service keys to
    read two integers is the wrong trade.
  * More importantly, content is the ground truth and the timestamps are proxies for it. Freshness
    has TWO clocks — pages move on presses, chrome moves on syncs — and a content fingerprint
    captures both at once, plus fork code changes, without anyone maintaining a list of clocks.
  * The post-rebuild check is then the strongest available statement: :3002 and :3003 agree
    byte-for-byte on visible text. If they agree, both clocks agree by construction.

Safety properties, each earned tonight:
  * A fetch failure NEVER triggers a rebuild. Silence must not cause action, and rebuilding from
    a broken :3002 would propagate the breakage into the review surface.
  * A detected change is confirmed twice, DEBOUNCE seconds apart, before rebuilding — publish
    propagation took 2.1s between the page row and its layers, and rebuilding mid-propagation is
    exactly how a half-published generation got captured earlier tonight.
  * The rebuild itself is scripts/review-rebuild.sh, which is atomic: ~0.6s of connection-refused
    rather than ~35s of confidently wrong content.

Usage:  npm run review:watch          (foreground, Ctrl-C to stop)
"""

import hashlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# Pages chosen so BOTH clocks are visible: a page press changes one of them; a chrome sync changes
# the nav/footer on all of them. /motion-lab is included because it is the page under active
# review; drop or extend this list freely, it is not load-bearing.
PAGES = ["/", "/case-studies", "/motion-lab", "/insights"]
SOURCE = "http://localhost:3002"
MIRROR = "http://localhost:3003"
POLL_SECONDS = 20
DEBOUNCE_SECONDS = 8
REBUILD = Path(__file__).resolve().parent / "review-rebuild.sh"

SCRIPT_RE = re.compile(r"<script\b.*?</script>", re.S | re.I)
STYLE_RE = re.compile(r"<style\b.*?</style>", re.S | re.I)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def visible_text_hash(base: str, path: str, timeout: int = 60):
    """Hash of a page's visible text. Returns None on ANY failure — never a hash, so a failure
    can never be mistaken for a changed page."""
    try:
        with urllib.request.urlopen(base + path, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", "replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None
    body = html[html.find("<body"):]
    # Scripts carry per-compile chunk names and styles carry generated CSS; both churn without the
    # page having changed, so stripping them is what makes this signal quiet enough to act on.
    body = STYLE_RE.sub(" ", SCRIPT_RE.sub(" ", body))
    text = WS_RE.sub(" ", TAG_RE.sub(" ", body)).strip()
    if not text:
        return None
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def fingerprint(base: str):
    """None if ANY page fails, so a partial read can never look like a change."""
    out = {}
    for path in PAGES:
        h = visible_text_hash(base, path)
        if h is None:
            return None
        out[path] = h
    return out


def rebuild() -> bool:
    log("rebuilding :3003 (atomic swap)…")
    result = subprocess.run(["bash", str(REBUILD)], capture_output=True, text=True)
    if result.returncode != 0:
        log("!! REBUILD FAILED — :3003 left on the previous build, which is stale but coherent")
        for line in (result.stdout + result.stderr).strip().splitlines()[-6:]:
            log("   " + line)
        return False
    return True


def announce(source_fp) -> None:
    """The both-clocks check, expressed as the stronger statement it implies."""
    mirror_fp = fingerprint(MIRROR)
    if mirror_fp is None:
        log("!! :3003 did not answer after the rebuild — do NOT trust it")
        return
    disagree = [p for p in PAGES if source_fp.get(p) != mirror_fp.get(p)]
    if disagree:
        # Expected transiently if a press lands DURING a rebuild; the next poll settles it.
        log(f"!! :3003 disagrees with :3002 on {disagree} — another change probably landed mid-rebuild")
        return
    log(f"FRESH — :3002 and :3003 agree on all {len(PAGES)} pages: " +
        "  ".join(f"{p}={source_fp[p]}" for p in PAGES))


def main() -> int:
    log(f"watching {SOURCE} every {POLL_SECONDS}s; rebuilds {MIRROR} on change")
    baseline = fingerprint(SOURCE)
    while baseline is None:
        log("waiting for :3002 to answer on every watched page…")
        time.sleep(POLL_SECONDS)
        baseline = fingerprint(SOURCE)
    log("baseline: " + "  ".join(f"{p}={baseline[p]}" for p in PAGES))

    while True:
        time.sleep(POLL_SECONDS)
        current = fingerprint(SOURCE)
        if current is None:
            # :3002 down or mid-compile. Say so — a silent watcher is indistinguishable from a
            # working one — but do not act.
            log(":3002 unreadable; holding (no rebuild)")
            continue
        changed = [p for p in PAGES if current[p] != baseline[p]]
        if not changed:
            continue

        log(f"change detected on {changed}; confirming in {DEBOUNCE_SECONDS}s (propagation settles)")
        time.sleep(DEBOUNCE_SECONDS)
        confirm = fingerprint(SOURCE)
        if confirm is None:
            log(":3002 unreadable during confirmation; holding")
            continue
        if any(confirm[p] != current[p] for p in PAGES):
            log("still moving; will re-check next poll rather than capture a half-propagated state")
            baseline = confirm
            continue

        if rebuild():
            announce(confirm)
        baseline = confirm


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("stopped")
