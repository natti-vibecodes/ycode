/**
 * SCA-1468 (audit 2026-09-06 #28 + #42) — the fork owns how a public <video> LOADS.
 *
 * ## The bug this exists to remove
 *
 * Two independent mechanisms made every page download every video before a visitor could reach
 * one, and both live in the renderer:
 *
 *  1. `preload` was passed through from the layer. `preload="auto"` means "fetch the whole file",
 *     and it sat on a video 1751 px down `/services/design-branding` — 6.03 MB, fully buffered at
 *     3 s with no scroll and the element paused. Two more layers carried `preload="metadata"`.
 *     Measured post-press on 2026-09-07: 6.85 MB on that page, 6.20 MB on the homepage, at
 *     1440x900 and again at 375.
 *  2. `autoplay` was written into the HTML and the renderer's own ref called `play()` at
 *     hydration, on screen or not. `autoplay` in the markup also DEFEATS `preload="none"` in
 *     Chrome: an autoplay-eligible element is loaded eagerly whatever its preload hint says.
 *
 * Three generations of client-side workarounds have tried to correct (2) after hydration — a
 * page-local `play()` shim, then the chrome's visibility gate (SCA-1452, SCA-1467). None of them
 * can win, because by the time they run the bytes are already in flight. The renderer is the only
 * place that can decide this, because the renderer is what writes the attributes.
 *
 * ## The shape of the fix
 *
 *  - `preload` is resolved here for EVERY public video, defaulting to `none`, with one layer
 *    setting (`data-video-above-fold`) as the escape. See `resolveVideoPreload`.
 *  - a video whose author asked for autoplay is rendered WITHOUT `autoplay`, marked
 *    `data-autoplay="1"`, and started by `components/VideoAutoplayInitializer` once it is
 *    genuinely visible.
 *
 * The nav sphere is the proof this works: its chrome markup already says `preload="none"` with no
 * `autoplay`, and it stays at 0 bytes until it is revealed.
 *
 * ## Fail-visible
 *
 * Nothing here can hide a video. A configured `poster` still renders and still paints with no JS
 * at all; a video declared above the fold with no poster gets `preload="metadata"` so its first
 * frame paints without JS too. There is no `prefers-reduced-motion` gate — motion is not gated on
 * this site (animate-always), and this is a bandwidth decision, not a motion one.
 *
 * ## Editor surfaces are NOT affected
 *
 * This module is consumed only by `LayerRendererPublic`. The builder canvas (`LayerRenderer`)
 * keeps eager autoplay and the author's own preload, because a designer placing a video expects
 * to see it play immediately.
 */

/** Marks a video whose autoplay was deferred to the visibility driver. */
export const AUTOPLAY_MARKER_ATTR = 'data-autoplay';
export const AUTOPLAY_MARKER_VALUE = '1';

/** CSS selector for every video the driver owns. */
export const DEFERRED_AUTOPLAY_SELECTOR = `video[${AUTOPLAY_MARKER_ATTR}="${AUTOPLAY_MARKER_VALUE}"]`;

/**
 * Opt OUT of deferral on one layer (restores the pre-SCA-1468 eager `autoplay` + `play()`).
 * Default TRUE — the fork default is defer-and-play-on-visible.
 */
export const DEFER_ATTR = 'data-autoplay-defer';

/**
 * Declare a layer as visible at load. This is a SETTING, deliberately, because the renderer
 * cannot know where a layer lands: layout is CSS, and guessing from tree position is how you
 * ship a hero that never paints. Default FALSE — i.e. every video is treated as below the fold
 * until someone says otherwise, which is the safe direction for bandwidth.
 */
export const ABOVE_FOLD_ATTR = 'data-video-above-fold';

/** The two fields a layer can carry an attribute in (SCA-1348). */
export interface AttributeCarrier {
  attributes?: Record<string, unknown> | null;
  settings?: { customAttributes?: Record<string, string> | null } | null;
}

/**
 * Read one attribute off a layer, honouring both carriers with customAttributes last-wins.
 *
 * Kept local rather than importing `resolveLayerAttribute` from `lib/layer-utils` so this module
 * stays dependency-free: `layer-utils` pulls the whole renderer utility surface, and this file is
 * imported by a `'use client'` component whose entire job is to be tiny.
 */
export function readLayerAttribute(layer: AttributeCarrier | null | undefined, name: string): string | undefined {
  if (!layer) return undefined;
  const wanted = name.toLowerCase();
  const pick = (source: Record<string, unknown> | null | undefined) => {
    if (!source) return undefined;
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() !== wanted) continue;
      if (value === null || value === undefined) return undefined;
      return String(value);
    }
    return undefined;
  };
  return pick(layer.settings?.customAttributes) ?? pick(layer.attributes);
}

/**
 * Coerce a layer attribute to a boolean.
 *
 * `attributes` holds real booleans (the builder's video panel writes them), while the MCP surface
 * can only write `customAttributes`, which is typed `Record<string, string>` — so `"true"` and a
 * bare `""` (how HTML spells a set boolean attribute) have to mean the same thing as `true`, or
 * the setting is unreachable through the API that agents actually have.
 */
