'use client';

import { useEffect, useRef, useState } from 'react';

type RevealTag = 'div' | 'span' | 'p' | 'h1' | 'h2';

/**
 * Fades + rises children into place the first time they cross into the
 * viewport. Elements already on screen at mount (e.g. the hero) reveal
 * immediately, so this doubles as a load-in animation without a second code
 * path. `.reveal` / `.reveal-visible` live in globals.css (not a CSS module)
 * so every page can opt in without importing a matching stylesheet.
 */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
}: {
  children: React.ReactNode;
  delay?: number;
  as?: RevealTag;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // A backgrounded tab (opened via middle-click, or a browser that defers
    // rendering off-screen) throttles IntersectionObserver indefinitely, so
    // above-the-fold content could stay invisible until the tab is focused.
    // A synchronous rect check catches that case immediately on mount.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -10% 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={['reveal', visible ? 'reveal-visible' : '', className].filter(Boolean).join(' ')}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
