'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ChatMessage,
  Goal,
  ParseResult,
  PrepareTxResponse,
  PurchaseResult,
  QuoteCard,
  QuoteResponse,
  RollEstimateCard,
  WalletState,
  WireCandidate,
} from './types';
import { fetchCandidates, fetchPrepareTx, fetchQuote, parseGoalText } from './api';
import { KEYS, localGet, localSet, sessionGet, sessionSet } from './persist';
import { pluralDays } from './format';
import { detectSmallTalk } from '@/src/small-talk';
import { combineGoalText } from '@/src/intent';
import {
  BASE_CHAIN_ID,
  connectInjectedWallet,
  describeWalletError,
  getSigner,
  sendAndWait,
  switchToBase,
} from './wallet';

type Outcome = { ok: true } | { ok: false; error: string };

function toQuoteCard(
  candidate: WireCandidate,
  q: QuoteResponse,
  tier: QuoteCard['tier'],
  days: number
): QuoteCard {
  const fullyCovers = candidate.coversFullHorizon;
  return {
    id: candidate.id,
    tier,
    floorUsd: q.quote.strike,
    coverageLabel: fullyCovers ? 'Full' : 'Partial',
    coverageDetail: fullyCovers
      ? `${days}/${days} days`
      : `${Math.max(0, Math.round(candidate.daysToExpiry))}/${days} days`,
    costUsd: q.quote.premiumUsdc,
    contracts: q.quote.contracts,
    expiryIso: q.quote.expiryIso,
    // Phrased as a standalone fragment ("3 days early"), never a sentence, so
    // callers can compose it without producing "Ends ends 3 day(s) early".
    expiryNote: fullyCovers
      ? 'Covers requested protected price and time'
      : `Ends ${pluralDays(candidate.coverageGapDays)} early`,
    note: fullyCovers ? 'Covers your requested protected price and time.' : 'Shorter coverage period.',
    protocol: 'Thetanuts',
    network: 'Base',
    collateralSymbol: candidate.collateralSymbol,
    judgment: q.judgment,
    payoff: q.payoff ?? [],
  };
}

export const SMALL_TALK_REPLIES: Record<'greeting' | 'help' | 'floorPrice' | 'marketPrice', string> = {
  greeting:
    "Hi! I'm here to help you protect a crypto holding's value. Tell me an amount, a protected price, and how long, or tap an example below.",
  help:
    'Tell me what you\'d like to protect: an amount of ETH or BTC, the protected price (or total value), and how many days. ' +
    'For example: "Protect 0.2 ETH at a $2,300 protected price for the next 7 days."',
  floorPrice:
    "The protected price is the minimum value you want protected. If the market drops below it, your protection covers the difference. " +
    'You can give it per unit (e.g. "ETH not below $2,300") or as a total (e.g. "worth $2,300 total").',
  marketPrice:
    "Market price is the live trading price of your asset right now. Payung uses it to work out the protected price you're asking for. " +
    'Just state the number, e.g. "market price at $2,300."',
};

function describeMissing(result: ParseResult): string {
  const parts: string[] = [];
  const fieldLabel: Record<string, string> = {
    asset: 'which asset',
    quantity: 'how much',
    floor: 'the protected price',
    horizonDays: 'how many days',
  };
  for (const f of result.missingFields) parts.push(fieldLabel[f] ?? f);
  for (const [f, msg] of Object.entries(result.fieldErrors)) parts.push(msg || fieldLabel[f] || f);
  if (parts.length === 0) return "I still need a bit more detail. Can you tell me again?";
  return `I still need to know ${parts.join(' and ')}. Can you add that?`;
}

type FlowState = {
  goal: Goal | null;
  messages: ChatMessage[];
  candidates: WireCandidate[];
  recommendedQuote: QuoteCard | null;
  cheaperQuote: QuoteCard | null;
  rollEstimate: RollEstimateCard | null;
  selectedQuote: QuoteCard | null;
  wallet: WalletState;
  preparedTx: PrepareTxResponse | null;
  purchase: PurchaseResult | null;
  executionStep: string | null;
  /** True until the first paint has re-read persisted state; guards redirect us away too early. */
  hydrated: boolean;
  /** Safe deployed for Precise Protection, remembered across sessions. */
  safeAddress: string | null;
  rememberSafeAddress: (address: string | null) => void;

  appendMessage: (msg: ChatMessage) => void;
  submitGoalText: (
    text: string,
    options?: { resetHistory?: boolean }
  ) => Promise<{ complete: boolean; error: string | null; goal?: Goal }>;
  fetchResults: (goalOverride?: Goal) => Promise<Outcome>;
  exploreFloor: (floorUsd: number) => Promise<QuoteCard | null>;
  applyExploredFloor: (floorUsd: number, quote: QuoteCard) => void;
  selectQuote: (q: QuoteCard) => void;
  connectWallet: () => Promise<void>;
  prepareExecution: () => Promise<Outcome & { data?: PrepareTxResponse }>;
  runPreflight: () => Promise<Outcome>;
  executeProtection: () => Promise<Outcome>;
};

