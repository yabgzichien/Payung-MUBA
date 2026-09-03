'use client';

import { useEffect, useState } from 'react';
import { useChatFlow } from '../ChatFlow';
import { hasInjectedWallet } from '../wallet';
import { IconWallet } from '../Icons';
import { contracts, usd, usdWhole } from '../format';
import ui from '../ui.module.css';
import styles from '../../connect/page.module.css';

export function ConnectWalletCard() {
  const { goal, selectedQuote, wallet, connecting, connectError, handleConnect } = useChatFlow();
  const [walletAvailable, setWalletAvailable] = useState(true);

  useEffect(() => {
    setWalletAvailable(hasInjectedWallet());
  }, []);

  if (!goal || !selectedQuote) return null;

  return (
    <div className={styles.card}>
      <div className={styles.icon}>
        <IconWallet size={30} />
      </div>
      <h1 className={styles.title}>Connect your wallet</h1>
      <p className={styles.subtitle}>Your protection is ready. Connect your wallet to continue.</p>

      <div className={styles.statBox}>
        <p className={styles.statLabel}>Protecting</p>
        <p className={[styles.statValue, 'num'].join(' ')}>
          {contracts(selectedQuote.contracts)} {goal.asset}
        </p>
        <p className={styles.statFoot}>
          <span className="num">{usdWhole(selectedQuote.floorUsd)}</span> protected price · you pay{' '}
          <span className="num">{usd(selectedQuote.costUsd)}</span>
        </p>
      </div>

      {connectError && <div className={ui.errorBox}>{connectError}</div>}

      {!walletAvailable ? (
        <div className={ui.errorBox}>
          No browser wallet found. Install{' '}
          <a
            href="https://metamask.io"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'inherit', textDecoration: 'underline' }}
          >
            MetaMask
          </a>{' '}
          or another injected wallet, then reload this page.
        </div>
      ) : wallet.connected && !wallet.chainOk ? (
        <button className={ui.btnPrimary} onClick={handleConnect} disabled={connecting}>
          {connecting ? <span className={ui.spinner} /> : null} Switch to Base
        </button>
      ) : (
        <button className={ui.btnPrimary} onClick={handleConnect} disabled={connecting}>
          {connecting ? <span className={ui.spinner} /> : null} Connect Wallet
        </button>
      )}

      <p className={styles.footNote}>Your wallet is only used to sign. Payung never takes custody.</p>
    </div>
  );
}
