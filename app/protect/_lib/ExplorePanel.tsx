'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildExploreFloors } from './mock';
import { fetchPriceHistory, type Candle } from './api';
import { IconWarn } from './Icons';
import { contracts, describeJudgment, usd, usdWhole } from './format';
import { useProtectionFlow } from './FlowState';
import type { Goal, QuoteCard } from './types';
import ui from './ui.module.css';
import styles from './ExplorePanel.module.css';

const CHART_MIN_PCT = 8;
const CHART_MAX_PCT = 92;
const HISTORY_PCT = 63;
/** Arrow-key increments for the floor, as a share of the visible price range. */
const KEY_STEP_PCT = 1.5;
const KEY_STEP_PCT_LARGE = 8;

/**
 * The draggable floor/price chart, shared between the standalone /protect/explore
 * page and the inline "Explore other floors" card in chat — same control, two
 * hosts. The caller owns what happens once a floor is picked.
 */
export function ExplorePanel({
  goal,
  compact = false,
  onUseFloor,
}: {
  goal: Goal;
  compact?: boolean;
  onUseFloor: (floorUsd: number, quote: QuoteCard) => void;
}) {
  const { exploreFloor } = useProtectionFlow();
  const floors = useMemo(() => buildExploreFloors(goal.floorUsd), [goal.floorUsd]);

  const [floor, setFloor] = useState<number>(goal.floorUsd);
  const [quoteByFloor, setQuoteByFloor] = useState<Record<number, QuoteCard | null>>({});
  const [loadingFloor, setLoadingFloor] = useState<number | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragFloor, setDragFloor] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  const priceValues = [
    ...floors,
    ...(spot !== null ? [spot] : []),
    ...candles.flatMap((c) => [c.l, c.h]),
  ];
  const dataMin = priceValues.length ? Math.min(...priceValues) : 0;
  const dataMax = priceValues.length ? Math.max(...priceValues) : 0;
  const pad = priceValues.length ? Math.max((dataMax - dataMin) * 0.12, dataMax * 0.02, 1) : 1;
  const rangeMin = priceValues.length ? dataMin - pad : 0;
  const rangeMax = priceValues.length ? dataMax + pad : 0;
  const displayFloor = dragging && dragFloor !== null ? dragFloor : floor;

  function priceToPercent(p: number) {
    if (rangeMax === rangeMin) return 50;
    const pct = ((p - rangeMin) / (rangeMax - rangeMin)) * 100;
    return Math.min(CHART_MAX_PCT, Math.max(CHART_MIN_PCT, pct));
  }

  function percentToPrice(pct: number) {
    const clamped = Math.min(CHART_MAX_PCT, Math.max(CHART_MIN_PCT, pct));
    return Math.round(rangeMin + (clamped / 100) * (rangeMax - rangeMin));
  }

  function floorAtClientY(clientY: number) {
    const el = chartRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const pct = ((rect.bottom - clientY) / rect.height) * 100;
    return percentToPrice(pct);
  }

  function handleDragStart(e: React.PointerEvent) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const next = floorAtClientY(e.clientY);
    if (next !== null) setDragFloor(next);
  }

  function handleDragMove(e: React.PointerEvent) {
    if (!dragging) return;
    const next = floorAtClientY(e.clientY);
    if (next !== null) setDragFloor(next);
  }

  function handleDragEnd() {
    setDragging(false);
    if (dragFloor !== null) setFloor(dragFloor);
    setDragFloor(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const span = rangeMax - rangeMin;
    const small = (span * KEY_STEP_PCT) / 100;
    const large = (span * KEY_STEP_PCT_LARGE) / 100;
    let next: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = floor + small;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = floor - small;
    else if (e.key === 'PageUp') next = floor + large;
    else if (e.key === 'PageDown') next = floor - large;
    else if (e.key === 'Home') next = percentToPrice(CHART_MIN_PCT);
    else if (e.key === 'End') next = percentToPrice(CHART_MAX_PCT);
    if (next === null) return;
    e.preventDefault();
    setFloor(percentToPrice(priceToPercent(next)));
  }

  useEffect(() => {
    fetchPriceHistory(goal.asset, 14).then((res) => {
      setCandles(res.candles);
      setSpot(res.spot);
      setHistoryError(res.historyError);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.asset]);

  useEffect(() => {
    if (floor in quoteByFloor) return;
    setLoadingFloor(floor);
    exploreFloor(floor).then((q) => {
      setQuoteByFloor((prev) => ({ ...prev, [floor]: q }));
      setLoadingFloor(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor]);

  const activeQuote = quoteByFloor[floor];
  const isLoading = loadingFloor === floor;
  const expiryDate = activeQuote?.expiryIso
    ? new Date(activeQuote.expiryIso)
    : new Date(Date.now() + goal.days * 86400000);
  const expiryLabel = expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const expiryPct = Math.min(96, HISTORY_PCT + Math.min(30, Math.max(12, (goal.days / 14) * 40)));
  const judgment = activeQuote ? describeJudgment(activeQuote.judgment) : null;

  async function handleUseFloor() {
    if (!activeQuote || applying) return;
    setApplying(true);
    onUseFloor(floor, activeQuote);
    setApplying(false);
  }

  return (
    <div className={compact ? styles.compact : undefined}>
      {historyError && (
        <div className={styles.degraded}>
          <IconWarn size={16} />
          <span>Price history is unavailable right now, so the chart shows the protected price and spot only.</span>
        </div>
      )}

      <div className={styles.chartCard}>
        <div className={styles.chart}>
          <div className={styles.plotArea} ref={chartRef}>
            <div
              className={styles.protectedZone}
              style={{ left: `${HISTORY_PCT}%`, width: `${expiryPct - HISTORY_PCT}%` }}
            />
            <div className={styles.nowLine} style={{ left: `${HISTORY_PCT}%` }} />
            <div className={styles.expiryLine} style={{ left: `${expiryPct}%` }} />

            <div className={styles.candleTrack} style={{ width: `${HISTORY_PCT}%` }}>
              {candles.map((c, i) => {
                const up = c.c >= c.o;
                const lowPct = priceToPercent(c.l);
                const highPct = priceToPercent(c.h);
                const bodyLow = priceToPercent(Math.min(c.o, c.c));
                const bodyHigh = priceToPercent(Math.max(c.o, c.c));
                return (
                  <div className={[styles.candle, up ? styles.candleUp : styles.candleDown].join(' ')} key={c.t ?? i}>
                    <div
                      className={styles.wick}
                      style={{ bottom: `${lowPct}%`, height: `${Math.max(0.5, highPct - lowPct)}%` }}
                    />
                    <div
                      className={styles.body}
                      style={{ bottom: `${bodyLow}%`, height: `${Math.max(0.8, bodyHigh - bodyLow)}%` }}
                    />
                  </div>
                );
              })}
            </div>

            {spot !== null && (
              <div className={styles.spotLine} style={{ bottom: `${priceToPercent(spot)}%` }}>
                <span className={styles.spotLabel}>SPOT {usdWhole(spot)}</span>
              </div>
            )}

            <div
              className={[styles.floorLine, dragging && styles.floorLineActive].filter(Boolean).join(' ')}
              style={{ bottom: `calc(${priceToPercent(displayFloor)}% - 14px)` }}
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
              onKeyDown={handleKeyDown}
              role="slider"
              tabIndex={0}
              aria-label="Protected price"
              aria-valuemin={percentToPrice(CHART_MIN_PCT)}
              aria-valuemax={percentToPrice(CHART_MAX_PCT)}
              aria-valuenow={displayFloor}
              aria-valuetext={`${usdWhole(displayFloor)} protected price`}
            >
              <div className={styles.floorLineTrack} />
              <span className={[styles.floorBadge, 'num'].join(' ')}>↕ PROTECTED {usdWhole(displayFloor)}</span>
            </div>
          </div>

          <div className={styles.axisRow}>
            <span className={styles.axisLabelLeft}>14D AGO</span>
            <span className={styles.axisLabelRight} style={{ left: `${(HISTORY_PCT + expiryPct) / 2}%` }}>
              PROTECTED THROUGH {expiryLabel}
            </span>
          </div>
        </div>
        <div className={styles.floorControls}>
          {floors.map((f) => (
            <button
              key={f}
              className={[styles.floorBtn, 'num', f === floor && styles.floorBtnActive].filter(Boolean).join(' ')}
              onClick={() => setFloor(f)}
              aria-pressed={f === floor}
            >
              {usdWhole(f)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.statsRow}>
        <div className={styles.statCell}>
          <p className={styles.statLabel}>Protection cost</p>
          <p className={[styles.statValue, 'num'].join(' ')} aria-live="polite">
            {isLoading ? '…' : activeQuote ? usd(activeQuote.costUsd) : '—'}
          </p>
          {judgment && !isLoading && <p className={styles.statSub}>{judgment.sentence}</p>}
        </div>
        <div className={styles.statCell}>
          <p className={styles.statLabel}>Current {goal.asset} price</p>
          <p className={[styles.statValue, 'num'].join(' ')}>{spot ? usdWhole(spot) : '…'}</p>
          {activeQuote && (
            <p className={styles.statSub}>
              Covers {contracts(activeQuote.contracts)} {goal.asset}
            </p>
          )}
        </div>
      </div>

      {!isLoading && !activeQuote && (
        <div className={ui.errorBox}>
          <IconWarn size={18} />
          <span>No live protection at this protected price right now. Try one of the presets, or a nearby level.</span>
        </div>
      )}

      <button className={ui.btnPrimary} onClick={handleUseFloor} disabled={!activeQuote || isLoading || applying}>
        {isLoading ? (
          <>
            <span className={ui.spinner} /> Checking live options…
          </>
        ) : (
          `Use ${usdWhole(floor)} protected price`
        )}
      </button>
    </div>
  );
}
