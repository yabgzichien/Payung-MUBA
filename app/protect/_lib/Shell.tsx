'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import styles from './Shell.module.css';
import { useProtectionFlow } from './FlowState';

const STEPS = [
  { key: 'goal', label: 'State your goal' },
  { key: 'results', label: 'Choose protection' },
  { key: 'confirm', label: 'Confirm protection' },
  { key: 'connect', label: 'Connect wallet' },
  { key: 'review', label: 'Review & confirm' },
] as const;

const STEP_ROUTES: Record<(typeof STEPS)[number]['key'], string> = {
  goal: '/protect',
  results: '/protect/results',
  confirm: '/protect/confirm',
  connect: '/protect/connect',
  review: '/protect/review',
};

function BrandIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 15a10 10 0 0 1 20 0"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M14 15v6.5a2.5 2.5 0 0 1-4 2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function StepTracker({ current }: { current: (typeof STEPS)[number]['key'] }) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <nav className={styles.trackerWrap} aria-label="Progress">
      {/*
        Below ~720px the five full labels need ~1000px and used to simply
        overflow the viewport. The scroller keeps the real tracker usable on a
        phone, and the compact line states position for anyone who cannot see
        the scrolled-off steps at all.
      */}
      <p className={styles.trackerCompact}>
        Step <span className="num">{currentIndex + 1}</span> of <span className="num">{STEPS.length}</span> ·{' '}
        {STEPS[currentIndex]?.label}
      </p>
      <ol className={styles.tracker}>
      {STEPS.map((step, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        const reachable = i <= currentIndex;

        const dot = (
          <div
            className={[styles.stepDot, done && styles.stepDotDone, active && styles.stepDotActive]
              .filter(Boolean)
              .join(' ')}
          >
            {done ? '✓' : i + 1}
          </div>
        );
        const label = (
          <span
            className={[styles.stepLabel, active && styles.stepLabelActive, done && styles.stepLabelDone]
              .filter(Boolean)
              .join(' ')}
          >
            {step.label}
          </span>
        );

        return (
          <li className={styles.step} key={step.key} aria-current={active ? 'step' : undefined}>
            {reachable ? (
              <Link href={STEP_ROUTES[step.key]} className={styles.stepLink}>
                {dot}
                {label}
              </Link>
            ) : (
              <span className={styles.stepLink}>
                {dot}
                {label}
              </span>
            )}
            {i < STEPS.length - 1 && (
              <div className={[styles.stepLine, done && styles.stepLineDone].filter(Boolean).join(' ')} aria-hidden="true" />
            )}
          </li>
        );
      })}
      </ol>
    </nav>
  );
}

export function Header() {
  const pathname = usePathname();
  const { wallet, connectWallet } = useProtectionFlow();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const isProtect = pathname === '/' || pathname.startsWith('/protect');
  const isMyProtection = pathname.startsWith('/my-protection');

  /**
   * This used to be `connectWallet().catch(() => {})`. A rejected signature, a
   * missing wallet, and a failed network switch all produced a button that
   * simply did nothing — the user had no way to tell a broken app from a
   * refused prompt.
   */
  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      await connectWallet();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandIcon}>
            <BrandIcon />
          </span>
          Payung
        </Link>
        <nav className={styles.nav}>
          <Link href="/protect" className={[styles.navLink, isProtect && styles.navLinkActive].filter(Boolean).join(' ')}>
            Protect
          </Link>
          <Link
            href="/my-protection"
            className={[styles.navLink, isMyProtection && styles.navLinkActive].filter(Boolean).join(' ')}
          >
            My Protection
          </Link>
          <Link href="/#how-it-works" className={[styles.navLink, styles.navLinkOptional].join(' ')}>
            How it works
          </Link>
        </nav>
        <div className={styles.right}>
          {wallet.connected && wallet.address ? (
            <span className={[styles.walletPill, 'num'].join(' ')}>
              {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
            </span>
          ) : (
            <button className={styles.connectBtn} onClick={handleConnect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
          )}
        </div>
      </header>
      {connectError && (
        <div className={styles.headerError} role="alert">
          <span>{connectError}</span>
          <button className={styles.headerErrorClose} onClick={() => setConnectError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </>
  );
}

export function Shell({
  step,
  wide,
  children,
}: {
  step?: (typeof STEPS)[number]['key'];
  /** The chat page carries more per-screen content than the wizard steps. */
  wide?: boolean;
  /** Optional so a page can render the chrome alone while it rehydrates. */
  children?: React.ReactNode;
}) {
  return (
    <div>
      <Header />
      {step && <StepTracker current={step} />}
      <main className={[styles.main, wide && styles.mainWide].filter(Boolean).join(' ')}>{children}</main>
    </div>
  );
}

export { STEPS, STEP_ROUTES };
