'use client';

/**
 * VideoAutoplayInitializer — the playback half of SCA-1468's deferred autoplay.
 *
 * `LayerRendererPublic` renders an autoplaying video WITHOUT `autoplay` and with
 * `preload="none"`, marked `data-autoplay="1"` (see `lib/video-autoplay.ts` for why). This
 * starts those videos once they are genuinely visible, and pauses them when they are not, so a
 * page downloads the videos a visitor actually reaches instead of all of them at parse time.
 *
 * ## Why it is event-driven and not IntersectionObserver alone (SCA-1452)
 *
 * A container revealed by a pure CSS `:hover` rule — the services mega menu, which holds the nav
 * sphere — writes no class and no style to any element, so a MutationObserver keyed on
 * attributes cannot see it, and a `display:none` element has no box to intersect. The gate that
 * relied on those two observers left the sphere frozen on a still frame and read as
 * intermittent, because unrelated churn happened to re-fire the MutationObserver.
 *
 * So every trigger here — IntersectionObserver, `pointerover`/`pointerout`, `focusin`/`focusout`,
 * `transitionend`/`animationend`, `resize`, `visibilitychange` — is a cheap nudge into ONE
 * `sweep()` that recomputes real visibility from the element's rect plus the
 * display/visibility/opacity chain above it. Nothing calls `play()` blind; a video is only
 * touched where its wanted state and its paused state disagree, so the triggers cannot fight
 * each other and an extra trigger can only ever be redundant.
 *
 * ## Not gated on prefers-reduced-motion
 *
 * Deliberately. Motion on this site is never reduced-motion-gated (animate-always), and this is
 * a bandwidth decision rather than a motion one.
 */

import { useEffect } from 'react';
import { DEFERRED_AUTOPLAY_SELECTOR } from '@/lib/video-autoplay';

/** Play a little before the element scrolls in, so it is not visibly dead on arrival. */
const ROOT_MARGIN_PX = 200;

/**
 * Minimum share of the smaller of (element, viewport) that must be on screen. Comparing against
 * the smaller of the two is what keeps this honest for both a thumbnail (ratio of itself) and a
 * full-bleed reel taller than the viewport (which can never reach a high ratio of itself).
 */
const VISIBLE_FRACTION = 0.25;

export default function VideoAutoplayInitializer() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let videos: HTMLVideoElement[] = [];

    /** Is the element painted at all — rect, and the display/visibility/opacity chain above it? */
    const shown = (video: HTMLVideoElement): boolean => {
      if (!video.isConnected) return false;
      let node: HTMLElement | null = video;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
          return false;
        }
        node = node.parentElement;
      }
      return true;
    };

    /** Is enough of it inside (or just outside) the viewport? */
    const near = (video: HTMLVideoElement): boolean => {
      const rect = video.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      const top = Math.max(rect.top, -ROOT_MARGIN_PX);
      const bottom = Math.min(rect.bottom, window.innerHeight + ROOT_MARGIN_PX);
      const left = Math.max(rect.left, -ROOT_MARGIN_PX);
      const right = Math.min(rect.right, window.innerWidth + ROOT_MARGIN_PX);
      const visibleArea = Math.max(0, bottom - top) * Math.max(0, right - left);
      if (visibleArea <= 0) return false;

      const viewportArea = (window.innerHeight + 2 * ROOT_MARGIN_PX) * (window.innerWidth + 2 * ROOT_MARGIN_PX);
      const reference = Math.min(rect.width * rect.height, viewportArea);
      return visibleArea >= reference * VISIBLE_FRACTION;
    };

    const want = (video: HTMLVideoElement): boolean => !document.hidden && shown(video) && near(video);

    const sweep = () => {
      for (const video of videos) {
        // want() === paused IS the disagreement: wanted and paused, or unwanted and playing.
        if (want(video) !== video.paused) continue;
        if (video.paused) {
          const played = video.play();
          if (played && typeof played.catch === 'function') played.catch(() => {});
        } else {
          video.pause();
        }
      }
    };

    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        sweep();
      });
    };

    const observer = new IntersectionObserver(schedule, { rootMargin: `${ROOT_MARGIN_PX}px` });

    /** Re-read the DOM. Videos arrive late from filters, load-more and lightboxes. */
    const collect = () => {
      const found = Array.from(document.querySelectorAll<HTMLVideoElement>(DEFERRED_AUTOPLAY_SELECTOR));
      const added = found.filter((video) => !videos.includes(video));
      videos = found;
      added.forEach((video) => observer.observe(video));
      if (added.length) schedule();
    };

    collect();

    // Watches for videos being ADDED, not for reveals — a CSS :hover reveal mutates nothing,
    // which is the whole reason the event listeners below exist.
    const mutations = new MutationObserver(() => {
      collect();
      schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    const REVEAL_EVENTS = [
      'pointerover', 'pointerout', 'focusin', 'focusout', 'transitionend', 'animationend',
    ] as const;
    REVEAL_EVENTS.forEach((type) => {
      document.addEventListener(type, schedule, { capture: true, passive: true });
    });
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule);

    sweep();

    return () => {
      observer.disconnect();
      mutations.disconnect();
      REVEAL_EVENTS.forEach((type) => {
        document.removeEventListener(type, schedule, { capture: true } as EventListenerOptions);
      });
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, []);

  return null;
}
