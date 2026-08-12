'use client';

import { useEffect, useRef } from 'react';

import { recreateScript } from '@/lib/script-utils';

interface CustomCodeInjectorProps {
  html: string;
}

// One-shot load events that already fired by the time custom code is injected
// (after hydration). Listeners registered now would never run, so we invoke
// them instead — keeps legacy snippets gated on these events working.
const ALREADY_FIRED_EVENTS = new Set(['DOMContentLoaded', 'load']);

/**
 * Marker type used to park scripts in the server-rendered markup.
 *
 * Unlike `innerHTML`, scripts present in the initial document are executed by
 * the parser — before React hydrates. That would run every snippet twice (once
 * at parse, once from the effect below) and, worse, let a snippet mutate the DOM
 * out from under React and blow up hydration. Giving them an unknown `type`
 * makes the parser skip them; the effect restores the real type to run them once.
 */
const INERT_TYPE = 'text/ycode-deferred';
const ORIGINAL_TYPE_ATTR = 'data-ycode-type';

/** Neutralise `<script>` opening tags so the HTML parser will not execute them. */
function deferScripts(html: string): string {
  return html.replace(/<script\b([^>]*)>/gi, (_match, attrs: string) => {
    const existing = /\stype\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.exec(attrs);
    const stripped = existing ? attrs.replace(existing[0], '') : attrs;
    const preserved = existing
      ? ` ${ORIGINAL_TYPE_ATTR}=${existing[1].startsWith('"') || existing[1].startsWith("'") ? existing[1] : `"${existing[1]}"`}`
      : '';
    return `<script${stripped}${preserved} type="${INERT_TYPE}">`;
  });
}

/**
 * Patch `addEventListener` on `document`/`window` so registrations for events
 * that already fired during page load run the listener asynchronously. Returns
 * a restore function. Scoped to the injection window to avoid affecting the
 * rest of the app.
 */
function installFiredEventShim(): () => void {
  const targets: (Document | Window)[] = [document, window];
  const originals = new Map<Document | Window, typeof document.addEventListener>();
  const hasFired = (type: string) =>
    type === 'load' ? document.readyState === 'complete' : document.readyState !== 'loading';

  for (const target of targets) {
    const original = target.addEventListener.bind(target);
    originals.set(target, original);
    (target as { addEventListener: typeof document.addEventListener }).addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (ALREADY_FIRED_EVENTS.has(type) && listener && hasFired(type)) {
        setTimeout(() => {
          try {
            const event = new Event(type);
            if (typeof listener === 'function') listener.call(target, event);
            else listener.handleEvent(event);
          } catch (error) {
            console.error('Custom code ready-event handler failed:', error);
          }
        }, 0);
        return;
      }
      original(type, listener, options);
    };
  }

  return () => {
    for (const [target, original] of originals) {
      (target as { addEventListener: typeof document.addEventListener }).addEventListener = original;
    }
  };
}

/**
 * Renders custom HTML on the server and executes its scripts after hydration.
 *
 * The markup is server-rendered via `dangerouslySetInnerHTML`. That matters for
 * SEO: sites keep their nav and footer in custom code, and injecting those only
 * on the client left the whole internal link graph out of the served HTML —
 * invisible to any crawler that does not execute JavaScript.
 *
 * Scripts still run on the client, because that is the part that genuinely
 * cannot be server-rendered. Markup parsed from `innerHTML` /
 * `dangerouslySetInnerHTML` is inert either way, so the existing
 * recreate-and-replace pass is unchanged — it now simply operates on nodes that
 * arrived with the document instead of ones written in on mount. React does not
 * diff `dangerouslySetInnerHTML` children, so there is no hydration mismatch.
 */
export default function CustomCodeInjector({ html }: CustomCodeInjectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Markup that is already in the DOM — server-rendered on first paint, so the
  // effect must not rewrite it and throw away the scripts it just executed.
  const renderedHtml = useRef<string | null>(html);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (renderedHtml.current !== html) {
      container.innerHTML = html;
      renderedHtml.current = html;
    }

    const scripts = Array.from(container.querySelectorAll('script'));
    // Restore the real type on the parked scripts so recreating them executes.
    for (const script of scripts) {
      if (script.getAttribute('type') !== INERT_TYPE) continue;
      const original = script.getAttribute(ORIGINAL_TYPE_ATTR);
      script.removeAttribute(ORIGINAL_TYPE_ATTR);
      if (original) script.setAttribute('type', original);
      else script.removeAttribute('type');
    }
    let cancelled = false;

    // Make listeners for already-fired load events run while scripts execute.
    const restoreShim = installFiredEventShim();

    // Execute sequentially — dynamically created scripts with `src` are
    // async by default, which breaks dependencies between external libs
    // and inline scripts that use them.
    async function executeScripts() {
      for (const original of scripts) {
        if (cancelled) return;
        const script = recreateScript(original);

        if (script.src) {
          await new Promise<void>((resolve) => {
            script.addEventListener('load', () => resolve());
            script.addEventListener('error', () => resolve());
            original.replaceWith(script);
          });
        } else {
          original.replaceWith(script);
        }
      }
    }

    executeScripts().finally(() => {
      restoreShim();
      if (cancelled) return;
      // Then re-fire the load lifecycle for anything the shim did not catch.
      //
      // The shim only rescues listeners registered synchronously while a script executes, and
      // patching addEventListener is easy to slip past — a script that registers from a
      // callback, a bundle that grabbed a reference earlier, or simply a pass where the shim
      // was already restored. Custom code overwhelmingly bootstraps on DOMContentLoaded, and
      // by the time these scripts run (after hydration) that event fired long ago, so anything
      // missed stays dormant forever: no reveals, no galleries, no nav behaviour, silently.
      //
      // Dispatching afterwards is the belt to the shim's braces and covers every registration
      // path. Handlers the shim already invoked were removed from the listener list at that
      // point, so this does not double-fire them.
      //
      // But WAIT until the document is genuinely finished first (SCA-1312). Next listens for
      // DOMContentLoaded on `document`, and its handler closes the RSC Flight stream and sets
      // `initialServerDataBuffer = undefined` (next/dist/esm/client/app-index.js). Fire this
      // mid-stream and every remaining `__next_f.push([1,…])` throws E18, "Unexpected server
      // data: missing bootstrap script" — ~17 per load on /contact, which lost that race
      // consistently while other pages happened to win it. Whether a page broke came down to
      // payload size and network timing.
      //
      // At `readyState === 'complete'` the real lifecycle is over: Next's own handler has run,
      // the buffer is already cleared, and no further chunks are coming — so the replay can no
      // longer disturb anything, while custom code still gets the events it waits on.
      const replayFiredEvents = () => {
        if (cancelled) return; // unmounted while we waited for `load`
        for (const type of ALREADY_FIRED_EVENTS) {
          try {
            document.dispatchEvent(new Event(type));
            if (type === 'load') window.dispatchEvent(new Event(type));
          } catch (error) {
            console.error(`Custom code ${type} replay failed:`, error);
          }
        }
      };

      if (document.readyState === 'complete') replayFiredEvents();
      else window.addEventListener('load', replayFiredEvents, { once: true });
    });

    return () => { cancelled = true; restoreShim(); };
  }, [html]);

  return (
    <div
      ref={containerRef}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: deferScripts(html) }}
    />
  );
}
