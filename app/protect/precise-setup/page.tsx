'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ethers } from 'ethers';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import {
  deployOrConnectSafe,
  fundSafe,
  enableModuleAndOpen,
  withdrawFromSafe,
  safeUsdcBalance,
  predictSafeAddress,
} from '../_lib/safe';
import { fetchPrepareOpen } from '../_lib/api';
import { IconCheck, IconWarn } from '../_lib/Icons';
import { PRECISE_MODULE_ADDRESS, preciseProtectionAvailable } from '../_lib/format';
import type { PrepareOpenResponse } from '../_lib/types';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

const MODULE_ADDRESS = PRECISE_MODULE_ADDRESS;

/**
 * Setup order is a safety property, not a preference.
 *
 * `encoding` and `deploying` are recoverable: the first touches no chain at
 * all, the second only deploys a Safe the user keeps. `funding` is the first
 * step that moves money, so everything that can fail for a configuration
 * reason has to fail BEFORE it. The previous order was deploy -> fund ->
 * prepare-open, which meant an unconfigured module address stranded the
 * user's USDC in a Safe whose address the UI never showed them.
 */
type Step = 'idle' | 'encoding' | 'deploying' | 'funding' | 'enabling' | 'done';

const STEP_ORDER = ['encoding', 'deploying', 'funding', 'enabling'] as const;

const STEP_COPY: Record<(typeof STEP_ORDER)[number], { title: string; sub: string }> = {
  encoding: { title: 'Check the automation is available', sub: 'No wallet signature, nothing spent.' },
  deploying: { title: 'Deploy or connect your Safe', sub: 'A smart account only you own.' },
  funding: { title: 'Fund it with your budget', sub: 'USDC moves from your wallet to your Safe.' },
  enabling: { title: 'Enable Precise Protection', sub: 'Authorises the roll module, then opens your commitment.' },
};

