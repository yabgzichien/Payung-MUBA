'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shell } from '../_lib/Shell';
import { useProtectionFlow } from '../_lib/FlowState';
import { ExplorePanel } from '../_lib/ExplorePanel';
import type { QuoteCard } from '../_lib/types';
import ui from '../_lib/ui.module.css';

export default function ExploreProtectionPage() {
  const router = useRouter();
  const { goal, applyExploredFloor, hydrated } = useProtectionFlow();

  useEffect(() => {
    if (!hydrated) return;
    if (!goal) router.replace('/protect');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal, hydrated]);

  if (!hydrated) return <Shell step="results" />;
  if (!goal) return null;

  function handleUseFloor(floorUsd: number, quote: QuoteCard) {
    applyExploredFloor(floorUsd, quote);
    router.push('/protect/confirm');
  }

  return (
    <Shell step="results">
      <Link className={ui.linkBack} href="/protect/results">
        ← Back to protection results
      </Link>
      <h1 className={ui.title}>Explore your protection</h1>
      <p className={ui.subtitle}>
        Drag the protected price line (or use the arrow keys) to price a different level of protection.
      </p>
      <ExplorePanel goal={goal} onUseFloor={handleUseFloor} />
    </Shell>
  );
}
