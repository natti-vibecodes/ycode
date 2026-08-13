import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isCircularComponentReference, wouldCreateCircularReference } from './component-utils';
import type { Component, Layer } from '@/types';

/**
 * SCA-1358. The engine supported component nesting three ways over — the renderer resolves nested
 * instances recursively with an ancestor guard, and the builder UI allows it — but the MCP surface
 * had no op for it, so an agent asked to build a component out of other components had to inline a
 * copy of the child's markup. That copy renders identically on the day it is made and then
 * silently stops tracking the child forever, which is the same class of failure as a page holding
 * its own copy of a section instead of an instance.
 *
 * These cover the guard the new op relies on. The op itself refuses a cycle BEFORE writing, so a
 * rejected call must leave the component untouched — a half-applied cycle would make the renderer
 * non-terminating, which is not a state anything else can recover from.
 */

const layer = (id: string, componentId?: string, children: Layer[] = []): Layer =>
  ({ id, name: 'div', componentId, children } as unknown as Layer);

/** A → B → C, plus a standalone D. */
const COMPONENTS = [
  { id: 'A', name: 'Page shell', variants: [{ id: 'va', name: 'Default', layers: [layer('a1', 'B')] }] },
  { id: 'B', name: 'Card grid', variants: [{ id: 'vb', name: 'Default', layers: [layer('b1', 'C')] }] },
  { id: 'C', name: 'Card', variants: [{ id: 'vc', name: 'Default', layers: [layer('c1')] }] },
  { id: 'D', name: 'Footer', variants: [{ id: 'vd', name: 'Default', layers: [layer('d1')] }] },
] as unknown as Component[];

describe('isCircularComponentReference — the guard the nesting op enforces (SCA-1358)', () => {
  test('REGRESSION: a component cannot contain ITSELF', () => {
    // The simplest non-terminating render, and the one an agent is most likely to attempt.
    assert.equal(isCircularComponentReference('C', 'C', COMPONENTS), true);
  });

  test('REGRESSION: an INDIRECT cycle is refused — C inside A when A → B → C', () => {
    // The dangerous case: nothing about the call names A twice, so it looks legal from the
    // caller's side. Only a graph walk sees it.
    assert.equal(isCircularComponentReference('C', 'A', COMPONENTS), true);
  });

  test('legal nesting is ALLOWED — the guard must not be a blanket refusal', () => {
    // A guard that rejects everything passes every cycle test and ships a useless tool.
    assert.equal(isCircularComponentReference('B', 'D', COMPONENTS), false);
    assert.equal(isCircularComponentReference('A', 'D', COMPONENTS), false);
    assert.equal(isCircularComponentReference('C', 'D', COMPONENTS), false);
  });

  test('nesting DEEPER along an existing chain is legal — B into A is already the shape', () => {
    // A already contains B. Adding another B instance is duplication, not recursion.
    assert.equal(isCircularComponentReference('A', 'B', COMPONENTS), false);
  });

  test('a longer chain still resolves — D → A would close A → B → C', () => {
    const withDtoA = COMPONENTS.map((c) =>
      c.id === 'C' ? ({ ...c, variants: [{ id: 'vc', name: 'Default', layers: [layer('c1', 'D')] }] } as Component) : c);
    // Now A → B → C → D, so nesting A inside D closes the loop.
    assert.equal(isCircularComponentReference('D', 'A', withDtoA), true);
    // …while the same call against the ORIGINAL graph is fine, proving the result tracks the
    // graph rather than the ids.
    assert.equal(isCircularComponentReference('D', 'A', COMPONENTS), false);
  });

  test('an unknown component id is not treated as a cycle', () => {
    // Failing closed here would reject legal nesting whenever the component list is incomplete.
    assert.equal(isCircularComponentReference('A', 'does-not-exist', COMPONENTS), false);
  });

  test('the underlying check reports the path, for a usable error message', () => {
    const r = wouldCreateCircularReference('C', [layer('x', 'A')], COMPONENTS);
    assert.equal(r.wouldCycle, true);
    assert.ok(r.cyclePath && r.cyclePath.length >= 2, 'a refusal should be able to say why');
  });

  test('layers carrying no component reference can never cycle', () => {
    assert.equal(wouldCreateCircularReference('A', [layer('plain')], COMPONENTS).wouldCycle, false);
  });
});
