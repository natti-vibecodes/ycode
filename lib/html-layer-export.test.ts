import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerToExportHtml } from './html-layer-converter';
import type { Layer } from '@/types';

/**
 * export_layer_html is what an agent reaches for to check what a page will serve.
 * Two gaps made it report the OPPOSITE of the truth (SCA-1131, 2026-08-12):
 * customAttributes were dropped entirely, and a link on anything other than a
 * div/button vanished. Both failures were silent and reassuring — the markup came
 * back looking complete.
 */

const urlLink = (href: string) =>
  ({ type: 'url', url: { type: 'dynamic_text', data: { content: href } } }) as any;

const textVar = (s: string) =>
  ({
    text: {
      type: 'dynamic_rich_text',
      data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] } },
    },
  }) as any;

test('customAttributes.class REPLACES the generated Tailwind classes', () => {
  const layer = {
    id: 'l1', name: 'heading',
    classes: ['text-[48px]', 'font-[700]'],
    settings: { tag: 'h1', customAttributes: { class: 'reveal' } },
    variables: textVar('Experts in every field we touch.'),
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /class="reveal"/);
  // the whole point: never advertise classes the renderer will not emit
  assert.ok(!html.includes('font-[700]'), 'generated Tailwind must not survive a class override');
  assert.ok(!html.includes('text-[48px]'));
});

test('generated classes still emit when there is no class override', () => {
  const layer = {
    id: 'l2', name: 'div',
    classes: ['flex', 'flex-col'],
    settings: { customAttributes: { 'data-sp': '0' } },
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /class="flex flex-col"/);
  assert.match(html, /data-sp="0"/);
});

test('non-class customAttributes are emitted, and none are duplicated', () => {
  const layer = {
    id: 'l3', name: 'button',
    classes: [],
    settings: {
      customAttributes: {
        class: 'hub-item sp-it active',
        'aria-expanded': 'true',
        'aria-controls': 'sp-page-0',
        style: 'font-weight:300',
      },
    },
    variables: textVar('Applied AI'),
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /class="hub-item sp-it active"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-controls="sp-page-0"/);
  assert.match(html, /style="font-weight:300"/);
  assert.equal(html.match(/class=/g)?.length, 1, 'class must appear exactly once');
});

test('a linked div BECOMES the anchor (unchanged behaviour)', () => {
  const layer = {
    id: 'l4', name: 'div',
    classes: [],
    settings: { customAttributes: { class: 'sp-card' } },
    variables: { link: urlLink('/services/mvp-development') },
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /^<a [^>]*href="\/services\/mvp-development"/);
  assert.match(html, /class="sp-card"/);
  assert.ok(!html.includes('<a><a'), 'must not double-wrap');
});

test('a linked TEXT layer is wrapped in an anchor instead of losing the link', () => {
  const layer = {
    id: 'l5', name: 'text',
    classes: [],
    settings: { tag: 'span', customAttributes: { class: 'sp-more' } },
    variables: { ...textVar('Learn more about Applied AI'), link: urlLink('/services/ai-development') },
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /<a href="\/services\/ai-development">/);
  assert.match(html, /<span class="sp-more">Learn more about Applied AI<\/span>/);
});

test('a linked image is wrapped, not silently unlinked', () => {
  const layer = {
    id: 'l6', name: 'image',
    classes: [],
    variables: {
      image: { src: { type: 'dynamic_text', data: { content: '/a.webp' } }, alt: { type: 'dynamic_text', data: { content: 'A' } } },
      link: urlLink('/case-studies'),
    },
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /<a href="\/case-studies">/);
  assert.match(html, /<img[^>]*src="\/a\.webp"/);
  assert.match(html, /alt="A"/);
});

test('an unlinked layer gains no anchor', () => {
  const layer = {
    id: 'l7', name: 'text',
    classes: [],
    settings: { tag: 'p', customAttributes: { class: 'sp-cd' } },
    variables: textVar('Plain copy.'),
  } as unknown as Layer;

  assert.ok(!layerToExportHtml(layer).includes('<a'));
});

test('children are exported with their own custom attributes and links', () => {
  const layer = {
    id: 'p0', name: 'div',
    classes: [],
    settings: { customAttributes: { class: 'sp-cards' } },
    children: [
      {
        id: 'c0', name: 'div', classes: [],
        settings: { customAttributes: { class: 'sp-card' } },
        variables: { link: urlLink('/services/ux-audit') },
        children: [
          {
            id: 'c0t', name: 'heading', classes: ['font-[700]'],
            settings: { tag: 'h3', customAttributes: { class: 'sp-ct' } },
            variables: textVar('UX Audit'),
          },
        ],
      },
    ],
  } as unknown as Layer;

  const html = layerToExportHtml(layer);
  assert.match(html, /class="sp-cards"/);
  assert.match(html, /href="\/services\/ux-audit"/);
  assert.match(html, /<h3 class="sp-ct">UX Audit<\/h3>/);
  assert.ok(!html.includes('font-[700]'));
});
