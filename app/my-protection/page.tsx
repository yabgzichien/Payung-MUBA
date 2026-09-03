'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell } from '../protect/_lib/Shell';
import { useProtectionFlow } from '../protect/_lib/FlowState';
import { fetchPositions, fetchSpotPrice, fetchPreciseCommitment, fetchPrepareCancel } from '../protect/_lib/api';
import { hasInjectedWallet, getSigner, sendAndWait, describeWalletError } from '../protect/_lib/wallet';
import type { ShapedPosition, PreciseCommitmentWire } from '../protect/_lib/types';
import ui from '../protect/_lib/ui.module.css';
import styles from './page.module.css';

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  closed: 'Closed',
  'expired-awaiting-settlement': 'Awaiting settlement',
  'settled-itm': 'Settled · paid out',
  'settled-otm': 'Settled · expired worthless',
};

export default function MyProtectionPage() {
  const { wallet, connectWallet } = useProtectionFlow();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [positions, setPositions] = useState<ShapedPosition[]>([]);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [precise, setPrecise] = useState<PreciseCommitmentWire | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.address) return;
    setLoading(true);
    fetchPositions(wallet.address).then((res) => {
      setPositions(res.protections);
      setPositionsError(res.protectionsError);
      setLoading(false);
    });
    fetchPreciseCommitment(wallet.address).then(setPrecise).catch(() => setPrecise(null));
    const asset = positions.find((p) => p.underlying)?.underlying;
    fetchSpotPrice((asset as 'ETH' | 'BTC') ?? 'ETH').then(setSpot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      await connectWallet();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function handleCancelPrecise() {
    if (!precise) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const tx = await fetchPrepareCancel(precise.safe);
      const signer = await getSigner();
      await sendAndWait(signer, tx);
      const refreshed = await fetchPreciseCommitment(precise.safe);
      setPrecise(refreshed);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : describeWalletError(e));
    } finally {
      setCancelling(false);
    }
  }

  const active = positions.find((p) => p.status === 'active') ?? null;

  return (
    <Shell>
      <div className={styles.header}>
        <h1 className={styles.title}>My Protection</h1>
        <p className={styles.subtitle}>View and manage your active protection.</p>
      </div>

      {!wallet.address ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Connect your wallet</p>
          <p className={styles.emptyBody}>Connect your wallet to see your active protection.</p>
          {connectError && <div className={ui.errorBox}>{connectError}</div>}
          {!hasInjectedWallet() ? (
            <div className={ui.errorBox}>No browser wallet found. Install MetaMask or another injected wallet.</div>
          ) : (
            <button
              className={ui.btnPrimary}
              onClick={handleConnect}
              disabled={connecting}
              style={{ display: 'inline-flex', width: 'auto', padding: '14px 28px' }}
            >
              {connecting ? <span className={ui.spinner} /> : null} Connect Wallet
            </button>
          )}
        </div>
      ) : loading ? (
        <div className={ui.loadingNote}>
          <span className={ui.spinner} /> Loading your positions…
        </div>
      ) : positionsError ? (
        <div className={ui.errorBox}>{positionsError}</div>
      ) : !active && !precise ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No active protection yet</p>
          <p className={styles.emptyBody}>Start by telling Payung what you&apos;d like to protect.</p>
          <Link
            href="/protect"
            className={ui.btnPrimary}
            style={{ display: 'inline-flex', width: 'auto', padding: '14px 28px' }}
          >
            Protect my crypto →
          </Link>
        </div>
      ) : (
        <>
          {active && (
            <>
              <div className={styles.card}>
                <p className={styles.cardTitle}>Active protection</p>
                <div className={styles.rows}>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Protected amount</span>
                    <span className={styles.rowValue}>
                      {active.contracts ?? '—'} {active.underlying ?? ''}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Protection floor</span>
                    <span className={[styles.rowValue, styles.rowValueGold].join(' ')}>
                      {active.strike ? `$${active.strike.toLocaleString()}` : '—'}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Days to expiry</span>
                    <span className={[styles.rowValue, styles.rowValueAccent].join(' ')}>
                      {active.daysToExpiry != null ? `${Math.max(0, active.daysToExpiry).toFixed(1)} days` : '—'}
                    </span>
                  </div>
                  {active.entryTimestamp != null && active.expiryTimestamp != null && (
                    <div className={styles.expiryBar}>
                      <div
                        className={styles.expiryBarFill}
                        style={{
                          width: `${(
                            100 -
                            Math.min(
                              100,
                              Math.max(
                                0,
                                ((Date.now() / 1000 - active.entryTimestamp) /
                                  (active.expiryTimestamp - active.entryTimestamp)) *
                                  100,
                              ),
                            )
                          ).toFixed(1)}%`,
                        }}
                      />
                    </div>
                  )}
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Protection cost</span>
                    <span className={styles.rowValue}>{active.premiumPaid != null ? `$${active.premiumPaid.toFixed(2)}` : '—'}</span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Status</span>
                    <span className={[styles.rowValue, styles.rowValueAccent].join(' ')}>
                      {STATUS_LABEL[active.status ?? ''] ?? active.status ?? 'Unknown'}
                    </span>
                  </div>
                </div>
                <p className={styles.metaLine}>
                  Network: Base · Protocol: Thetanuts{active.collateralSymbol ? ` · Collateral: ${active.collateralSymbol}` : ''}
                </p>
              </div>

              <h2 className={styles.sectionTitle}>Protection at a glance</h2>
              <div className={styles.statsRow}>
                <div className={styles.statCell}>
                  <p className={styles.statLabel}>Protection floor</p>
                  <p className={[styles.statValue, styles.statValueGold].join(' ')}>
                    {active.strike ? `$${active.strike.toLocaleString()}` : '—'}
                  </p>
                  <p className={styles.statSub}>Minimum protected value</p>
                </div>
                <div className={styles.statCell}>
                  <p className={styles.statLabel}>{active.underlying ?? 'Asset'} price</p>
                  <p className={styles.statValue}>{spot ? `$${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '…'}</p>
                  <p className={styles.statSub}>Current reference price</p>
                </div>
              </div>

              {active.entryTxHash && (
                <div className={styles.txBar}>
                  <span>✓ Successful</span>
                  <span className={styles.txMeta}>
                    Base · Thetanuts · Transaction hash: {active.entryTxHash.slice(0, 10)}…
                    {active.entryExplorer && (
                      <>
                        {' '}
                        ·{' '}
                        <a href={active.entryExplorer} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                          View ↗
                        </a>
                      </>
                    )}
                  </span>
                </div>
              )}
            </>
          )}

          {precise && (
            <>
              <h2 className={styles.sectionTitle}>Precise Protection</h2>
              <div className={styles.card}>
                <div className={styles.rows}>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Status</span>
                    <span className={[styles.rowValue, precise.active ? styles.rowValueAccent : styles.rowValueWarn].join(' ')}>
                      {precise.active ? 'Active — auto-rolling' : 'Cancelled'}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Spent so far</span>
                    <span className={styles.rowValue}>
                      ${precise.spentUsd.toFixed(2)} / ${precise.totalSpendCapUsd.toFixed(2)} cap
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Rolls used</span>
                    <span className={styles.rowValue}>{precise.rollsUsed} / {precise.maxRolls}</span>
                  </div>
                </div>
                {precise.history.length > 0 && (
                  <ul className={styles.rollHistory}>
                    {precise.history.map((h) => (
                      <li key={h.txHash}>
                        ${h.strike.toLocaleString()} floor · ${h.premiumUsd.toFixed(2)} ·{' '}
                        <a href={`https://basescan.org/tx/${h.txHash}`} target="_blank" rel="noreferrer">
                          {h.txHash.slice(0, 10)}…
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {cancelError && <div className={ui.errorBox}>{cancelError}</div>}
                {precise.active && (
                  <button className={ui.btnOutline} onClick={handleCancelPrecise} disabled={cancelling}>
                    {cancelling ? <span className={ui.spinner} /> : null} Cancel protection
                  </button>
                )}
                <p className={styles.metaLine}>
                  Cancelling stops future rolls only — any protection currently active keeps running to its own expiry.
                </p>
              </div>
            </>
          )}

          <Link href="/protect" className={ui.btnPrimary} style={{ display: 'flex' }}>
            Protect more crypto →
          </Link>
        </>
      )}
    </Shell>
  );
}