export function readLayerFlag(
  layer: AttributeCarrier | null | undefined,
  name: string,
  fallback: boolean,
): boolean {
  const raw = readLayerAttribute(layer, name);
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'false' || value === '0' || value === 'off' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'on' || value === 'yes' || value === '') return true;
  return fallback;
}

/** Did the author ask this media layer to autoplay? Reads both carriers, so a string "true"
 * written through the MCP's `customAttributes` counts — it did not before SCA-1468. */
export function isAutoplayMediaLayer(layer: AttributeCarrier | null | undefined): boolean {
  return readLayerFlag(layer, 'autoplay', false);
}

/**
 * Is this layer rendered in the deferred form — no `autoplay` attribute, marker instead?
 * True for every autoplay video unless the layer explicitly opts out.
 */
export function isDeferredAutoplayLayer(layer: AttributeCarrier | null | undefined): boolean {
  return isAutoplayMediaLayer(layer) && readLayerFlag(layer, DEFER_ATTR, true);
}

/** The values HTML defines for `preload`. Anything else on a layer is treated as unset. */
const PRELOAD_VALUES = ['none', 'metadata', 'auto'] as const;
export type VideoPreload = (typeof PRELOAD_VALUES)[number];

/**
 * The `preload` the fork renders on a public <video>. This applies to EVERY video, not only
 * autoplaying ones, and it is the half of SCA-1468 that the measurement actually turned on.
 *
 * The four video layers on /services/design-branding carry no `autoplay` at all — the chrome's
 * visibility gate is what plays them — and they still downloaded 6.85 MB before any scroll,
 * because `preload="auto"` was baked into one layer's attributes and `preload="metadata"` into
 * two more. `preload="auto"` means "fetch the whole file"; on a layer 1751 px down the page that
 * is never what anyone chose, it is what a port left behind. So the renderer owns the value:
 *
 *  - below the fold (the DEFAULT, and the only safe assumption a renderer can make) → `none`.
 *  - above the fold, per the layer's own `data-video-above-fold` → the author's `preload` if they
 *    set a real one, else `metadata` for a first frame, else `none` when a poster already paints.
 *
 * The escape hatch is a single setting rather than a guess, because the renderer cannot know
 * where a layer lands — layout is CSS.
 */
export function resolveVideoPreload(
  layer: AttributeCarrier | null | undefined,
  options: { hasPoster: boolean },
): VideoPreload {
  if (!readLayerFlag(layer, ABOVE_FOLD_ATTR, false)) return 'none';
  const authored = readLayerAttribute(layer, 'preload')?.trim().toLowerCase();
  if (authored && (PRELOAD_VALUES as readonly string[]).includes(authored)) return authored as VideoPreload;
  return options.hasPoster ? 'none' : 'metadata';
}

/**
 * A layer shaped enough to walk a tree of them. Structural rather than importing `Layer`, so
 * this module stays free of the types barrel — `variables` is read only for the one rich-text
 * shape the walk descends into.
 */
interface VideoScanLayer extends AttributeCarrier {
  name?: string;
  children?: VideoScanLayer[] | null;
  variables?: { text?: unknown } | null;
}

/**
 * Does this tree contain a video the driver would own?
 *
 * Used to decide whether the page ships `VideoAutoplayInitializer` at all. It descends into
 * children and into rich-text-embedded components' pre-resolved layers, matching
 * `layerTreeHasLayer` in PageRenderer — but callers must ALSO scan component masters, because a
 * component instance carries no children in the page tree and the reel video on
 * `/services/design-branding` lives inside one. Over-mounting is harmless (the driver finds no
 * marked videos and does nothing); under-mounting leaves a video permanently paused.
 */
export function treeHasDeferredAutoplayVideo(layers: readonly VideoScanLayer[] | null | undefined): boolean {
  if (!layers) return false;
  for (const layer of layers) {
    if (layer?.name === 'video' && isDeferredAutoplayLayer(layer)) return true;
    const textVar = layer?.variables?.text as { type?: string; data?: { content?: unknown } } | undefined;
    if (textVar?.type === 'dynamic_rich_text' && textVar.data?.content
      && tiptapHasDeferredAutoplayVideo(textVar.data.content)) {
      return true;
    }
    if (layer?.children && treeHasDeferredAutoplayVideo(layer.children)) return true;
  }
  return false;
}

function tiptapHasDeferredAutoplayVideo(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as { type?: string; attrs?: { _resolvedLayers?: unknown }; content?: unknown };
  if (n.type === 'richTextComponent' && Array.isArray(n.attrs?._resolvedLayers)
    && treeHasDeferredAutoplayVideo(n.attrs._resolvedLayers as VideoScanLayer[])) {
    return true;
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) {
      if (tiptapHasDeferredAutoplayVideo(child)) return true;
    }
  }
  return false;
}
