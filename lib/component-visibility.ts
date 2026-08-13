/**
 * Boolean ("show this or not") component variables (SCA-1357).
 *
 * A `'boolean'` variable bound to a layer via `componentVisibilityVariableId` decides whether that
 * layer exists at all. False OMITS the layer and its subtree during override resolution rather
 * than hiding it with CSS, so a switched-off section ships no markup — no hidden images to
 * download, no headings for a screen reader to announce, nothing to un-hide with devtools.
 *
 * Kept free of heavy imports so the rule is unit-testable on its own. It is a rule about three
 * values, and it decides whether content reaches the page, which is not a thing to infer from
 * reading a 200-line resolver.
 */

import type { ComponentVariable, Layer } from '@/types';

/**
 * Resolve a boolean variable to true/false, or undefined when nothing has been set.
 *
 * Instance override wins over the variable's default, matching every other override channel.
 * Accepts `{ value: boolean }` (the stored shape) and a bare boolean, because hand-written and
 * older values exist and silently reading them as "not a boolean" would fail closed — see below
 * for why that direction is the dangerous one.
 */
export function resolveBooleanVariable(
  variableId: string,
  overrides?: Layer['componentOverrides'],
  componentVariables?: ComponentVariable[],
): boolean | undefined {
  const read = (v: unknown): boolean | undefined => {
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object' && 'value' in v) {
      const inner = (v as { value: unknown }).value;
      if (typeof inner === 'boolean') return inner;
    }
    return undefined;
  };

  const fromOverride = read(overrides?.boolean?.[variableId]);
  if (fromOverride !== undefined) return fromOverride;
  return read(componentVariables?.find((v) => v.id === variableId)?.default_value);
}

/**
 * True when a layer must be dropped from the tree.
 *
 * FAILS VISIBLE, deliberately. A layer is hidden ONLY when its bound variable resolves explicitly
 * to false; an unbound layer, a dangling variable id, or a variable with no value at all all
 * render. The opposite default would mean a typo'd id or a half-migrated component silently
 * deletes content from a published page while every signal stays green — the exact failure this
 * codebase already guards against in `html.reveal-armed`, where the animated state is opt-in so
 * that "no JS" renders everything rather than nothing.
 */
export function isLayerHiddenByVariable(
  layer: Pick<Layer, 'componentVisibilityVariableId'>,
  overrides?: Layer['componentOverrides'],
  componentVariables?: ComponentVariable[],
): boolean {
  const variableId = layer.componentVisibilityVariableId;
  if (!variableId) return false;
  return resolveBooleanVariable(variableId, overrides, componentVariables) === false;
}
