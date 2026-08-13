/**
 * Whether a layer is genuinely empty — for the `data-is-empty` diagnostic marker (SCA-1368).
 *
 * The old predicate was `!textContent && !children`, which is TRUE for every leaf media element:
 * all 18 homepage `<img>` tags carried `data-is-empty="true"` alongside a perfectly valid `src`.
 * A flag that is true for every image carries no information about images — and it is read as a
 * symptom. It is in the playbook as the component-GUTTED marker, it was read as a symptom when 21
 * card tiles reported it, and it nearly misdirected the Midjourney-tile diagnosis before someone
 * noticed the tile was fine and the flag was meaningless.
 *
 * So the marker now means what its name says: nothing here renders. An element that IS its own
 * content — an image, a video, a horizontal rule — is not empty just because it has no children.
 *
 * Shared by the public and builder renderers deliberately. The same predicate lived in two places
 * and would have drifted; duplicated copies of a compatibility surface are the bug, not the
 * missing feature.
 */

import type { Layer } from '@/types';

/**
 * Tags that ARE their own content. An `<img>` with a src is not an empty box, and an `<input>`
 * a user can type into is not an empty box either.
 */
const SELF_CONTAINED_TAGS = new Set([
  'img', 'video', 'audio', 'iframe', 'canvas', 'svg', 'input', 'textarea',
  'select', 'hr', 'br', 'source', 'track', 'embed', 'object', 'picture',
]);

/** True when a media variable actually points at something. */
function hasMediaSource(layer: Pick<Layer, 'variables'>): boolean {
  const v = layer.variables as Record<string, { src?: unknown } | undefined> | undefined;
  if (!v) return false;
  for (const slot of ['image', 'video', 'audio', 'icon', 'backgroundImage'] as const) {
    if (v[slot]?.src) return true;
  }
  return false;
}

export function isLayerEmpty(
  layer: Pick<Layer, 'variables'>,
  textContent: unknown,
  children: unknown[] | undefined | null,
  htmlTag: string | undefined,
): boolean {
  if (textContent) return false;
  if (children && children.length > 0) return false;
  if (htmlTag && SELF_CONTAINED_TAGS.has(htmlTag.toLowerCase())) return false;
  if (hasMediaSource(layer)) return false;
  return true;
}
