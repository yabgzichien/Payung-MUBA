'use client';

import Link from 'next/link';
import { useChatFlow } from '../ChatFlow';
import { ExplorePanel } from '../ExplorePanel';
import { IconCheck, IconWarn } from '../Icons';
import { contracts, describeJudgment, preciseProtectionAvailable, usd, usdWhole } from '../format';
import type { QuoteCard } from '../types';
import ui from '../ui.module.css';
import styles from '../../results/page.module.css';

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

export function QuoteOptionsCard() {
  const { goal, recommendedQuote, cheaperQuote, rollEstimate, exploreOpen, setExploreOpen, handleSelectQuote, handleExploreUseFloor } =
    useChatFlow();

  if (!goal || !recommendedQuote) return null;
  const partial = recommendedQuote.coverageLabel === 'Partial';

  return (
    <div>
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

        <button className={ui.btnPrimary} onClick={() => handleSelectQuote(recommendedQuote)}>
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
          <button className={ui.btnOutline} onClick={() => handleSelectQuote(cheaperQuote)}>
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
                <Link className={ui.btnPrimary} href="/protect/precise-setup">
                  Set up Precise Protection
                </Link>
                <button className={ui.btnOutline} onClick={() => handleSelectQuote(rollEstimate.anchorQuote)}>
                  Just buy this first contract
                </button>
              </>
            ) : (
              <>
                <button className={ui.btnPrimary} onClick={() => handleSelectQuote(rollEstimate.anchorQuote)}>
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
            No single option on the book covers your full <span className="num">{goal.days}</span>-day horizon.
            Precise Protection rolls your protected price forward automatically from a Safe smart account you own.
          </p>
          <Link className={ui.btnPrimary} href="/protect/precise-setup">
            Set up Precise Protection
          </Link>
        </div>
      ) : null}

      {exploreOpen ? (
        <div className={styles.quoteCard}>
          <p className={[styles.quoteLabel, styles.quoteLabelMuted].join(' ')}>Explore other protected prices</p>
          <ExplorePanel goal={goal} compact onUseFloor={handleExploreUseFloor} />
        </div>
      ) : (
        <button className={ui.btnOutline} onClick={() => setExploreOpen(true)}>
          Explore other protected prices
        </button>
      )}
    </div>
  );
}
