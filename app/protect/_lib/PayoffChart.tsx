'use client';

import { useId, useState } from 'react';
import { usd, usdWhole } from './format';
import styles from './PayoffChart.module.css';

type Point = { spot: number; pnl: number };

/**
 * What the protection is worth at each possible settlement price.
 *
 * /api/quote has always returned this curve and the UI never drew it — the
 * confirm screen explained the entire payoff as "Your protection pays based on
 * the difference", which is the least informative sentence at the highest-stakes
 * moment in the flow. The kink IS the floor: left of it the line rises as the
 * market falls, right of it the loss is capped at the premium paid.
 */
export function PayoffChart({
  payoff,
  floorUsd,
  asset,
  spot,
  premiumUsd,
}: {
  payoff: Point[];
  floorUsd: number;
  asset: string;
  spot?: number | null;
  premiumUsd: number;
}) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (payoff.length < 2) return null;

  const W = 520;
  const H = 200;
  const PAD_X = 8;
  const PAD_Y = 16;

  const xs = payoff.map((p) => p.spot);
  const ys = payoff.map((p) => p.pnl);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanY = maxY - minY || 1;

  const toX = (v: number) => PAD_X + ((v - minX) / (maxX - minX || 1)) * (W - PAD_X * 2);
  const toY = (v: number) => PAD_Y + (1 - (v - minY) / spanY) * (H - PAD_Y * 2);

  const line = payoff.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.spot).toFixed(1)},${toY(p.pnl).toFixed(1)}`).join(' ');
  const area = `${line} L${toX(payoff[payoff.length - 1].spot).toFixed(1)},${toY(minY).toFixed(1)} L${toX(payoff[0].spot).toFixed(1)},${toY(minY).toFixed(1)} Z`;

  const zeroY = minY <= 0 && maxY >= 0 ? toY(0) : null;
  const floorX = floorUsd >= minX && floorUsd <= maxX ? toX(floorUsd) : null;
  const spotX = spot != null && spot >= minX && spot <= maxX ? toX(spot) : null;

  const active = hoverIndex != null ? payoff[hoverIndex] : null;

  /** Nearest sample to the pointer, in chart coordinates. */
  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const value = minX + ratio * (maxX - minX);
    let best = 0;
    for (let i = 1; i < payoff.length; i += 1) {
      if (Math.abs(payoff[i].spot - value) < Math.abs(payoff[best].spot - value)) best = i;
    }
    setHoverIndex(best);
  }

  const readout = active ?? {
    spot: floorUsd * 0.85,
    pnl: payoff.reduce((acc, p) => (p.spot < floorUsd * 0.9 ? p : acc), payoff[0]).pnl,
  };

  return (
    <figure className={styles.wrap}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Payoff curve. Below a ${usdWhole(floorUsd)} settlement price the protection pays out; above it the cost is capped at the ${usd(premiumUsd)} premium.`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {zeroY !== null && (
          <line x1={PAD_X} y1={zeroY} x2={W - PAD_X} y2={zeroY} className={styles.zeroLine} />
        )}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} className={styles.curve} />

        {floorX !== null && (
          <>
            <line x1={floorX} y1={PAD_Y - 8} x2={floorX} y2={H - PAD_Y + 4} className={styles.floorLine} />
            <circle cx={floorX} cy={toY(payoff.reduce((a, p) => (Math.abs(p.spot - floorUsd) < Math.abs(a.spot - floorUsd) ? p : a), payoff[0]).pnl)} r="4" className={styles.floorDot} />
          </>
        )}

        {spotX !== null && <line x1={spotX} y1={PAD_Y - 8} x2={spotX} y2={H - PAD_Y + 4} className={styles.spotLine} />}

        {active && (
          <>
            <line x1={toX(active.spot)} y1={PAD_Y - 8} x2={toX(active.spot)} y2={H - PAD_Y + 4} className={styles.cursorLine} />
            <circle cx={toX(active.spot)} cy={toY(active.pnl)} r="4.5" className={styles.cursorDot} />
          </>
        )}
      </svg>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <i className={[styles.swatch, styles.swatchFloor].join(' ')} /> Your protected price{' '}
          <b className="num">{usdWhole(floorUsd)}</b>
        </span>
        {spot != null && (
          <span className={styles.legendItem}>
            <i className={[styles.swatch, styles.swatchSpot].join(' ')} /> {asset} now{' '}
            <b className="num">{usdWhole(spot)}</b>
          </span>
        )}
      </div>

      <figcaption className={styles.readout}>
        If {asset} settles at <b className="num">{usdWhole(readout.spot)}</b>, this protection is worth{' '}
        <b className={[styles.readoutValue, readout.pnl >= 0 ? styles.readoutGain : styles.readoutLoss, 'num'].join(' ')}>
          {readout.pnl >= 0 ? '+' : '−'}
          {usd(Math.abs(readout.pnl))}
        </b>
        {active ? '' : '. Drag across the chart to try other prices.'}
      </figcaption>
    </figure>
  );
}
