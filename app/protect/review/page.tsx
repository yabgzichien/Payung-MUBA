'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { IconCheck, IconWarn } from '../_lib/Icons';
import { contracts, describeJudgment, usd, usdWhole } from '../_lib/format';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

type Phase = 'review' | 'checking' | 'passed' | 'executing' | 'error';

export default function ReviewCheckPage() {
  const router = useRouter();
  const { goal, selectedQuote, wallet, executionStep, runPreflight, executeProtection, hydrated } =
    useProtectionFlow();
  const [phase, setPhase] = useState<Phase>('review');
  const [error, setError] = useState<string | null>(null);
  /** Set once any step has confirmed on-chain, so the retry copy can say so. */
  const [partiallyExecuted, setPartiallyExecuted] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    if (!selectedQuote) {
      router.replace('/protect/results');
      return;
    }
    if (!wallet.connected || !wallet.chainOk) {
      router.replace('/protect/connect');
    }
  }, [selectedQuote, wallet.connected, wallet.chainOk, router, hydrated]);

  if (!hydrated) return <Shell step="review" />;
  if (!goal || !selectedQuote) return null;

  async function handleCheck() {
    setPhase('checking');
    setError(null);
    const outcome = await runPreflight();
    if (!outcome.ok) {
      setError(outcome.error);
      setPhase('error');
      return;
    }
    setPhase('passed');
  }

  async function handleExecute() {
    setPhase('executing');
    setError(null);
    const outcome = await executeProtection();
    if (!outcome.ok) {
      setError(outcome.error);
      // executeProtection() resumes rather than replays, so a retry here is
      // safe: already-confirmed steps (notably the Aave supply) are skipped.
      setPartiallyExecuted(/already confirmed on-chain/.test(outcome.error));
      setPhase('passed');
      return;
    }
    router.push('/protect/purchased');
  }

  if (phase === 'passed') {
    return (
      <Shell step="review">
        <div className={styles.passedWrap}>
          <div className={styles.passedIcon}>
            <IconCheck size={26} />
          </div>
          <h1 className={styles.passedTitle}>{error ? 'Ready to continue' : 'Check passed'}</h1>
          <p className={styles.passedBody}>
            {error
              ? 'Payung will pick up exactly where it stopped: confirmed steps are not repeated.'
              : "Payung pre-flighted your transaction against the live chain, and it's ready to sign. You'll confirm each step in your own wallet."}
          </p>
        </div>

        {error && (
          <div className={ui.errorBox}>
            <IconWarn size={18} />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.summaryCard}>
          <div>
            <p className={styles.label}>Protecting</p>
            <p className={[styles.value, 'num'].join(' ')}>
              {contracts(selectedQuote.contracts)} {goal.asset}
            </p>
          </div>
          <div>
            <p className={styles.label}>Protected price</p>
            <p className={[styles.value, styles.valueGold, 'num'].join(' ')}>{usdWhole(selectedQuote.floorUsd)}</p>
          </div>
        </div>
        <button className={ui.btnPrimary} onClick={handleExecute}>
          {partiallyExecuted ? 'Resume and finish' : error ? 'Try again' : 'Execute protection'}
        </button>
      </Shell>
    );
  }

  if (phase === 'executing') {
    return (
      <Shell step="review">
        <div className={styles.passedWrap}>
          <div className={ui.loadingNote} style={{ justifyContent: 'center', marginBottom: 12 }}>
            <span className={ui.spinner} />
          </div>
          <h1 className={styles.passedTitle}>{executionStep ?? 'Sending transaction…'}</h1>
          <p className={styles.passedBody}>Confirm each request in your wallet. This can take a few steps.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell step="review">
      <h1 className={ui.title}>Review & check</h1>
      <p className={ui.subtitle}>Review your protection before Payung checks it.</p>

      {error && <div className={ui.errorBox}>{error}</div>}

      <div className={styles.summaryCard}>
        <div>
          <p className={styles.label}>Protecting</p>
          <p className={[styles.value, 'num'].join(' ')}>
            {contracts(selectedQuote.contracts)} {goal.asset}
          </p>
        </div>
        <div>
          <p className={styles.label}>Protected price</p>
          <p className={[styles.value, styles.valueGold, 'num'].join(' ')}>{usdWhole(selectedQuote.floorUsd)}</p>
        </div>
      </div>

      <div className={styles.payCard}>
        <p className={styles.payLabel}>You will pay</p>
        <p className={[styles.payValue, 'num'].join(' ')}>{usd(selectedQuote.costUsd)}</p>
        <p className={styles.payMeta}>
          {describeJudgment(selectedQuote.judgment).sentence} · Live {selectedQuote.protocol} option on{' '}
          {selectedQuote.network}
        </p>
      </div>

      <div className={styles.actions}>
        <button className={ui.btnPrimary} onClick={handleCheck} disabled={phase === 'checking'}>
          {phase === 'checking' ? (
            <>
              <span className={ui.spinner} /> Checking…
            </>
          ) : (
            'Check protection'
          )}
        </button>
        <Link className={ui.linkBack} href="/protect/confirm" style={{ justifyContent: 'center' }}>
          ← Back to confirmation
        </Link>
      </div>
    </Shell>
  );
}
