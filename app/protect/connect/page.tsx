'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { hasInjectedWallet } from '../_lib/wallet';
import { IconWallet } from '../_lib/Icons';
import { contracts, usd, usdWhole } from '../_lib/format';
import ui from '../_lib/ui.module.css';
import styles from './page.module.css';

export default function ConnectWalletPage() {
  const router = useRouter();
  const { goal, selectedQuote, wallet, connectWallet, hydrated } = useProtectionFlow();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletAvailable, setWalletAvailable] = useState(true);

  useEffect(() => {
    setWalletAvailable(hasInjectedWallet());
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!selectedQuote) {
      router.replace('/protect/results');
      return;
    }
    if (wallet.connected && wallet.chainOk) router.push('/protect/review');
  }, [selectedQuote, wallet.connected, wallet.chainOk, router, hydrated]);

  if (!hydrated) return <Shell step="connect" />;
  if (!goal || !selectedQuote) return null;

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      await connectWallet();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Shell step="connect">
      <div className={styles.wrap}>
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

          {error && <div className={ui.errorBox}>{error}</div>}

          {!walletAvailable ? (
            <div className={ui.errorBox}>
              No browser wallet found. Install{' '}
              <a href="https://metamask.io" target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
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
      </div>
    </Shell>
  );
}
