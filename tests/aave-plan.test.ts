import { describe, it, expect } from 'vitest';
import { planDeposit } from '../src/aave.js';

describe('planDeposit', () => {
  it('does nothing when the collateral balance already covers the need', () => {
    expect(planDeposit(15_000_000n, 10_000_000n, 'aBasUSDC', 0n)).toEqual({ action: 'none' });
  });

  it('deposits exactly the shortfall when short on aBasUSDC but holding USDC', () => {
    expect(planDeposit(4_000_000n, 10_000_000n, 'aBasUSDC', 20_000_000n)).toEqual({
      action: 'deposit',
      supplyUnits: 6_000_000n,
    });
  });

  it('blocks when USDC cannot cover the shortfall', () => {
    const plan = planDeposit(0n, 10_000_000n, 'aBasUSDC', 5_000_000n);
    expect(plan.action).toBe('blocked');
    expect((plan as any).reason).toMatch(/USDC/);
  });

  it('blocks for tokens with no auto-deposit path', () => {
    const plan = planDeposit(0n, 10_000_000n, 'cbBTC', 50_000_000n);
    expect(plan.action).toBe('blocked');
    expect((plan as any).reason).toMatch(/cbBTC/);
  });
});
