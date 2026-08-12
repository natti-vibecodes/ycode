'use client';

import { useEffect } from 'react';

import { recreateScript } from '@/lib/script-utils';
import { INERT_TYPE, ORIGINAL_TYPE_ATTR } from '@/lib/deferred-scripts';

/**
 * Runs the head custom code's scripts after hydration (SCA-1297).
 *
 * `renderRootLayoutHeadCode` parks executable head scripts with the inert marker type, because an
 * executable `<script>` in a React tree is replaced by a `<div>` on a client render. Parked, they
 * are inert — so something has to switch them back on, and that is this component.
 *
 * It is the same clone-and-replace the body path has always used: a fresh element is created and
 * the parked node is replaced by it, because a script that is merely *edited* in place never
 * executes — per spec, an already-inserted script element does not run on a `type` change. (That
 * mechanism is exactly what SCA-1296 mistakenly reported as broken; it was correct then and this
 * reuses it rather than inventing a second one.)
 *
 * Scripts run in document order and `src` scripts are awaited, so an inline snippet that depends
 * on a library loaded above it still finds it — dynamically created scripts are async by default,
 * which would otherwise reorder them.
 */
export default function HeadScriptActivator() {
  useEffect(() => {
    const parked = Array.from(
      document.head.querySelectorAll<HTMLScriptElement>(`script[type="${INERT_TYPE}"]`),
    );
    if (parked.length === 0) return;

    let cancelled = false;

    (async () => {
      for (const original of parked) {
        if (cancelled) return;

        // Restore the real type on the ORIGINAL before cloning, so the clone inherits it.
        const originalType = original.getAttribute(ORIGINAL_TYPE_ATTR);
        original.removeAttribute(ORIGINAL_TYPE_ATTR);
        if (originalType) original.setAttribute('type', originalType);
        else original.removeAttribute('type');

        const script = recreateScript(original);

        if (script.src) {
          await new Promise<void>((resolve) => {
            script.addEventListener('load', () => resolve());
            script.addEventListener('error', () => resolve()); // a 404 must not stall the rest
            original.replaceWith(script);
          });
        } else {
          original.replaceWith(script);
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return null;
}
