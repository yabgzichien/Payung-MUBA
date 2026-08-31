'use client';

import { useEffect, useMemo, useState } from 'react';

type Protection = {
  id: string;
  optionAddress: string;
  underlying: string | null;
  strike: number | null;
  contracts: number | null;
  premiumPaid: number | null;
  collateralAmount: number | null;
  collateralSymbol: string | null;
  pnlUsd: number | null;
  status: string | null;
  exercised: boolean | null;
  entryTimestamp: number | null;
  entryTxHash: string | null;
  entryExplorer: string | null;
  expiryTimestamp: number | null;
  expiryIso: string | null;
};

type Trade = {
  id: string;
  type: 'fill' | 'cancel' | 'exercise' | 'settle' | 'close' | string;
  timestamp: number | null;
  timestampIso: string | null;
  txHash: string | null;
  explorer: string | null;
  underlying: string | null;
  strike: number | null;
  expiryIso: string | null;
  amount: number | null;
  premiumPaid: number | null;
  collateralAmount: number | null;
  collateralSymbol: string | null;
  status: string | null;
};

type PositionsResponse = {
  protections: Protection[];
  protectionsError: string | null;
  trades: Trade[];
  tradesError: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  active: 'ACTIVE',
  closed: 'CLOSED',
  'expired-awaiting-settlement': 'AWAITING SETTLEMENT',
  'settled-itm': 'SETTLED · PAID OUT',
  'settled-otm': 'SETTLED · EXPIRED WORTHLESS',
};

const TRADE_TYPE_LABEL: Record<string, string> = {
  fill: 'Bought',
  cancel: 'Cancelled',
  exercise: 'Exercised',
  settle: 'Settled',
  close: 'Closed',
};

function isValidAddress(a: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(a.trim());
}

/**
 * The indexer reports a live position's `optionStatus` as 'active', while the
 * coarser `status` field uses 'open'. Accept both so a freshly-filled
 * protection can't land in "past" just because one field was missing.
 */
