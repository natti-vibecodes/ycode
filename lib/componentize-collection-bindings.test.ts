/**
 * Regression test for SCA-1225: converting a section containing a CMS Collection
 * List into a component silently stripped every field binding under the list.
 *
 * Root cause: regenerateIdsWithInteractionRemapping gave every layer a fresh ID
 * but never remapped variables.*.data.collection_layer_id (or conditional
 * visibility condition.collectionLayerId), so cleanLayersForComponentCreation's
 * resetInvalidBindings — whose context is keyed by the NEW layer IDs — judged
 * the still-old references "outside the component" and stripped them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FieldVariable, Layer } from '@/types';
import {
  cleanLayersForComponentCreation,
  regenerateIdsWithInteractionRemapping,
} from '@/lib/layer-utils';

const OLD_LIST_ID = 'lyr_list_old';

function inlineVar(fv: FieldVariable): string {
  return `<ycode-inline-variable>${JSON.stringify(fv)}</ycode-inline-variable>`;
}

function textFieldBinding(): FieldVariable {
  return {
    type: 'field',
    data: {
      field_id: 'fld_title',
      field_type: 'text',
      relationships: [],
      source: 'collection',
      collection_layer_id: OLD_LIST_ID,
    },
  };
}

function imageFieldBinding(): FieldVariable {
  return {
    type: 'field',
    data: {
      field_id: 'fld_cover',
      field_type: 'image',
      relationships: [],
      source: 'collection',
      collection_layer_id: OLD_LIST_ID,
    },
  };
}

/** A section > collection list > item > (bound text, bound image) subtree. */
function buildSection(): Layer {
  return {
    id: 'lyr_section_old',
    name: 'section',
    classes: '',
    children: [
      {
        id: OLD_LIST_ID,
        name: 'div',
        customName: 'Collection',
        classes: '',
        variables: {
          collection: { id: 'col_posts' },
        },
        children: [
          {
            id: 'lyr_item_old',
            name: 'div',
            classes: '',
            children: [
              {
                id: 'lyr_text_old',
                name: 'text',
                classes: '',
                variables: {
                  text: {
                    type: 'dynamic_text',
                    data: { content: inlineVar(textFieldBinding()) },
                  },
                  conditionalVisibility: {
                    groups: [
                      {
                        id: 'grp_1',
                        conditions: [
                          {
                            id: 'cond_1',
                            source: 'page_collection',
                            collectionLayerId: OLD_LIST_ID,
                            operator: 'item_count',
                            compareOperator: 'gt',
                            compareValue: 0,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
              {
                id: 'lyr_img_old',
                name: 'image',
                classes: '',
                variables: {
                  image: {
                    src: imageFieldBinding(),
                    alt: { type: 'dynamic_text', data: { content: '' } },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function collectLayers(layers: Layer[]): Layer[] {
  const out: Layer[] = [];
  const walk = (list: Layer[]) => {
    for (const l of list) {
      out.push(l);
      if (l.children) walk(l.children);
    }
  };
  walk(layers);
  return out;
}

/** Mirror the componentize path: deep clone + fresh IDs, then clean. */
function componentize(section: Layer): Layer[] {
  const cloned = regenerateIdsWithInteractionRemapping(
    JSON.parse(JSON.stringify(section)) as Layer,
  );
  return cleanLayersForComponentCreation([cloned]);
}

test('componentizing a Collection List keeps field bindings, remapped to the new list layer id', () => {
  const cleaned = componentize(buildSection());
  const all = collectLayers(cleaned);

  const list = all.find((l) => l.variables?.collection);
  assert.ok(list, 'collection list layer survives componentization');
  assert.notEqual(list.id, OLD_LIST_ID, 'list layer got a fresh id');
  assert.equal(list.variables?.collection?.id, 'col_posts', 'collection source survives');

  // Bound image: the binding must survive AND point at the NEW list layer id
  const img = all.find((l) => l.name === 'image');
  assert.ok(img, 'image layer survives');
  const imgSrc = img.variables?.image?.src;
  assert.ok(imgSrc, 'image src variable survives');
  assert.equal(imgSrc.type, 'field', 'image src is still a field binding (not reset to asset)');
  const imgData = (imgSrc as FieldVariable).data;
  assert.equal(imgData.field_id, 'fld_cover', 'image field_id survives');
  assert.equal(
    imgData.collection_layer_id,
    list.id,
    'image binding points at the NEW list layer id',
  );

  // Bound text: the inline variable must survive AND reference the NEW list layer id
  const text = all.find((l) => l.name === 'text');
  assert.ok(text, 'text layer survives');
  const textVar = text.variables?.text;
  assert.equal(textVar?.type, 'dynamic_text');
  const content = (textVar?.data as { content: string }).content;
  assert.ok(
    content.includes('<ycode-inline-variable>'),
    `inline variable was stripped from text content: ${JSON.stringify(content)}`,
  );
  const parsed = JSON.parse(
    /<ycode-inline-variable>([\s\S]*?)<\/ycode-inline-variable>/.exec(content)![1],
  ) as FieldVariable;
  assert.equal(parsed.data.field_id, 'fld_title', 'text field_id survives');
  assert.equal(
    parsed.data.collection_layer_id,
    list.id,
    'text binding points at the NEW list layer id',
  );

  // Note: page_collection visibility conditions are stripped by design during
  // componentization (stripPageSourceBindings step 1) — their collectionLayerId
  // remapping matters for the duplicate/paste path and is covered below.
});

test('regenerateIdsWithInteractionRemapping remaps condition.collectionLayerId (duplicate/paste path)', () => {
  const regenerated = regenerateIdsWithInteractionRemapping(
    JSON.parse(JSON.stringify(buildSection())) as Layer,
  );
  const all = collectLayers([regenerated]);

  const list = all.find((l) => l.variables?.collection);
  assert.ok(list);
  assert.notEqual(list.id, OLD_LIST_ID);

  const text = all.find((l) => l.name === 'text');
  assert.ok(text);
  const condition = text.variables?.conditionalVisibility?.groups?.[0]?.conditions?.[0];
  assert.ok(condition, 'visibility condition survives regeneration');
  assert.equal(
    condition.collectionLayerId,
    list.id,
    'visibility condition points at the NEW list layer id, not the original',
  );

  // Field bindings are also remapped (before any cleaning happens)
  const img = all.find((l) => l.name === 'image');
  assert.equal(
    (img?.variables?.image?.src as FieldVariable).data.collection_layer_id,
    list.id,
    'image binding points at the NEW list layer id after regeneration',
  );
});

test('bindings referencing a collection layer OUTSIDE the copied subtree are still stripped', () => {
  const section = buildSection();
  // Point the image binding at a collection layer that is not part of the subtree
  const img = section.children![0].children![0].children![1];
  (img.variables!.image!.src as FieldVariable).data.collection_layer_id = 'lyr_external_list';

  const cleaned = componentize(section);
  const all = collectLayers(cleaned);
  const imgAfter = all.find((l) => l.name === 'image');
  assert.ok(imgAfter);
  assert.equal(
    imgAfter.variables?.image?.src?.type,
    'asset',
    'externally-bound image src is reset (genuinely out of scope)',
  );
});
