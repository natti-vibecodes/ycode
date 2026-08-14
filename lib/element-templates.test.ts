import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ELEMENT_TEMPLATES } from './mcp/utils';

/**
 * SCA-1332 — what a newly created layer is born believing.
 *
 * A text layer used to arrive with `typography.fontSize: '16px'` AND a matching `text-[16px]`
 * class. Both are utilities of the same specificity as the site's hand-written rules, and they
 * appear later in the cascade, so an authored `.stmt{font-size:31px}` lost to a size nobody chose
 * and the stylesheet looked broken. The layer was not misconfigured — it was born opinionated, and
 * an opinion you did not set is the hardest kind to find.
 *
 * A layer that specifies nothing can be styled by anything.
 */

const templateOf = (key: string) => (ELEMENT_TEMPLATES as Record<string, { template?: unknown }>)[key]?.template as
  | { design?: { typography?: Record<string, unknown> }; classes?: string[] }
  | undefined;

describe('ELEMENT_TEMPLATES birth defaults (SCA-1332)', () => {
  test('REGRESSION: a text layer is born with NO hardcoded font size', () => {
    const t = templateOf('text');
    assert.ok(t, 'text template must exist');
    assert.equal(t!.design?.typography?.fontSize, undefined, 'text must not pin a font size at birth');
  });

  test('REGRESSION: and no `text-[…]` decoy class either', () => {
    // Removing the design property alone would not have fixed it: the class is what actually
    // renders, so a half-fix leaves the exact same symptom with a cleaner-looking design panel.
    const classes = templateOf('text')?.classes ?? [];
    assert.deepEqual(classes.filter((c) => /^text-\[/.test(c)), [],
      'a text-[…] class re-pins the size the design property no longer sets');
  });

  test('the text template still produces an editable paragraph', () => {
    // The point is to remove an opinion, not the element. A template that stopped being a usable
    // <p> would pass every assertion above and be useless.
    const t = templateOf('text') as { settings?: { tag?: string }; variables?: { text?: unknown } } | undefined;
    assert.equal(t?.settings?.tag, 'p');
    assert.ok(t?.variables?.text, 'text layers must still carry their text variable');
  });

  test('AUDIT: every template that pins a font size is listed and deliberate', () => {
    // Not a prohibition — a heading legitimately carries type. This fails when a NEW template
    // starts pinning a size, so the decision is made on purpose rather than by copy-paste.
    const pinned = Object.entries(ELEMENT_TEMPLATES as Record<string, { template?: { design?: { typography?: Record<string, unknown> } } }>)
      .filter(([, v]) => v.template?.design?.typography?.fontSize !== undefined)
      .map(([k]) => k)
      .sort();
    assert.deepEqual(pinned, ['button', 'heading', 'richText'],
      `templates pinning a font size changed: ${pinned.join(', ')}. If this is intentional, update the list and say why.`);
  });

  test('REGRESSION: no template is born bold (SCA-1391)', () => {
    // The brand type scale runs 300–500 and is never bold, and the site carries a global rescue
    // rule that reads a bold heading as rogue imported type and restyles it to the 148px hero
    // scale. So `fontWeight: '700'` on the heading template did not just render off-brand — it
    // tripped a correction meant for something else, and put two legal-page H1s at hero size
    // inside a 680px column. Asserted across ALL templates, not just heading, because the next
    // one will arrive by copy-paste.
    for (const [key, entry] of Object.entries(ELEMENT_TEMPLATES as Record<string, {
      template?: { design?: { typography?: Record<string, unknown> }; classes?: string[] };
    }>)) {
      const weight = entry.template?.design?.typography?.fontWeight as string | undefined;
      if (weight !== undefined) {
        assert.ok(Number(weight) <= 500,
          `${key} is born at weight ${weight}; the scale stops at 500 and bold trips the rogue-type rescue rule`);
      }
      // The class again, for the same reason as the size: it is what actually renders.
      const boldClass = (entry.template?.classes ?? []).find(
        (c) => /^font-\[(\d+)\]$/.test(c) && Number(c.match(/\[(\d+)\]/)![1]) > 500,
      );
      assert.equal(boldClass, undefined,
        `${key} carries ${boldClass}, which re-pins a weight the design property no longer sets`);
    }
  });

  test('REGRESSION: the button template\'s panel and class AGREE', () => {
    // They used to disagree — design 16px, class 14px — and the class wins, so the design panel
    // reported a size no button had ever rendered at. Aligned to 14px: truth-in-panel, zero
    // visual change. This asserts the two sources match rather than asserting a specific number,
    // so it keeps holding if the size is ever changed deliberately.
    const btn = templateOf('button');
    const designSize = btn?.design?.typography?.fontSize as string | undefined;
    const classSize = (btn?.classes ?? []).find((c) => /^text-\[\d/.test(c))?.match(/\[(.+)\]/)?.[1];
    assert.ok(designSize, 'button template should still declare a size');
    assert.equal(designSize, classSize,
      `button design says ${designSize} but its class says ${classSize} — the class wins, so the panel would lie`);
  });
});