export default function PreciseSetupPage() {
  const router = useRouter();
  const { goal, recommendedQuote, rollEstimate, hydrated, safeAddress, rememberSafeAddress } = useProtectionFlow();
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [strandedUsdc, setStrandedUsdc] = useState<number | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState<string | null>(null);

  const estimatedTotal = rollEstimate?.estimatedTotalPremiumUsd ?? (recommendedQuote ? recommendedQuote.costUsd * 1.5 : 50);
  const suggestedBudget = Math.round(estimatedTotal * 1.2 * 100) / 100;
  const [budget, setBudget] = useState<string>(String(suggestedBudget));

  const budgetValue = Number(budget);
  const budgetValid = Number.isFinite(budgetValue) && budgetValue > 0;
  const moduleConfigured = preciseProtectionAvailable && ethers.isAddress(MODULE_ADDRESS);
  const running = step !== 'idle' && step !== 'done';

  // If a previous attempt left money in a Safe, say so before anything else.
  useEffect(() => {
    if (!safeAddress) return;
    safeUsdcBalance(safeAddress)
      .then((n) => setStrandedUsdc(n))
      .catch(() => setStrandedUsdc(null));
  }, [safeAddress, step]);

  if (!hydrated) return <Shell />;

  if (!goal) {
    return (
      <Shell>
        <div className={ui.errorBox}>
          <IconWarn size={18} />
          <span>Start from a protection search first. Precise Protection needs a goal to set up.</span>
        </div>
      </Shell>
    );
  }

  async function runSetup() {
    setError(null);
    setWithdrawNote(null);
    try {
      // 1. Encode-only preflight. Proves the server has a module address AND a
      //    price feed for this asset, before the user signs anything at all.
      setStep('encoding');
      if (!moduleConfigured) {
        throw new Error(
          'Precise Protection is not available on this deployment yet. The roll module address is not configured. ' +
            'Nothing has been spent. You can still buy the first contract as a normal one-off protection.'
        );
      }
      let openTx: PrepareOpenResponse;
      try {
        openTx = await fetchPrepareOpen({
          spec: { asset: goal!.asset, quantity: goal!.quantity, floorTotalUsd: goal!.floorTotalUsd, horizonDays: goal!.days },
          // The commitment is keyed by Safe, and the Safe's address is
          // deterministic from its owner + config, so predicting it here is
          // safe and lets the whole encode happen before any deploy.
          safe: safeAddress ?? (await predictSafeAddress()),
          maxPremiumPerRollUsd: (rollEstimate?.anchorPremiumUsd ?? recommendedQuote?.costUsd ?? 30) * 1.5,
          totalSpendCapUsd: budgetValue,
          maxRolls: (rollEstimate?.estimatedLegs ?? Math.ceil(goal!.days / 30) + 1) * 2,
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`${detail} Nothing has been spent. No wallet signature was requested.`);
      }

      // 2. Deploy the Safe. Costs gas, but the Safe is the user's and holds nothing yet.
      setStep('deploying');
      const safe = await deployOrConnectSafe();
      // Remembered the instant it exists, so a failure below still leaves the
      // user a pointer to their own money.
      rememberSafeAddress(safe);

      // 3. First and only irreversible money movement.
      setStep('funding');
      await fundSafe(safe, budgetValue);

      // 4. Authorise + open, in one Safe multisend.
      setStep('enabling');
      await enableModuleAndOpen(safe, MODULE_ADDRESS, openTx);

      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('idle');
    }
  }

  async function handleWithdraw() {
    if (!safeAddress) return;
    setWithdrawing(true);
    setWithdrawNote(null);
    try {
      const { amount } = await withdrawFromSafe(safeAddress);
      setWithdrawNote(`Returned $${amount.toFixed(2)} USDC to your wallet.`);
      setStrandedUsdc(0);
    } catch (e) {
      setWithdrawNote(e instanceof Error ? e.message : String(e));
    } finally {
      setWithdrawing(false);
    }
  }

  const activeIndex = STEP_ORDER.indexOf(step as (typeof STEP_ORDER)[number]);

  return (
    <Shell>
      <h1 className={ui.title}>Set up Precise Protection</h1>
      <p className={ui.subtitle}>
        Payung keeps rolling your protection forward automatically until it covers your full{' '}
        {goal.days}-day protected price or you cancel. No more signatures after this setup.
      </p>

      {!moduleConfigured && (
        <div className={styles.unavailable}>
          <IconWarn size={18} />
          <div>
            <p className={styles.unavailableTitle}>Not available on this deployment yet</p>
            <p className={styles.unavailableBody}>
              The automated roll module isn&apos;t configured here, so setup would fail partway through. Buy the
              first contract as a normal one-off protection instead. You can roll it manually from My Protection.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className={ui.errorBox}>
          <IconWarn size={18} />
          <span>{error}</span>
        </div>
      )}

      {safeAddress && strandedUsdc !== null && strandedUsdc > 0 && step !== 'done' && (
        <div className={styles.recovery}>
          <p className={styles.recoveryTitle}>
            Your Safe is holding <span className="num">${strandedUsdc.toFixed(2)}</span> USDC
          </p>
          <p className={styles.recoveryBody}>
            Safe <span className="num">{safeAddress.slice(0, 10)}…{safeAddress.slice(-6)}</span>: you own it. Retry
            setup to use these funds, or send them back to your wallet now.
          </p>
          {withdrawNote && <p className={styles.recoveryNote}>{withdrawNote}</p>}
          <button className={ui.btnOutline} onClick={handleWithdraw} disabled={withdrawing || running}>
            {withdrawing ? <span className={ui.spinner} /> : null} Return USDC to my wallet
          </button>
        </div>
      )}

      <div className={styles.budgetRow}>
        <label className={styles.budgetLabel} htmlFor="budget">
          Funding budget (USDC)
        </label>
        <input
          id="budget"
          type="number"
          inputMode="decimal"
          className={[styles.budgetInput, 'num', !budgetValid && budget !== '' && styles.budgetInputInvalid]
            .filter(Boolean)
            .join(' ')}
          value={budget}
          min={0}
          step={0.01}
          aria-describedby="budget-hint"
          aria-invalid={!budgetValid && budget !== ''}
          onChange={(e) => setBudget(e.target.value)}
          disabled={running}
        />
        <p className={styles.budgetHint} id="budget-hint">
          {budgetValid ? (
            <>
              Suggested: <span className="num">${suggestedBudget.toFixed(2)}</span>, the theoretical roll-chain
              estimate plus a 20% buffer. This funds a Safe you own; Payung never holds it.
            </>
          ) : (
            <span className={styles.budgetError}>Enter an amount greater than 0.</span>
          )}
        </p>
      </div>

      <ol className={styles.steps}>
        {STEP_ORDER.map((key, i) => {
          const state =
            step === 'done' || (activeIndex >= 0 && i < activeIndex)
              ? 'done'
              : step === key
              ? 'active'
              : 'idle';
          return (
            <li
              key={key}
              className={[styles.step, state === 'active' && styles.stepActive, state === 'done' && styles.stepDone]
                .filter(Boolean)
                .join(' ')}
            >
              <span className={styles.stepMark} aria-hidden="true">
                {state === 'done' ? <IconCheck size={14} /> : <span className="num">{i + 1}</span>}
              </span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{STEP_COPY[key].title}</span>
                <span className={styles.stepSub}>{STEP_COPY[key].sub}</span>
              </span>
              {state === 'active' && <span className={ui.spinner} />}
            </li>
          );
        })}
      </ol>

      {step === 'done' ? (
        <>
          <div className={styles.doneBanner}>
            <IconCheck size={18} />
            <span>Precise Protection is live. Payung will roll your protected price forward automatically.</span>
          </div>
          <button className={ui.btnPrimary} onClick={() => router.push('/my-protection')}>
            View in My Protection
          </button>
        </>
      ) : (
        <button
          className={ui.btnPrimary}
          onClick={runSetup}
          disabled={running || !budgetValid || !moduleConfigured}
        >
          {running ? <span className={ui.spinner} /> : null}
          {running ? 'Working…' : 'Start setup'}
        </button>
      )}
    </Shell>
  );
}
