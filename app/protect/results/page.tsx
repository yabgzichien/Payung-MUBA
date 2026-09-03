'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import type { QuoteCard } from '../_lib/types';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

export default function ProtectionResultsPage() {
  const router = useRouter();
  const { goal, recommendedQuote, cheaperQuote, rollEstimate, selectQuote, fetchResults } = useProtectionFlow();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!goal) {
      router.replace('/protect');
      return;
    }
    if (recommendedQuote) return;
    setLoading(true);
    fetchResults().then((outcome) => {
      setLoading(false);
      if (!outcome.ok) setError(outcome.error);
    });
    // Only re-run when the goal identity changes or on first mount with no quote yet — fetchResults
    // itself is stable (useCallback) and re-including it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, recommendedQuote]);

  function choose(quote: QuoteCard) {
    selectQuote(quote);
    router.push('/protect/confirm');
  }

  if (!goal) return null;

  if (loading) {
    return (
      <Shell step="results">
        <h1 className={ui.title}>Payung found protection for you</h1>
        <p className={styles.subtitle}>
          Based on your goal: {goal.quantity} {goal.asset} · ${goal.floorUsd.toLocaleString()} floor · {goal.days} days
        </p>
        <div className={ui.loadingNote}>
          <span className={ui.spinner} /> Checking live Thetanuts options…
        </div>
      </Shell>
    );
  }

  if (error || !recommendedQuote) {
    return (
      <Shell step="results">
        <h1 className={ui.title}>Payung found protection for you</h1>
        <p className={styles.subtitle}>
          Based on your goal: {goal.quantity} {goal.asset} · ${goal.floorUsd.toLocaleString()} floor · {goal.days} days
        </p>
        <div className={ui.errorBox}>{error ?? 'No live protection matches your goal right now.'}</div>
        <Link className={ui.linkBack} href="/protect/explore">
          Try a different floor →
        </Link>
      </Shell>
    );
  }

  return (
    <Shell step="results">
      <h1 className={ui.title}>Payung found protection for you</h1>
      <p className={styles.subtitle}>
        Based on your goal: {goal.quantity} {goal.asset} · ${goal.floorUsd.toLocaleString()} floor · {goal.days} days
      </p>

      <div className={[styles.quoteCard, styles.quoteCardRecommended].join(' ')}>
        <p className={styles.quoteLabel}>
          Recommended · {recommendedQuote.coverageLabel === 'Full' ? 'Full coverage' : 'Best available'}
        </p>
        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Protecting:</span>
            <span className={styles.rowValue}>
              {recommendedQuote.contracts.toFixed(4)} {goal.asset}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Protection floor:</span>
            <span className={styles.rowValue}>${recommendedQuote.floorUsd.toLocaleString()}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Coverage:</span>
            <span className={[styles.rowValue, styles.rowValueOk].join(' ')}>
              ✓ {recommendedQuote.coverageLabel} · {recommendedQuote.coverageDetail}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Cost:</span>
            <span className={styles.rowValue}>${recommendedQuote.costUsd.toFixed(2)}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Expiry:</span>
            <span className={styles.rowValue}>{recommendedQuote.expiryNote}</span>
          </div>
        </div>
        <p className={styles.note}>{recommendedQuote.note}</p>
        {recommendedQuote.contracts < goal.quantity * 0.98 && (
          <p className={[styles.note, styles.noteWarn].join(' ')}>
            Live liquidity only covers {recommendedQuote.contracts.toFixed(4)} of your {goal.quantity} {goal.asset} right now.
          </p>
        )}
        {recommendedQuote.coverageLabel === 'Partial' && (
          <div style={{ margin: '0.75rem 0', padding: '0.6rem 0.8rem', background: 'rgba(234, 179, 8, 0.1)', borderRadius: '6px', border: '1px solid rgba(234, 179, 8, 0.25)' }}>
            <p className={[styles.note, styles.noteWarn].join(' ')} style={{ margin: 0 }}>
              ⚠️ Ends {recommendedQuote.expiryNote.toLowerCase()}. To cover your full {goal.days}-day horizon automatically, set up Precise Protection below.
            </p>
          </div>
        )}
        <button className={ui.btnPrimary} onClick={() => choose(recommendedQuote)}>
          Select protection →
        </button>
      </div>

      {cheaperQuote && (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Cheaper alternative</p>
          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Protection floor:</span>
              <span className={styles.rowValue}>${cheaperQuote.floorUsd.toLocaleString()}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Coverage:</span>
              <span className={[styles.rowValue, styles.rowValueWarn].join(' ')}>⚠ {cheaperQuote.coverageLabel}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Cost:</span>
              <span className={styles.rowValue}>${cheaperQuote.costUsd.toFixed(2)}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Expiry:</span>
              <span className={styles.rowValue}>{cheaperQuote.expiryNote}</span>
            </div>
          </div>
          <p className={[styles.note, styles.noteWarn].join(' ')}>{cheaperQuote.note}</p>
          <button className={ui.btnOutline} onClick={() => choose(cheaperQuote)}>
            View this option →
          </button>
        </div>
      )}

      {rollEstimate ? (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Or chain shorter puts</p>
          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>First leg — real, live offer:</span>
              <span className={styles.rowValue}>
                ${rollEstimate.anchorLeg.strike.toLocaleString()} floor · {rollEstimate.anchorQuote.expiryNote}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>First leg cost:</span>
              <span className={styles.rowValue}>${rollEstimate.anchorPremiumUsd.toFixed(2)}</span>
            </div>
          </div>
          <div className={styles.rollEstimateActions}>
            <button className={ui.btnOutline} onClick={() => choose(rollEstimate.anchorQuote)}>
              Buy this first leg →
            </button>
            <button className={ui.btnPrimary} onClick={() => router.push('/protect/precise-setup')}>
              Set up Precise Protection →
            </button>
          </div>
          <div className={styles.estimateBox}>
            <p className={styles.estimateHeadline}>
              ~${rollEstimate.estimatedTotalPremiumUsd.toFixed(2)} estimated to reach your full {goal.days}-day floor
            </p>
            <p className={styles.estimateSub}>
              ESTIMATED — theoretical, not a live quote. Actual cost depends on the book each time you roll.
              ≈{rollEstimate.estimatedLegs} roll{rollEstimate.estimatedLegs === 1 ? '' : 's'} to your deadline.
            </p>
          </div>
          <Link className={ui.linkBack} href="/my-protection">
            Manage rolls from My Protection →
          </Link>
        </div>
      ) : recommendedQuote.coverageLabel === 'Partial' ? (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Or chain shorter puts</p>
          <p className={styles.note}>
            No single option on the book covers your full {goal.days}-day horizon. Set up Precise Protection to automatically roll your floor forward using a self-custodied Safe smart account.
          </p>
          <button className={ui.btnPrimary} style={{ marginTop: '0.75rem' }} onClick={() => router.push('/protect/precise-setup')}>
            Set up Precise Protection →
          </button>
        </div>
      ) : null}

      <Link className={ui.linkBack} href="/protect/explore">
        Want a different floor? Explore protection →
      </Link>
    </Shell>
  );
}
