import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBooleanVariable, isLayerHiddenByVariable } from './component-visibility';
import { applyComponentOverrides } from './resolve-components';
import type { ComponentVariable, Layer } from '@/types';

/**
 * SCA-1357 — boolean ("show this or not") component variables.
 *
 * The rule decides whether content reaches the page at all, so the cases that matter most are the
 * ones where nothing has been said: an unbound layer, a dangling variable id, a variable with no
 * value. All of those must RENDER. A visibility system that fails hidden deletes content from a
 * published page on a typo, with every signal green — the same failure shape as an entrance
 * animation that never runs, which this codebase already solved by making the hidden state opt-in.
 */

const VAR: ComponentVariable[] = [
  { id: 'v-show', name: 'Show budget field', type: 'boolean', default_value: { value: true } as never },
  { id: 'v-hide', name: 'Show promo', type: 'boolean', default_value: { value: false } as never },
  { id: 'v-unset', name: 'Show extras', type: 'boolean' },
];

const layer = (id: string, visibilityVar?: string, children: Layer[] = []): Layer =>
  ({ id, name: 'div', componentVisibilityVariableId: visibilityVar, children } as unknown as Layer);

describe('resolveBooleanVariable (SCA-1357)', () => {
  test('an instance override beats the variable default', () => {
    const overrides = { boolean: { 'v-show': { value: false } } } as unknown as Layer['componentOverrides'];
    assert.equal(resolveBooleanVariable('v-show', overrides, VAR), false);
  });

  test('REGRESSION: an override of FALSE is honoured, not read as "unset"', () => {
    // The bug this guards: `overrideValue || default` treats false as absent, so switching
    // something off silently reverts to the default of on.
    const overrides = { boolean: { 'v-show': { value: false } } } as unknown as Layer['componentOverrides'];
    assert.equal(resolveBooleanVariable('v-show', overrides, VAR), false);
    assert.notEqual(resolveBooleanVariable('v-show', overrides, VAR), true);
  });

  test('falls back to the default when no override exists', () => {
    assert.equal(resolveBooleanVariable('v-hide', undefined, VAR), false);
    assert.equal(resolveBooleanVariable('v-show', undefined, VAR), true);
  });

  test('a variable with no value at all resolves to undefined, not false', () => {
    assert.equal(resolveBooleanVariable('v-unset', undefined, VAR), undefined);
  });

  test('a bare boolean is accepted as well as the stored { value } shape', () => {
    const overrides = { boolean: { 'v-show': true } } as unknown as Layer['componentOverrides'];
    assert.equal(resolveBooleanVariable('v-show', overrides, VAR), true);
  });
});

describe('isLayerHiddenByVariable — fails VISIBLE (SCA-1357)', () => {
  test('hidden only on an explicit false', () => {
    assert.equal(isLayerHiddenByVariable(layer('l', 'v-hide'), undefined, VAR), true);
    assert.equal(isLayerHiddenByVariable(layer('l', 'v-show'), undefined, VAR), false);
  });

  test('REGRESSION: an unbound layer is never hidden', () => {
    assert.equal(isLayerHiddenByVariable(layer('l'), undefined, VAR), false);
  });

  test('REGRESSION: a DANGLING variable id renders rather than disappearing', () => {
    // A typo'd or deleted variable must not silently delete a section from a published page.
    assert.equal(isLayerHiddenByVariable(layer('l', 'v-does-not-exist'), undefined, VAR), false);
  });

  test('REGRESSION: a variable with no value renders', () => {
    assert.equal(isLayerHiddenByVariable(layer('l', 'v-unset'), undefined, VAR), false);
  });
});

describe('applyComponentOverrides drops the subtree (SCA-1357)', () => {
  const tree = [
    layer('keep'),
    layer('promo', 'v-hide', [layer('promo-title'), layer('promo-img')]),
    layer('budget', 'v-show', [layer('budget-input')]),
  ];

  test('REGRESSION: a false layer is OMITTED, and so are its children', () => {
    // Omission, not CSS hiding: no markup ships for a switched-off section, so there is no
    // hidden image to download and nothing to reveal in devtools.
    const out = applyComponentOverrides(tree, undefined, VAR);
    const ids = out.map((l) => l.id);
    assert.deepEqual(ids, ['keep', 'budget']);
    assert.equal(JSON.stringify(out).includes('promo-title'), false, 'child of a hidden layer must not survive');
  });

  test('a true layer keeps its children', () => {
    const out = applyComponentOverrides(tree, undefined, VAR);
    const budget = out.find((l) => l.id === 'budget');
    assert.equal(budget?.children?.length, 1);
  });

  test('an instance override can switch a section ON that defaults OFF', () => {
    const overrides = { boolean: { 'v-hide': { value: true } } } as unknown as Layer['componentOverrides'];
    const ids = applyComponentOverrides(tree, overrides, VAR).map((l) => l.id);
    assert.deepEqual(ids, ['keep', 'promo', 'budget']);
  });

  test('an instance override can switch a section OFF that defaults ON', () => {
    const overrides = { boolean: { 'v-show': { value: false } } } as unknown as Layer['componentOverrides'];
    const ids = applyComponentOverrides(tree, overrides, VAR).map((l) => l.id);
    assert.deepEqual(ids, ['keep']);
  });

  test('REGRESSION: with NO variables defined at all, nothing is dropped', () => {
    // A component whose variables failed to load must render its full tree, not vanish.
    const ids = applyComponentOverrides(tree, undefined, undefined).map((l) => l.id);
    assert.deepEqual(ids, ['keep', 'promo', 'budget']);
  });

  test('nested layers are filtered at every depth', () => {
    const nested = [layer('root', undefined, [layer('a'), layer('b', 'v-hide'), layer('c')])];
    const out = applyComponentOverrides(nested, undefined, VAR);
    assert.deepEqual(out[0].children?.map((l) => l.id), ['a', 'c']);
  });
});
