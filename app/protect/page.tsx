'use client';

import { useState } from 'react';
import { Shell } from './_lib/Shell';
import { ChatFlowProvider, useChatFlow, CARD_SUMMARY } from './_lib/ChatFlow';
import { EXAMPLE_PROMPTS } from './_lib/mock';
import { IconCheck, IconSelfCustody } from './_lib/Icons';
import { contracts, usdWhole } from './_lib/format';
import type { ChatCardKind } from './_lib/types';
import { QuoteOptionsCard } from './_lib/cards/QuoteOptionsCard';
import { ConfirmSummaryCard } from './_lib/cards/ConfirmSummaryCard';
import { ConnectWalletCard } from './_lib/cards/ConnectWalletCard';
import { ReviewExecuteCard } from './_lib/cards/ReviewExecuteCard';
import { PurchasedCard } from './_lib/cards/PurchasedCard';
import ui from './_lib/ui.module.css';
import styles from './page.module.css';

function CardFor({ kind }: { kind: ChatCardKind }) {
  switch (kind) {
    case 'quote-options':
      return <QuoteOptionsCard />;
    case 'confirm-summary':
      return <ConfirmSummaryCard />;
    case 'connect-wallet':
      return <ConnectWalletCard />;
    case 'review-execute':
      return <ReviewExecuteCard />;
    case 'purchased':
      return <PurchasedCard />;
  }
}

function ChatPageContent() {
  const { goal, messages, hydrated, sending, findingProtection, handleUserText, handleExampleClick } = useChatFlow();
  const [inputText, setInputText] = useState('');

  const lastCardIndex = messages.reduce((acc, m, i) => (m.from === 'payung' && m.card ? i : acc), -1);

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    const text = inputText.trim();
    if (!text || sending || findingProtection) return;
    setInputText('');
    await handleUserText(text);
  }

  if (!hydrated) return <Shell wide />;

  return (
    <Shell wide>
      <div className={ui.card}>
        <h1 className={ui.title}>Protect your crypto</h1>
        <p className={ui.subtitle}>Tell Payung what you&apos;d like to protect. It finds, prices and buys it with you.</p>

        <div className={styles.chatLog}>
          {messages.map((m, i) => {
            if (m.from === 'you') {
              return (
                <div key={i}>
                  <p className={styles.speakerLabel}>You:</p>
                  <div className={styles.bubble}>{m.text}</div>
                </div>
              );
            }

            const isActiveCard = !!m.card && i === lastCardIndex;
            const isStaleCard = !!m.card && !isActiveCard;

            return (
              <div key={i}>
                {m.text && (
                  <>
                    <p className={[styles.speakerLabel, styles.speakerLabelAccent].join(' ')}>Payung:</p>
                    <div className={[styles.bubble, styles.bubblePayung].join(' ')}>{m.text}</div>
                  </>
                )}
                {isActiveCard && <div className={styles.cardWrap}>{m.card && <CardFor kind={m.card} />}</div>}
                {isStaleCard && m.card && (
                  <div className={styles.staleCard}>
                    <IconCheck size={14} />
                    {CARD_SUMMARY[m.card]}
                  </div>
                )}
              </div>
            );
          })}

          {findingProtection && (
            <div className={ui.loadingNote}>
              <span className={ui.spinner} /> Reading the live Thetanuts book…
            </div>
          )}
        </div>

        <div className={styles.exampleRow}>
          <p className={styles.exampleLabel}>Try an example:</p>
          <div className={styles.chips}>
            {EXAMPLE_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                className={styles.chip}
                onClick={() => handleExampleClick(prompt)}
                disabled={sending || findingProtection}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        <form className={ui.askInputWrap} onSubmit={handleSend}>
          <input
            className={ui.askInput}
            placeholder="I want to protect 0.2 ETH at a $2,300 protected price for the next week..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={sending || findingProtection}
          />
          <button
            className={ui.askSend}
            type="submit"
            aria-label="Send"
            disabled={sending || findingProtection || !inputText.trim()}
          >
            {sending || findingProtection ? <span className={ui.spinner} /> : '→'}
          </button>
        </form>

        {goal && (
          <div className={styles.parsed}>
            <span className={styles.parsedFloorMark} aria-hidden="true" />
            <div className={styles.parsedRow}>
              <span className="num">{contracts(goal.quantity)} {goal.asset}</span>
              <span className={styles.parsedDivider} />
              <span className={[styles.parsedFloor, 'num'].join(' ')}>{usdWhole(goal.floorUsd)} protected price</span>
              <span className={styles.parsedDivider} />
              <span className="num">{goal.days} days</span>
            </div>
          </div>
        )}
      </div>

      <p className={ui.lockNote}>
        <IconSelfCustody size={15} /> Your crypto stays in your wallet.
      </p>
    </Shell>
  );
}

export default function StateGoalPage() {
  return (
    <ChatFlowProvider>
      <ChatPageContent />
    </ChatFlowProvider>
  );
}
