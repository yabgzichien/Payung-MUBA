'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { IconCheck, IconExternal } from '../_lib/Icons';
import { contracts, usd, usdWhole } from '../_lib/format';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

export default function ProtectionPurchasedPage() {
  const router = useRouter();
  const { goal, selectedQuote, purchase, hydrated } = useProtectionFlow();

  /**
   * The receipt is restored from localStorage, so a refresh here no longer
   * discards the only copy of a real transaction hash. The redirect waits for
   * hydration for the same reason.
   */
  useEffect(() => {
    if (!hydrated) return;
    if (!purchase) router.replace('/protect');
  }, [purchase, hydrated, router]);

  if (!hydrated) return <Shell step="review" />;
  if (!purchase) return null;

  const shortHash = `${purchase.txHash.slice(0, 10)}…${purchase.txHash.slice(-8)}`;

  return (
    <Shell step="review">
      <div className={styles.head}>
        <div className={styles.icon}>
          <IconCheck size={28} />
        </div>
        <h1 className={styles.title}>Your protection is active</h1>
        <p className={styles.subtitle}>
          The transaction confirmed on Base. Your protected price is live from now until expiry.
        </p>
        <span className={styles.activePill}>
          <span className={styles.dot} />
          ACTIVE
        </span>
      </div>

      {selectedQuote && goal && (
        <div className={styles.statsRow}>
          <div className={styles.statCell}>
            <p className={styles.statLabel}>Protected price</p>
            <p className={[styles.statValue, styles.statValueGold, 'num'].join(' ')}>
              {usdWhole(selectedQuote.floorUsd)}
            </p>
          </div>
          <div className={styles.statCell}>
            <p className={styles.statLabel}>Protecting</p>
            <p className={[styles.statValue, 'num'].join(' ')}>
              {contracts(selectedQuote.contracts)} {goal.asset}
            </p>
          </div>
          <div className={styles.statCell}>
            <p className={styles.statLabel}>You paid</p>
            <p className={[styles.statValue, 'num'].join(' ')}>{usd(selectedQuote.costUsd)}</p>
          </div>
        </div>
      )}

      <div className={styles.receipt}>
        <div>
          <p className={styles.colTitle}>Transaction</p>
          <p className={[styles.hashRow, 'num'].join(' ')}>{shortHash}</p>
        </div>
        <a className={ui.btnOutline} href={purchase.explorerUrl} target="_blank" rel="noreferrer">
          View on BaseScan <IconExternal size={15} />
        </a>
      </div>

      {selectedQuote && goal && (
        <p className={styles.summaryLine}>
          {selectedQuote.coverageLabel} coverage · {selectedQuote.coverageDetail} ·{' '}
          {selectedQuote.expiryNote.toLowerCase()}
        </p>
      )}

      <div className={styles.actions}>
        <button className={ui.btnPrimary} onClick={() => router.push('/my-protection')}>
          View my protection
        </button>
        <button className={ui.btnOutline} onClick={() => router.push('/')}>
          Done
        </button>
      </div>

      <p className={ui.lockNote}>Your {goal?.asset ?? 'crypto'} never left your wallet.</p>
    </Shell>
  );
}
