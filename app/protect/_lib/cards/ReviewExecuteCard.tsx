'use client';

import { useChatFlow } from '../ChatFlow';
import { IconWarn } from '../Icons';
import { contracts, describeJudgment, usd, usdWhole } from '../format';
import ui from '../ui.module.css';
import styles from '../../review/page.module.css';

/**
 * Combines the old review page's simulate -> passed -> executing phases into
 * one card, since the previous chat card already handled wallet connection.
 * "Simulate & buy" chains preflight straight into execution instead of
 * requiring a second click — one fewer step than the standalone page, which
 * fits a conversation better than a two-stage form.
 */
export function ReviewExecuteCard() {
  const {
    goal,
    selectedQuote,
    executionStep,
    reviewPhase,
    reviewError,
    reviewPartiallyExecuted,
    handleSimulateAndExecute,
    handleExecute,
  } = useChatFlow();

  if (!goal || !selectedQuote) return null;

  if (reviewPhase === 'done') {
    return (
      <div className={styles.passedWrap}>
        <p className={styles.passedBody}>Simulated, signed, and confirmed on-chain.</p>
      </div>
    );
  }

  if (reviewPhase === 'executing') {
    return (
      <div className={styles.passedWrap}>
        <div className={ui.loadingNote} style={{ justifyContent: 'center', marginBottom: 12 }}>
          <span className={ui.spinner} />
        </div>
        <h2 className={styles.passedTitle}>{executionStep ?? 'Sending transaction…'}</h2>
        <p className={styles.passedBody}>Confirm each request in your wallet. This can take a few steps.</p>
      </div>
    );
  }

  if (reviewPhase === 'passed') {
    return (
      <div>
        <div className={styles.passedWrap}>
          <h2 className={styles.passedTitle}>Ready to continue</h2>
          <p className={styles.passedBody}>
            Payung will pick up exactly where it stopped: confirmed steps are not repeated.
          </p>
        </div>
        {reviewError && (
          <div className={ui.errorBox}>
            <IconWarn size={18} />
            <span>{reviewError}</span>
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
          {reviewPartiallyExecuted ? 'Resume and finish' : 'Try again'}
        </button>
      </div>
    );
  }

  const judgment = describeJudgment(selectedQuote.judgment);
  return (
    <div>
      {reviewError && (
        <div className={ui.errorBox}>
          <IconWarn size={18} />
          <span>{reviewError}</span>
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
      <div className={styles.payCard}>
        <p className={styles.payLabel}>You will pay</p>
        <p className={[styles.payValue, 'num'].join(' ')}>{usd(selectedQuote.costUsd)}</p>
        <p className={styles.payMeta}>
          {judgment.sentence} · Live {selectedQuote.protocol} option on {selectedQuote.network}
        </p>
      </div>
      <button className={ui.btnPrimary} onClick={handleSimulateAndExecute} disabled={reviewPhase === 'simulating'}>
        {reviewPhase === 'simulating' ? (
          <>
            <span className={ui.spinner} /> Simulating…
          </>
        ) : (
          'Simulate & buy'
        )}
      </button>
    </div>
  );
}
