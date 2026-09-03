'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { deployOrConnectSafe, fundSafe, enableModuleAndOpen } from '../_lib/safe';
import { fetchPrepareOpen } from '../_lib/api';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

const MODULE_ADDRESS = process.env.NEXT_PUBLIC_PAYUNG_ROLL_MODULE_ADDRESS ?? '';

type Step = 'idle' | 'deploying' | 'funding' | 'enabling' | 'done';

export default function PreciseSetupPage() {
  const router = useRouter();
  const { goal, recommendedQuote, rollEstimate } = useProtectionFlow();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [safeAddress, setSafeAddress] = useState<string | null>(null);
  const estimatedTotal = rollEstimate?.estimatedTotalPremiumUsd ?? (recommendedQuote ? recommendedQuote.costUsd * 1.5 : 50);
  const suggestedBudget = Math.round(estimatedTotal * 1.2 * 100) / 100;
  const [budget, setBudget] = useState(suggestedBudget);

  if (!goal) {
    return (
      <Shell>
        <div className={ui.errorBox}>
          Start from a protection search first — Precise Protection needs a goal to set up.
        </div>
      </Shell>
    );
  }

  async function runSetup() {
    setError(null);
    try {
      setStep('deploying');
      const safe = await deployOrConnectSafe();
      setSafeAddress(safe);

      setStep('funding');
      await fundSafe(safe, budget);

      setStep('enabling');
      const openTx = await fetchPrepareOpen({
        spec: { asset: goal!.asset, quantity: goal!.quantity, floorTotalUsd: goal!.floorTotalUsd, horizonDays: goal!.days },
        safe,
        maxPremiumPerRollUsd: (rollEstimate?.anchorPremiumUsd ?? recommendedQuote?.costUsd ?? 30) * 1.5,
        totalSpendCapUsd: budget,
        maxRolls: (rollEstimate?.estimatedLegs ?? Math.ceil(goal!.days / 30) + 1) * 2,
      });
      await enableModuleAndOpen(safe, MODULE_ADDRESS, openTx);

      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('idle');
    }
  }

  return (
    <Shell>
      <h1 className={ui.title}>Set up Precise Protection</h1>
      <p className={ui.subtitle}>
        Payung will keep rolling your protection forward automatically until it covers your full{' '}
        {goal.days}-day floor or you cancel — no more signatures needed after this setup.
      </p>

      {error && <div className={ui.errorBox}>{error}</div>}

      <div className={styles.budgetRow}>
        <label className={styles.budgetLabel} htmlFor="budget">Funding budget (USDC)</label>
        <input
          id="budget"
          type="number"
          className={styles.budgetInput}
          value={budget}
          min={0}
          step={0.01}
          onChange={(e) => setBudget(Number(e.target.value))}
          disabled={step !== 'idle'}
        />
        <p className={styles.budgetHint}>
          Suggested: ${suggestedBudget.toFixed(2)} (the theoretical roll-chain estimate, plus a 20% buffer).
          This funds a Safe you own — Payung never holds it.
        </p>
      </div>

      <ol className={styles.steps}>
        <li className={step === 'deploying' ? styles.stepActive : safeAddress ? styles.stepDone : ''}>
          Deploy or connect your Safe
        </li>
        <li className={step === 'funding' ? styles.stepActive : ''}>Fund it with your budget</li>
        <li className={step === 'enabling' ? styles.stepActive : ''}>Enable Precise Protection</li>
      </ol>

      <button className={ui.btnPrimary} onClick={runSetup} disabled={step !== 'idle' && step !== 'done'}>
        {step === 'idle' ? 'Start setup →' : step === 'done' ? 'Set up ✓' : 'Working…'}
      </button>

      {step === 'done' && (
        <button className={ui.btnOutline} onClick={() => router.push('/my-protection')} style={{ marginTop: 12 }}>
          View in My Protection →
        </button>
      )}
    </Shell>
  );
}
