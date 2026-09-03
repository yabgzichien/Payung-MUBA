'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { IconCheck, IconWarn } from '../_lib/Icons';
import { contracts, describeJudgment, preciseProtectionAvailable, usd, usdWhole } from '../_lib/format';
import type { QuoteCard } from '../_lib/types';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

/** The premium as a share of protected value — the number that makes a price mean something. */
function CostLine({ quote }: { quote: QuoteCard }) {
  const j = describeJudgment(quote.judgment);
  return (
    <div className={styles.costBlock}>
      <div className={styles.costMain}>
        <span className={[styles.costValue, 'num'].join(' ')}>{usd(quote.costUsd)}</span>
        <span className={[styles.verdict, styles[`verdict_${j.tone}`]].join(' ')}>{j.label}</span>
      </div>
      <p className={styles.costSub}>{j.sentence}</p>
    </div>
  );
}

export default function ProtectionResultsPage() {
  const router = useRouter();
  const { goal, recommendedQuote, cheaperQuote, rollEstimate, selectQuote, fetchResults, hydrated } =
    useProtectionFlow();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!goal) {
      router.replace('/protect');
      return;
    }
    if (recommendedQuote) return;
    setLoading(true);
    setError(null);
    fetchResults().then((outcome) => {
      setLoading(false);
      if (!outcome.ok) setError(outcome.error);
    });
    // Only re-run when the goal identity changes or on first mount with no quote yet — fetchResults
    // itself is stable (useCallback) and re-including it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, recommendedQuote, hydrated]);

  function choose(quote: QuoteCard) {
    selectQuote(quote);
    router.push('/protect/confirm');
  }

  function retry() {
    setLoading(true);
    setError(null);
    fetchResults().then((outcome) => {
      setLoading(false);
      if (!outcome.ok) setError(outcome.error);
    });
  }

  if (!hydrated) return <Shell step="results" />;
  if (!goal) return null;

  const goalLine = (
    <p className={styles.subtitle}>
      Based on your goal: <span className="num">{contracts(goal.quantity)}</span> {goal.asset} ·{' '}
      <span className="num">{usdWhole(goal.floorUsd)}</span> protected price · <span className="num">{goal.days}</span> days
    </p>
  );

  if (loading) {
    return (
      <Shell step="results">
        <h1 className={ui.title}>Payung found protection for you</h1>
        {goalLine}
        <div className={ui.loadingNote}>
          <span className={ui.spinner} /> Reading the live Thetanuts book…
        </div>
      </Shell>
    );
  }

  /**
   * The old empty state was a red error box and a single link. It is now the
   * most likely first-run outcome for a goal the book cannot fill, so it has
   * to offer a way forward rather than just naming the failure.
   */
  if (error || !recommendedQuote) {
    return (
      <Shell step="results">
        <h1 className={ui.title}>No match at this protected price yet</h1>
        {goalLine}
        <div className={styles.emptyCard}>
          <span className={styles.emptyIcon}>
            <IconWarn size={22} />
          </span>
          <p className={styles.emptyBody}>
            {error ?? "Nothing on the live book covers this protected price and timeframe right now."} The book moves
            constantly, so a nearby protected price or a slightly different horizon usually has liquidity.
          </p>
          <div className={styles.emptyActions}>
            <Link className={ui.btnPrimary} href="/protect/explore">
              Explore nearby protected prices
            </Link>
            <button className={ui.btnOutline} onClick={retry}>
              Check the book again
            </button>
            <Link className={ui.linkBack} href="/protect">
              ← Change my goal
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const partial = recommendedQuote.coverageLabel === 'Partial';

  return (
    <Shell step="results">
      <h1 className={ui.title}>Payung found protection for you</h1>
      {goalLine}

      <div className={[styles.quoteCard, styles.quoteCardRecommended].join(' ')}>
        <p className={styles.quoteLabel}>
          Recommended · {recommendedQuote.coverageLabel === 'Full' ? 'Full coverage' : 'Best available'}
        </p>

        <CostLine quote={recommendedQuote} />

        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Protecting</span>
            <span className={[styles.rowValue, 'num'].join(' ')}>
              {contracts(recommendedQuote.contracts)} {goal.asset}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Protected price</span>
            <span className={[styles.rowValue, styles.rowValueGold, 'num'].join(' ')}>
              {usdWhole(recommendedQuote.floorUsd)}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Coverage</span>
            <span className={[styles.rowValue, partial ? styles.rowValueWarn : styles.rowValueOk].join(' ')}>
              {partial ? <IconWarn size={15} /> : <IconCheck size={15} />}
              {recommendedQuote.coverageLabel} · <span className="num">{recommendedQuote.coverageDetail}</span>
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Expiry</span>
            <span className={styles.rowValue}>{recommendedQuote.expiryNote}</span>
          </div>
        </div>

        <p className={styles.note}>{recommendedQuote.note}</p>

        {recommendedQuote.contracts < goal.quantity * 0.98 && (
          <p className={[styles.note, styles.noteWarn].join(' ')}>
            Live liquidity only covers <span className="num">{contracts(recommendedQuote.contracts)}</span> of your{' '}
            <span className="num">{contracts(goal.quantity)}</span> {goal.asset} right now.
          </p>
        )}

        {partial && (
          <div className={styles.calloutWarn}>
            <IconWarn size={18} />
            <span>
              This option {recommendedQuote.expiryNote.toLowerCase()}. To cover your full{' '}
              <span className="num">{goal.days}</span>-day horizon automatically, set up Precise Protection below.
            </span>
          </div>
        )}

        <button className={ui.btnPrimary} onClick={() => choose(recommendedQuote)}>
          Select this protection
        </button>
      </div>

      {cheaperQuote && (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Cheaper alternative</p>
          <CostLine quote={cheaperQuote} />
          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Protected price</span>
              <span className={[styles.rowValue, styles.rowValueGold, 'num'].join(' ')}>
                {usdWhole(cheaperQuote.floorUsd)}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Coverage</span>
              <span className={[styles.rowValue, styles.rowValueWarn].join(' ')}>
                <IconWarn size={15} />
                {cheaperQuote.coverageLabel}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Expiry</span>
              <span className={styles.rowValue}>{cheaperQuote.expiryNote}</span>
            </div>
          </div>
          <p className={[styles.note, styles.noteWarn].join(' ')}>{cheaperQuote.note}</p>
          <button className={ui.btnOutline} onClick={() => choose(cheaperQuote)}>
            Choose this instead
          </button>
        </div>
      )}

      {rollEstimate ? (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Or chain shorter puts</p>
          <div className={styles.rows}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>First contract (real, live offer)</span>
              <span className={[styles.rowValue, 'num'].join(' ')}>
                {usdWhole(rollEstimate.anchorLeg.strike)} protected price
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>First contract cost</span>
              <span className={[styles.rowValue, 'num'].join(' ')}>{usd(rollEstimate.anchorPremiumUsd)}</span>
            </div>
          </div>
          <div className={styles.estimateBox}>
            <p className={styles.estimateHeadline}>
              <span className="num">~{usd(rollEstimate.estimatedTotalPremiumUsd)}</span> estimated to reach your full{' '}
              <span className="num">{goal.days}</span>-day protected price
            </p>
            <p className={styles.estimateSub}>
              <strong>Estimated, not a live quote.</strong> Theoretical cost over roughly{' '}
              <span className="num">{rollEstimate.estimatedLegs}</span> roll
              {rollEstimate.estimatedLegs === 1 ? '' : 's'}; the real cost depends on the book each time you roll.
            </p>
          </div>
          <div className={styles.rollEstimateActions}>
            {preciseProtectionAvailable ? (
              <>
                <button className={ui.btnPrimary} onClick={() => router.push('/protect/precise-setup')}>
                  Set up Precise Protection
                </button>
                <button className={ui.btnOutline} onClick={() => choose(rollEstimate.anchorQuote)}>
                  Just buy this first contract
                </button>
              </>
            ) : (
              <>
                <button className={ui.btnPrimary} onClick={() => choose(rollEstimate.anchorQuote)}>
                  Buy this first contract
                </button>
                <p className={styles.note}>
                  Automated rolling isn&apos;t enabled on this deployment yet. Buy the first contract now and roll it
                  yourself from My Protection.
                </p>
              </>
            )}
          </div>
        </div>
      ) : partial && preciseProtectionAvailable ? (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Or chain shorter puts</p>
          <p className={styles.note}>
            No single option on the book covers your full <span className="num">{goal.days}</span>-day horizon. Precise
            Protection rolls your protected price forward automatically from a Safe smart account you own.
          </p>
          <button className={ui.btnPrimary} onClick={() => router.push('/protect/precise-setup')}>
            Set up Precise Protection
          </button>
        </div>
      ) : null}

      <Link className={ui.linkBack} href="/protect/explore">
        Want a different protected price? Explore protection →
      </Link>
    </Shell>
  );
}