const FlowContext = createContext<FlowState | null>(null);

export function ProtectionFlowProvider({ children }: { children: ReactNode }) {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { from: 'payung', text: "Tell me what you'd like to protect: an amount, a protected price, and how long." },
  ]);
  const [candidates, setCandidates] = useState<WireCandidate[]>([]);
  const [recommendedQuote, setRecommendedQuote] = useState<QuoteCard | null>(null);
  const [cheaperQuote, setCheaperQuote] = useState<QuoteCard | null>(null);
  const [rollEstimate, setRollEstimate] = useState<RollEstimateCard | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<QuoteCard | null>(null);
  const [wallet, setWallet] = useState<WalletState>({ connected: false, address: null, chainOk: false });
  const [preparedTx, setPreparedTx] = useState<PrepareTxResponse | null>(null);
  const [purchase, setPurchase] = useState<PurchaseResult | null>(null);
  const [executionStep, setExecutionStep] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [safeAddress, setSafeAddress] = useState<string | null>(null);
  const goalTurnsRef = useRef<string[]>([]);
  /**
   * How many steps of the current execution already landed on-chain. A retry
   * resumes from here instead of replaying them: re-running the Aave leg would
   * supply the user's USDC a second time, which is a real, unrecoverable loss,
   * not a wasted approval. Reset whenever a NEW transaction plan is prepared.
   */
  const completedStepsRef = useRef(0);

  /**
   * Rehydrate on mount, never during render — server and client must agree on
   * the first paint or React discards the tree. Every page that guards on
   * `goal` also waits for `hydrated`, so a refresh mid-flow no longer bounces
   * the user to step one before this has had a chance to run.
   */
  useEffect(() => {
    const savedGoal = sessionGet<Goal>(KEYS.goal);
    const savedMessages = sessionGet<ChatMessage[]>(KEYS.messages);
    const savedQuote = sessionGet<QuoteCard>(KEYS.selectedQuote);
    const savedPurchase = localGet<PurchaseResult>(KEYS.purchase);
    const savedSafe = localGet<string>(KEYS.safeAddress);
    if (savedGoal) setGoal(savedGoal);
    if (savedMessages?.length) setMessages(savedMessages);
    if (savedQuote) setSelectedQuote(savedQuote);
    if (savedPurchase) setPurchase(savedPurchase);
    if (savedSafe) setSafeAddress(savedSafe);
    setHydrated(true);
  }, []);

  // Mirror the durable slice of the flow out to storage as it changes. Skipped
  // until hydration completes so the initial empty state cannot erase a
  // refresh's saved values before they have been read back.
  useEffect(() => {
    if (hydrated) sessionSet(KEYS.goal, goal);
  }, [goal, hydrated]);
  useEffect(() => {
    if (hydrated) sessionSet(KEYS.messages, messages);
  }, [messages, hydrated]);
  useEffect(() => {
    if (hydrated) sessionSet(KEYS.selectedQuote, selectedQuote);
  }, [selectedQuote, hydrated]);
  useEffect(() => {
    if (hydrated && purchase) localSet(KEYS.purchase, purchase);
  }, [purchase, hydrated]);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const rememberSafeAddress = useCallback((address: string | null) => {
    setSafeAddress(address);
    localSet(KEYS.safeAddress, address);
  }, []);

  const submitGoalText = useCallback(async (text: string, options?: { resetHistory?: boolean }) => {
    setMessages((prev) => [...prev, { from: 'you', text }]);
    const smallTalk = detectSmallTalk(text);
    if (smallTalk) {
      setMessages((prev) => [...prev, { from: 'payung', text: SMALL_TALK_REPLIES[smallTalk] }]);
      return { complete: false, error: null };
    }
    if (options?.resetHistory || goalTurnsRef.current.length === 0) {
      setGoal(null);
      if (options?.resetHistory) {
        goalTurnsRef.current = [];
      }
    }
    const combinedText = combineGoalText(goalTurnsRef.current, text);
    goalTurnsRef.current = [...goalTurnsRef.current, text];
    let result: ParseResult;
    try {
      result = await parseGoalText(combinedText);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [...prev, { from: 'payung', text: `I couldn't parse that: ${message}` }]);
      return { complete: false, error: message };
    }
    const { spec, missingFields, fieldErrors } = result;
    const complete =
      missingFields.length === 0 &&
      Object.keys(fieldErrors).length === 0 &&
      spec.asset !== null &&
      spec.quantity !== null &&
      spec.floorTotalUsd !== null &&
      spec.unitFloorUsd !== null &&
      spec.horizonDays !== null;

    if (complete) {
      const reply =
        `Got it. I'll look for live protection for ${spec.quantity} ${spec.asset}, around a ` +
        `$${spec.unitFloorUsd!.toLocaleString()} protected price, covering the next ${spec.horizonDays} days.`;
      setMessages((prev) => [...prev, { from: 'payung', text: reply }]);
      const resolvedGoal: Goal = {
        asset: spec.asset!,
        quantity: spec.quantity!,
        floorUsd: spec.unitFloorUsd!,
        floorTotalUsd: spec.floorTotalUsd!,
        days: spec.horizonDays!,
      };
      setGoal(resolvedGoal);
      // A completed goal is a finished conversation — anything typed after
      // this is a new request, not a continuation, and must not be blended
      // with the turns that produced the goal that just completed.
      goalTurnsRef.current = [];
      // Returned directly (not just set on state) so a caller that immediately
      // acts on completion — e.g. auto-fetching results — isn't reading `goal`
      // from a closure that predates this render's setGoal.
      return { complete: true, error: null, goal: resolvedGoal };
    }

    const reply = describeMissing(result);
    setMessages((prev) => [...prev, { from: 'payung', text: reply }]);
    return { complete: false, error: null };
  }, []);

  const runResultsFetch = useCallback(
    async (activeGoal: Goal): Promise<Outcome> => {
      try {
        const { candidates: list, rollEstimate: estimate } = await fetchCandidates({
          asset: activeGoal.asset,
          quantity: activeGoal.quantity,
          floorTotalUsd: activeGoal.floorTotalUsd,
          horizonDays: activeGoal.days,
        });
        setCandidates(list);
        if (list.length === 0) {
          setRecommendedQuote(null);
          setCheaperQuote(null);
          setRollEstimate(null);
          return { ok: false, error: 'No live protection matches your goal right now. Try a different protected price or timeframe.' };
        }
        const top = list.find((c) => c.coversFullHorizon) ?? list[0];
        const shortPick = list.find((c) => !c.coversFullHorizon && c.id !== top.id) ?? null;

        const topQuote = await fetchQuote(top.id, activeGoal.quantity * top.pricePerContract);
        setRecommendedQuote(toQuoteCard(top, topQuote, 'recommended', activeGoal.days));

        if (shortPick) {
          const shortQuote = await fetchQuote(shortPick.id, activeGoal.quantity * shortPick.pricePerContract);
          setCheaperQuote(toQuoteCard(shortPick, shortQuote, 'cheaper', activeGoal.days));
        } else {
          setCheaperQuote(null);
        }

        // Best-effort, independent of the main quotes above: a failure quoting the
        // anchor leg degrades this card to hidden, it must never blank the page
        // that already has a real recommended/cheaper offer on it.
        if (estimate) {
          try {
            const anchorQuote = await fetchQuote(
              estimate.anchorLeg.id,
              activeGoal.quantity * estimate.anchorLeg.pricePerContract
            );
            setRollEstimate({
              ...estimate,
              anchorQuote: toQuoteCard(estimate.anchorLeg, anchorQuote, 'cheaper', activeGoal.days),
            });
          } catch {
            setRollEstimate(null);
          }
        } else {
          setRollEstimate(null);
        }
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: message };
      }
    },
    []
  );

  const fetchResults = useCallback(
    async (goalOverride?: Goal): Promise<Outcome> => {
      const activeGoal = goalOverride ?? goal;
      if (!activeGoal) return { ok: false, error: 'No goal set yet.' };
      return runResultsFetch(activeGoal);
    },
    [goal, runResultsFetch]
  );

  const exploreFloor = useCallback(
    async (floorUsd: number): Promise<QuoteCard | null> => {
      if (!goal) return null;
      try {
        const { candidates: list } = await fetchCandidates({
          asset: goal.asset,
          quantity: goal.quantity,
          floorTotalUsd: floorUsd * goal.quantity,
          horizonDays: goal.days,
        });
        if (list.length === 0) return null;
        const top = list.find((c) => c.coversFullHorizon) ?? list[0];
        const q = await fetchQuote(top.id, goal.quantity * top.pricePerContract);
        return toQuoteCard(top, q, 'recommended', goal.days);
      } catch {
        return null;
      }
    },
    [goal]
  );

  const applyExploredFloor = useCallback((floorUsd: number, quote: QuoteCard) => {
    setGoal((prev) => (prev ? { ...prev, floorUsd, floorTotalUsd: floorUsd * prev.quantity } : prev));
    setSelectedQuote(quote);
  }, []);

  const selectQuote = useCallback((quote: QuoteCard) => setSelectedQuote(quote), []);

  const connectWallet = useCallback(async () => {
    const { address, chainId } = await connectInjectedWallet();
    let chainOk = chainId === BASE_CHAIN_ID;
    if (!chainOk) {
      try {
        await switchToBase();
        chainOk = true;
      } catch (e) {
        setWallet({ connected: true, address, chainOk: false });
        throw new Error(describeWalletError(e));
      }
    }
    setWallet({ connected: true, address, chainOk });
  }, []);

  const prepareExecution = useCallback(async (): Promise<Outcome & { data?: PrepareTxResponse }> => {
    if (!selectedQuote || !wallet.address) return { ok: false, error: 'Select protection and connect your wallet first.' };
    try {
      const result = await fetchPrepareTx(selectedQuote.id, selectedQuote.costUsd, wallet.address);
      setPreparedTx(result);
      // A freshly prepared plan is a different set of transactions; nothing
      // from a previous attempt has landed against it.
      completedStepsRef.current = 0;
      return { ok: true, data: result };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }, [selectedQuote, wallet.address]);

  const runPreflight = useCallback(async (): Promise<Outcome> => {
    const prepared = await prepareExecution();
    if (!prepared.ok || !prepared.data) return prepared;
    try {
      const signer = await getSigner();
      const first = prepared.data.aavePlan?.approveAaveTx ?? prepared.data.approveOptionBookTx;
      await signer.estimateGas({ to: first.to, data: first.data });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: describeWalletError(e) };
    }
  }, [prepareExecution]);

  const executeProtection = useCallback(async (): Promise<Outcome> => {
    if (!preparedTx) return { ok: false, error: 'Nothing prepared to execute yet.' };
    try {
      const signer = await getSigner();
      const steps: { label: string; tx: { to: string; data: string } }[] = [];
      if (preparedTx.aavePlan) {
        steps.push({ label: 'Approving USDC for Aave', tx: preparedTx.aavePlan.approveAaveTx });
        steps.push({ label: 'Supplying USDC to Aave', tx: preparedTx.aavePlan.supplyTx });
      }
      steps.push({ label: 'Approving option book', tx: preparedTx.approveOptionBookTx });
      steps.push({ label: 'Buying protection', tx: preparedTx.fillTx });

      /**
       * Resume, never replay. Steps already confirmed on-chain are skipped: the
       * Aave supply in particular moves real USDC, so re-sending it after a
       * failure further down the chain would silently double the user's
       * deposit with no way to notice or undo it.
       */
      let lastHash = '';
      for (let i = completedStepsRef.current; i < steps.length; i += 1) {
        const step = steps[i];
        setExecutionStep(
          steps.length > 1 ? `${step.label} (${i + 1} of ${steps.length})` : step.label
        );
        const { hash } = await sendAndWait(signer, step.tx);
        completedStepsRef.current = i + 1;
        lastHash = hash;
      }
      setExecutionStep(null);
      setPurchase({ txHash: lastHash, explorerUrl: `https://basescan.org/tx/${lastHash}` });
      return { ok: true };
    } catch (e) {
      setExecutionStep(null);
      const done = completedStepsRef.current;
      const detail = describeWalletError(e);
      return {
        ok: false,
        error:
          done > 0
            ? `${detail} The first ${done} step${done === 1 ? '' : 's'} already confirmed on-chain. ` +
              'Retrying continues from where it stopped; it will not repeat them.'
            : detail,
      };
    }
  }, [preparedTx]);

  const value: FlowState = {
    goal,
    messages,
    candidates,
    recommendedQuote,
    cheaperQuote,
    rollEstimate,
    selectedQuote,
    wallet,
    preparedTx,
    purchase,
    executionStep,
    hydrated,
    safeAddress,
    rememberSafeAddress,
    appendMessage,
    submitGoalText,
    fetchResults,
    exploreFloor,
    applyExploredFloor,
    selectQuote,
    connectWallet,
    prepareExecution,
    runPreflight,
    executeProtection,
  };

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useProtectionFlow() {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error('useProtectionFlow must be used within ProtectionFlowProvider');
  return ctx;
}
