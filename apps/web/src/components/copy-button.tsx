'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * The copy button. **The only client component in this dashboard.**
 *
 * ## Why it is worth the client bundle it costs
 *
 * §9 of the brief: "Do not make the user select text manually." That sounds cosmetic
 * and is not. The workflow this console exists to serve ends with the operator pasting
 * a draft into X; a manual selection of a multi-paragraph draft inside a scrolling
 * panel is where that workflow breaks, and a broken last step makes every step before
 * it worthless.
 *
 * It is also the *entire* reason the dashboard now ships JavaScript at all, which is
 * why it is one small component rather than a page-wide interactive layer. Everything
 * else — ranking, selection, tabs, the whole detail panel — stays server-rendered and
 * navigates by link. See `proxy.ts` for the CSP nonce that made hydration possible
 * without retiring `THREAT-MODEL.md` §T-7.
 *
 * ## Fallbacks, because clipboard access is not guaranteed
 *
 * `navigator.clipboard` requires a secure context and can be refused by permission
 * policy. On failure this selects the text into the page so the operator can still
 * copy by hand — a degraded path is not the same as a dead button, and a button that
 * silently does nothing is worse than no button.
 */

type Props = {
  readonly text: string;
  /** Turkish UI copy is the default; the drafts themselves stay English. */
  readonly label?: string;
  readonly doneLabel?: string;
  readonly wide?: boolean;
};

export function CopyButton({
  text,
  label = 'Kopyala',
  doneLabel = 'Kopyalandı ✓',
  wide = false,
}: Props) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const button = useRef<HTMLButtonElement | null>(null);

  const flash = useCallback((next: 'done' | 'failed') => {
    setState(next);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState('idle');
    }, 2000);
  }, []);

  /**
   * Select the draft in the page so a manual copy is one keystroke away.
   *
   * The fallback has to *do* something. Verified in the browser: when the clipboard
   * write is refused — no user gesture, insecure origin, or a permission policy — the
   * button previously changed its own label and left the operator to find and select
   * several paragraphs by hand inside a scrolling panel. Telling someone to select
   * text manually is not a fallback; selecting it for them is.
   */
  const selectDraft = useCallback(() => {
    const article = button.current?.closest('.draft');
    const pre = article?.querySelector('.draft-text');
    if (pre === null || pre === undefined) return;

    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  const copy = useCallback(() => {
    // Optional chaining rather than a feature test: `navigator.clipboard` is undefined
    // on an insecure origin, which is exactly the case a plain `if` tends to miss.
    if (navigator.clipboard === undefined) {
      selectDraft();
      flash('failed');
      return;
    }

    void navigator.clipboard
      .writeText(text)
      .then(() => {
        flash('done');
      })
      .catch(() => {
        selectDraft();
        flash('failed');
      });
  }, [text, flash, selectDraft]);

  return (
    <button
      ref={button}
      type="button"
      onClick={copy}
      className={`btn ${state === 'done' ? 'is-done' : ''} ${wide ? 'btn-wide' : ''}`}
      aria-live="polite"
    >
      {state === 'done' ? doneLabel : state === 'failed' ? 'Seçildi — ⌘/Ctrl+C' : label}
    </button>
  );
}
