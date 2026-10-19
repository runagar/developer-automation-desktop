import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './TooltipLayer.css';

/*
 * Replaces native `title` tooltips app-wide. Chromium draws those as separate
 * OS windows that linger after the pointer leaves — under WSLg long enough for
 * two to be on screen at once — and a page cannot shorten that. While an
 * element is hovered its `title` is held here, so no native tooltip opens, and
 * put back the moment the pointer leaves.
 *
 * An element marked `data-tooltip-overflow` gates the tooltip of the titled
 * element containing it: shown only while that text is cut off.
 */

const SHOW_DELAY_MS = 500;
const WARM_MS = 300;
const CURSOR_OFFSET_PX = 16;
const VIEWPORT_MARGIN_PX = 4;

interface Shown {
  text: string;
  x: number;
  y: number;
}

function isTruncated(el: Element): boolean {
  return el.scrollWidth > el.clientWidth;
}

function wantsTooltip(el: Element): boolean {
  const gates = Array.from(el.querySelectorAll('[data-tooltip-overflow]'));
  if (el.hasAttribute('data-tooltip-overflow')) gates.push(el);
  return gates.length === 0 || gates.some(isTruncated);
}

export default function TooltipLayer(): React.ReactElement | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: Element | null = null;
    let text = '';
    let timer: number | undefined;
    let visible = false;
    let warmUntil = 0;
    const pointer = { x: 0, y: 0 };

    const hide = (): void => {
      window.clearTimeout(timer);
      if (visible) warmUntil = Date.now() + WARM_MS;
      visible = false;
      setShown(null);
    };

    const observer = new MutationObserver(() => {
      if (!current?.hasAttribute('title')) return;
      text = current.getAttribute('title') ?? '';
      current.removeAttribute('title');
      if (visible) setShown((s) => (s ? { ...s, text } : s));
    });

    const release = (): void => {
      hide();
      observer.disconnect();
      if (current?.isConnected && !current.hasAttribute('title')) current.setAttribute('title', text);
      current = null;
    };

    const show = (): void => {
      if (!current?.isConnected || !text || !wantsTooltip(current)) return;
      visible = true;
      setShown({ text, x: pointer.x, y: pointer.y });
    };

    const adopt = (el: Element): void => {
      release();
      current = el;
      text = el.getAttribute('title') ?? '';
      el.removeAttribute('title');
      observer.observe(el, { attributes: true, attributeFilter: ['title'] });
      timer = window.setTimeout(show, Date.now() < warmUntil ? 0 : SHOW_DELAY_MS);
    };

    const onPointerOver = (e: PointerEvent): void => {
      if (!(e.target instanceof Element)) return;
      const titled = e.target.closest('[title]');
      const insideCurrent = current?.contains(e.target) && (!titled || titled.contains(current));
      if (insideCurrent) return;
      if (titled) adopt(titled);
      else release();
    };

    const onPointerOut = (e: PointerEvent): void => {
      if (!e.relatedTarget) release();
    };

    const onPointerMove = (e: PointerEvent): void => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('keydown', hide, true);
    window.addEventListener('blur', release);
    return () => {
      release();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('wheel', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', release);
    };
  }, []);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!shown || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - VIEWPORT_MARGIN_PX - width;
    const below = shown.y + CURSOR_OFFSET_PX;
    const fitsBelow = below + height <= window.innerHeight - VIEWPORT_MARGIN_PX;
    el.style.left = `${Math.max(VIEWPORT_MARGIN_PX, Math.min(shown.x, maxLeft))}px`;
    el.style.top = `${fitsBelow ? below : Math.max(VIEWPORT_MARGIN_PX, shown.y - height - VIEWPORT_MARGIN_PX)}px`;
  }, [shown]);

  if (!shown) return null;
  return (
    <div ref={tooltipRef} className="tooltip-layer" role="tooltip">
      {shown.text}
    </div>
  );
}
