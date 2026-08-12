import React from 'react';
import type { Metadata } from 'next';
import DarkModeProvider from '@/components/DarkModeProvider';

export const defaultMetadata: Metadata = {
  title: 'Ycode - Visual Website Builder',
  description: 'Self-hosted visual website builder',
};

interface RootLayoutShellProps {
  children: React.ReactNode;
  headElements?: React.ReactNode[];
  /**
   * Classes applied to <body>. Consumers can include a `next/font` variable
   * (e.g. `${inter.variable}`) so a font is only loaded on the routes that
   * need it. Defaults to a font-free `font-sans antialiased` so generic
   * `font-sans` references fall back to the system stack — this is what
   * public published sites should use to avoid shipping the builder's UI font.
   */
  bodyClassName?: string;
  /**
   * Language for the <html lang> attribute. Omitted for public published sites
   * so the per-page locale (set on the content wrapper by PageRenderer) is the
   * source of truth instead of a hardcoded `en`.
   */
  lang?: string;
  /**
   * Attributes rendered on `<html>` by the SERVER.
   *
   * A script in custom head code cannot durably set these. It runs at parse time, but React
   * strips attributes it does not know about when it hydrates `<html>` — so a pre-paint theme
   * stamp lands and is then silently removed, taking every `[data-theme=…]` rule with it.
   * (`suppressHydrationWarning` only silences the warning; it does not stop the correction.)
   * Rendering them server-side is the only way they survive — and it removes the flash of
   * unthemed content that a pre-paint script exists to avoid in the first place.
   */
  htmlAttributes?: Record<string, string>;
}

export default function RootLayoutShell({
  children,
  headElements,
  bodyClassName = 'font-sans antialiased',
  lang,
  htmlAttributes,
}: RootLayoutShellProps) {
  return (
    <html
      lang={lang} {...htmlAttributes}
      suppressHydrationWarning
    >
      <head>
        {headElements}
      </head>
      <body className={bodyClassName} suppressHydrationWarning>
        <DarkModeProvider>
          {children}
        </DarkModeProvider>
      </body>
    </html>
  );
}