function isActiveStatus(status: string | null): boolean {
  return status === 'active' || status === 'open';
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function fmtUsd(n: number | null, d = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export default function HistoryClient({ initialAddress }: { initialAddress: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [input, setInput] = useState(initialAddress);
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!isValidAddress(address)) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/positions?address=${encodeURIComponent(address)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || `request failed (${res.status})`);
        return body as PositionsResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setFetchError(e?.message || String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Ticks the expiry countdown / progress bars live while the page stays open.
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const { activeProtections, pastProtections } = useMemo(() => {
    const all = data?.protections ?? [];
    const active = all.filter((p) => isActiveStatus(p.status));
    const past = all.filter((p) => !isActiveStatus(p.status));
    return { activeProtections: active, pastProtections: past };
  }, [data]);

  function submitAddress(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (isValidAddress(trimmed)) setAddress(trimmed);
  }

  return (
    <>
      <header>
        <div className="header-brand">
          <span className="brand-title">
            <span className="brand-umbrella">☂</span> Payung
          </span>
          <span className="brand-tag">Protection &amp; transaction history</span>
        </div>
        <a href="/" className="hist-back-link">
          ← Back to workspace
        </a>
      </header>

      <main className="hist-main">
        <form className="hist-address-bar" onSubmit={submitAddress}>
          <label htmlFor="histAddress" className="hist-address-label">
            WALLET ADDRESS
          </label>
          <input
            id="histAddress"
            className="hist-address-input"
            placeholder="0x..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="btn-outline hist-lookup-btn" disabled={!isValidAddress(input)}>
            Look up
          </button>
        </form>

        {!isValidAddress(address) && (
          <p className="hist-hint">
            Connect your wallet on the <a href="/">workspace</a> and click History, or paste any Base
            wallet address above — protection and trade history are public on-chain data.
          </p>
        )}

        {loading && (
          <p className="hist-hint">
            <span className="spinner" /> Fetching from the Thetanuts indexer…
          </p>
        )}

        {fetchError && <div className="alert-banner hist-alert"><span className="alert-tag">ERROR</span><p className="alert-body">{fetchError}</p></div>}

        {data && (
          <>
            {data.protectionsError && (
              <div className="alert-banner hist-alert">
                <span className="alert-tag">PROTECTIONS</span>
                <p className="alert-body">{data.protectionsError}</p>
              </div>
            )}

            <section className="hist-section">
              <div className="hist-section-head">
                <span className="flow-label">Active protections</span>
                <span className="flow-divider" />
              </div>
              {activeProtections.length === 0 ? (
                <p className="hist-empty">No active protections for this address.</p>
              ) : (
                <div className="hist-protection-grid">
                  {activeProtections.map((p) => (
                    <ProtectionCard key={p.id} p={p} nowSec={nowSec} />
                  ))}
                </div>
              )}
            </section>

            {pastProtections.length > 0 && (
              <section className="hist-section">
                <div className="hist-section-head">
                  <span className="flow-label">Past protections</span>
                  <span className="flow-divider" />
                </div>
                <div className="log-list">
                  {pastProtections.map((p) => (
                    <div className="log-row hist-past-row" key={p.id}>
                      <span className="log-dot dim" />
                      <span className="log-label">
                        {p.underlying ?? '—'} ${p.strike?.toLocaleString() ?? '—'} floor ·{' '}
                        {p.contracts?.toFixed(4) ?? '—'} contracts · expired {fmtDate(p.expiryIso)}
                      </span>
                      <span className="log-meta">
                        <span className={`badge-chip neutral hist-status-${p.status ?? 'unknown'}`}>
                          {STATUS_LABEL[p.status ?? ''] ?? (p.status ?? 'UNKNOWN').toUpperCase()}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {data.tradesError && (
              <div className="alert-banner hist-alert">
                <span className="alert-tag">HISTORY</span>
                <p className="alert-body">{data.tradesError}</p>
              </div>
            )}

            <section className="hist-section">
              <div className="hist-section-head">
                <span className="flow-label">Transaction history</span>
                <span className="flow-divider" />
              </div>
              {data.trades.length === 0 ? (
                <p className="hist-empty">No transactions for this address yet.</p>
              ) : (
                <div className="log-list">
                  {data.trades.map((t) => (
                    <div className="log-row" key={t.id}>
                      <span className="log-dot" />
                      <span className="log-label">
                        {TRADE_TYPE_LABEL[t.type] ?? t.type} · {t.underlying ?? '—'} $
                        {t.strike?.toLocaleString() ?? '—'} ·{' '}
                        {t.amount != null ? `${t.amount.toFixed(4)} contracts` : ''}
                        {t.premiumPaid != null && ` · premium ${fmtUsd(t.premiumPaid, 4)}`}
                        {t.txHash && (
                          <a
                            className="hist-txrow-hash hist-txrow-inline"
                            href={t.explorer ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            title={t.txHash}
                          >
                            {shortHash(t.txHash)} ↗
                          </a>
                        )}
                      </span>
                      <span className="log-meta">{fmtDate(t.timestampIso)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function ProtectionCard({ p, nowSec }: { p: Protection; nowSec: number }) {
  const hasWindow = p.entryTimestamp != null && p.expiryTimestamp != null && p.expiryTimestamp > p.entryTimestamp;
  const pct = hasWindow
    ? clamp(((nowSec - p.entryTimestamp!) / (p.expiryTimestamp! - p.entryTimestamp!)) * 100, 0, 100)
    : null;
  const daysLeft = p.expiryTimestamp != null ? (p.expiryTimestamp - nowSec) / 86400 : null;
  const barTone = pct === null ? 'accent' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'accent';

  return (
    <div className="hist-protection-card">
      <div className="hist-protection-head">
        <span className="badge-chip neutral">{p.underlying ?? '—'}</span>
        <span className="hero-strike hist-protection-strike">${p.strike?.toLocaleString() ?? '—'}</span>
        <span className="hist-protection-contracts">{p.contracts?.toFixed(4) ?? '—'} contracts</span>
      </div>

      {pct !== null ? (
        <div className="hist-progress-wrap">
          <div className="hist-progress-track">
            <div
              className={`hist-progress-fill hist-progress-${barTone}`}
              style={{ width: `${pct.toFixed(1)}%` }}
            />
          </div>
          <div className="hist-progress-labels">
            <span>{pct.toFixed(0)}% to expiry</span>
            <span>{daysLeft != null && daysLeft > 0 ? `${daysLeft.toFixed(1)}d left` : 'expiring now'}</span>
          </div>
        </div>
      ) : (
        <p className="hist-hint hist-no-window">
          {daysLeft != null ? `${daysLeft.toFixed(1)}d to expiry` : 'Expiry unknown'}
        </p>
      )}

      <div className="hist-protection-meta">
        <span>entry {fmtDate(p.entryTimestamp ? new Date(p.entryTimestamp * 1000).toISOString() : null)}</span>
        <span>premium {fmtUsd(p.premiumPaid, 4)}</span>
      </div>

      {p.entryTxHash && (
        <div className="hist-txrow">
          <span className="hist-txrow-label">TX</span>
          <a
            className="hist-txrow-hash"
            href={p.entryExplorer ?? undefined}
            target="_blank"
            rel="noreferrer"
            title={p.entryTxHash}
          >
            {shortHash(p.entryTxHash)} ↗
          </a>
        </div>
      )}
    </div>
  );
}
