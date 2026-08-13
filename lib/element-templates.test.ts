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

  test('KNOWN INCONSISTENCY: the button template contradicts itself', () => {
    // design says 16px, classes say 14px — and the class wins. Documented as a test rather than
    // silently fixed, because changing it changes how every existing button renders, which is
    // Natalia's call and not a side effect of a text-layer ticket.
    const btn = templateOf('button');
    assert.equal(btn?.design?.typography?.fontSize, '16px');
    assert.ok((btn?.classes ?? []).includes('text-[14px]'),
      'if this class is gone the contradiction was resolved — update or delete this test');
  });
});
