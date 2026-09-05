'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useProtectionFlow, SMALL_TALK_REPLIES } from './FlowState';
import { matchLightCommand, type LightCommand } from './chatCommands';
import { detectSmallTalk } from '@/src/small-talk';
import type { ChatCardKind, Goal, QuoteCard } from './types';

export type ReviewPhase = 'review' | 'checking' | 'executing' | 'passed' | 'done';

type ChatFlowState = ReturnType<typeof useChatFlowInternal>;

const ChatFlowContext = createContext<ChatFlowState | null>(null);

function useChatFlowInternal() {
  const flow = useProtectionFlow();
  const {
    goal,
    messages,
    recommendedQuote,
    cheaperQuote,
    rollEstimate,
    wallet,
    appendMessage,
    submitGoalText,
    fetchResults,
    applyExploredFloor,
    selectQuote,
    connectWallet,
    runPreflight,
    executeProtection,
  } = flow;

  const [sending, setSending] = useState(false);
  const [findingProtection, setFindingProtection] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [reviewPhase, setReviewPhase] = useState<ReviewPhase>('review');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewPartiallyExecuted, setReviewPartiallyExecuted] = useState(false);

  /** The card the user is currently looking at, i.e. what free text should act on. */
  const lastCard = useMemo<ChatCardKind | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.from === 'payung' && m.card) return m.card;
    }
    return null;
  }, [messages]);

  const quoteForTier = useCallback(
    (tier: 'recommended' | 'cheaper'): QuoteCard | null =>
      tier === 'recommended' ? recommendedQuote : cheaperQuote ?? rollEstimate?.anchorQuote ?? null,
    [recommendedQuote, cheaperQuote, rollEstimate]
  );

  const runFindProtection = useCallback(async (goalOverride?: Goal) => {
    setExploreOpen(false);
    setReviewPhase('review');
    setReviewError(null);
    setFindingProtection(true);
    const outcome = await fetchResults(goalOverride);
    setFindingProtection(false);
    if (!outcome.ok) {
      appendMessage({ from: 'payung', text: outcome.error });
      return;
    }
    appendMessage({ from: 'payung', text: "Here's what I found:", card: 'quote-options' });
  }, [fetchResults, appendMessage]);

  const advanceToConfirm = useCallback(() => {
    setExploreOpen(false);
    appendMessage({ from: 'payung', text: "Here's exactly what you'd be buying:", card: 'confirm-summary' });
  }, [appendMessage]);

  const handleSelectQuote = useCallback(
    (quote: QuoteCard) => {
      selectQuote(quote);
      advanceToConfirm();
    },
    [selectQuote, advanceToConfirm]
  );

  const handleExploreUseFloor = useCallback(
    (floorUsd: number, quote: QuoteCard) => {
      applyExploredFloor(floorUsd, quote);
      advanceToConfirm();
    },
    [applyExploredFloor, advanceToConfirm]
  );

  const handleConfirm = useCallback(() => {
    if (wallet.connected && wallet.chainOk) {
      setReviewPhase('review');
      setReviewError(null);
      appendMessage({ from: 'payung', text: 'Ready to check and buy:', card: 'review-execute' });
    } else {
      setConnectError(null);
      appendMessage({ from: 'payung', text: 'Connect your wallet to continue.', card: 'connect-wallet' });
    }
  }, [wallet, appendMessage]);

  const handleBackToOptions = useCallback(() => {
    appendMessage({ from: 'payung', text: 'Sure — here are your options again:', card: 'quote-options' });
  }, [appendMessage]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      await connectWallet();
      setReviewPhase('review');
      setReviewError(null);
      appendMessage({ from: 'payung', text: 'Wallet connected. Ready to check and buy:', card: 'review-execute' });
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [connectWallet, appendMessage]);

  const handleExecute = useCallback(async () => {
    setReviewPhase('executing');
    setReviewError(null);
    const outcome = await executeProtection();
    if (!outcome.ok) {
      setReviewError(outcome.error);
      setReviewPartiallyExecuted(/already confirmed on-chain/.test(outcome.error));
      setReviewPhase('passed');
      return;
    }
    setReviewPhase('done');
    appendMessage({ from: 'payung', text: "You're protected.", card: 'purchased' });
  }, [executeProtection, appendMessage]);

  const handlePreflightAndExecute = useCallback(async () => {
    setReviewPhase('checking');
    setReviewError(null);
    setReviewPartiallyExecuted(false);
    const preflight = await runPreflight();
    if (!preflight.ok) {
      setReviewError(preflight.error);
      setReviewPhase('review');
      return;
    }
    await handleExecute();
  }, [runPreflight, handleExecute]);

  const runCommand = useCallback(
    (cmd: LightCommand) => {
      switch (cmd.type) {
        case 'select': {
          const q = quoteForTier(cmd.tier);
          if (q) handleSelectQuote(q);
          else appendMessage({ from: 'payung', text: "That option isn't available right now." });
          return;
        }
        case 'explore':
          setExploreOpen(true);
          return;
        case 'confirm':
          handleConfirm();
          return;
        case 'back':
          handleBackToOptions();
          return;
        case 'connect':
          void handleConnect();
          return;
        case 'preflight':
        case 'execute':
          if (reviewPhase === 'passed') void handleExecute();
          else void handlePreflightAndExecute();
          return;
      }
    },
    [quoteForTier, handleSelectQuote, appendMessage, handleConfirm, handleBackToOptions, handleConnect, reviewPhase, handleExecute, handlePreflightAndExecute]
  );

  const handleUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || findingProtection) return;

      // 1. Check if user typed a direct action shortcut for the visible card
      const cmd = matchLightCommand(lastCard, trimmed);
      if (cmd) {
        appendMessage({ from: 'you', text: trimmed });
        runCommand(cmd);
        return;
      }

      // 2. Deterministic small-talk / greetings
      const smallTalk = detectSmallTalk(trimmed);
      if (smallTalk) {
        appendMessage({ from: 'you', text: trimmed });
        appendMessage({ from: 'payung', text: SMALL_TALK_REPLIES[smallTalk] });
        return;
      }

      // 3. Conversational AI & Goal Parser with full degree of freedom
      setSending(true);
      const outcome = await submitGoalText(trimmed, { goalContext: goal, cardContext: lastCard });
      setSending(false);

      if (outcome.complete && outcome.goal) {
        await runFindProtection(outcome.goal);
      }
    },
    [
      sending,
      findingProtection,
      lastCard,
      goal,
      runCommand,
      submitGoalText,
      runFindProtection,
      appendMessage,
    ]
  );

  const handleExampleClick = useCallback(
    async (prompt: string) => {
      if (sending) return;
      setExploreOpen(false);
      setReviewPhase('review');
      setReviewError(null);
      setSending(true);
      const { complete, error, goal: parsedGoal } = await submitGoalText(prompt, { resetHistory: true });
      setSending(false);
      if (!error && complete) await runFindProtection(parsedGoal);
    },
    [sending, submitGoalText, runFindProtection]
  );

  return {
    ...flow,
    lastCard,
    sending,
    findingProtection,
    exploreOpen,
    setExploreOpen,
    connecting,
    connectError,
    reviewPhase,
    reviewError,
    reviewPartiallyExecuted,
    handleUserText,
    handleExampleClick,
    handleSelectQuote,
    handleExploreUseFloor,
    handleConfirm,
    handleBackToOptions,
    handleConnect,
    handlePreflightAndExecute,
    handleExecute,
  };
}

export function ChatFlowProvider({ children }: { children: ReactNode }) {
  const value = useChatFlowInternal();
  return <ChatFlowContext.Provider value={value}>{children}</ChatFlowContext.Provider>;
}

export function useChatFlow() {
  const ctx = useContext(ChatFlowContext);
  if (!ctx) throw new Error('useChatFlow must be used within ChatFlowProvider');
  return ctx;
}

/** Friendly frozen label for a card message that's been superseded by a later step. */
export const CARD_SUMMARY: Record<ChatCardKind, string> = {
  'quote-options': 'Protection options',
  'confirm-summary': 'Protection details reviewed',
  'connect-wallet': 'Wallet connected',
  'review-execute': 'Checked & submitted',
  purchased: 'Protection purchased',
};
