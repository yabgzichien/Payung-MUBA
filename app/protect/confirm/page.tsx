'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { PayoffChart } from '../_lib/PayoffChart';
import { IconSelfCustody } from '../_lib/Icons';
import { fetchSpotPrice } from '../_lib/api';
import { contracts, describeJudgment, usd, usdWhole } from '../_lib/format';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

export default function ConfirmProtectionPage() {
  const router = useRouter();
  const { goal, selectedQuote, hydrated } = useProtectionFlow();
  const [spot, setSpot] = useState<number | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    if (!selectedQuote || !goal) router.replace('/protect/results');
  }, [selectedQuote, goal, router, hydrated]);

  useEffect(() => {
    if (!goal) return;
    fetchSpotPrice(goal.asset).then(setSpot);
  }, [goal]);

  if (!hydrated) return <Shell step="confirm" />;
  if (!selectedQuote || !goal) return null;

  const judgment = describeJudgment(selectedQuote.judgment);

  return (
    <Shell step="confirm">
      <h1 className={ui.title}>Confirm your protection</h1>
      <p className={ui.subtitle}>This is exactly what you are buying, and what it pays.</p>

      <div className={styles.summaryCard}>
        <div className={styles.summaryGrid}>
          <div>
            <p className={styles.summaryLabel}>Protecting</p>
            <p className={[styles.summaryValue, 'num'].join(' ')}>
              {contracts(selectedQuote.contracts)} {goal.asset}
            </p>
          </div>
          <div>
            <p className={styles.summaryLabel}>Protected price</p>
            <p className={[styles.summaryValue, styles.summaryValueGold, 'num'].join(' ')}>
              {usdWhole(selectedQuote.floorUsd)}
            </p>
          </div>
          <div>
            <p className={styles.summaryLabel}>You pay</p>
            <p className={[styles.summaryValue, 'num'].join(' ')}>{usd(selectedQuote.costUsd)}</p>
            <p className={styles.summaryFoot}>{judgment.sentence}</p>
          </div>
        </div>
        <p className={styles.metaLine}>
          {selectedQuote.expiryNote} · Live {selectedQuote.protocol} option on {selectedQuote.network}
        </p>
      </div>

      <h2 className={styles.sectionTitle}>What this pays you</h2>
      {selectedQuote.payoff.length > 1 ? (
        <PayoffChart
          payoff={selectedQuote.payoff}
          floorUsd={selectedQuote.floorUsd}
          asset={goal.asset}
          spot={spot}
          premiumUsd={selectedQuote.costUsd}
        />
      ) : (
        <div className={styles.meansBox}>
          <p className={styles.meansTitle}>
            If {goal.asset} settles below {usdWhole(selectedQuote.floorUsd)} at expiry
          </p>
          <p className={styles.meansBody}>
            Your protection pays the difference between the protected price and the settlement price, on{' '}
            {contracts(selectedQuote.contracts)} {goal.asset}. If it settles above, the option expires worthless and
            your total cost stays {usd(selectedQuote.costUsd)}.
          </p>
        </div>
      )}

      <div className={styles.assurance}>
        <IconSelfCustody size={20} />
        <p>
          Your {goal.asset} never moves. You are buying an option that pays you if the price falls: the underlying
          stays in your wallet, and the most you can lose is the {usd(selectedQuote.costUsd)} premium.
        </p>
      </div>

      <button className={ui.btnPrimary} onClick={() => router.push('/protect/connect')}>
        Continue to wallet
      </button>
      <Link className={[ui.linkBack, styles.backLink].join(' ')} href="/protect/results">
        ← Back to protection options
      </Link>
    </Shell>
  );
}
