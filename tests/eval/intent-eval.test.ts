// tests/eval/intent-eval.test.ts
import { describe, it, expect } from 'vitest';
import { classifyPartialSpec } from '../../src/intent.js';
import cases from './cases.json' with { type: 'json' };

describe('intent eval (offline — no network, no key)', () => {
  for (const c of cases as any[]) {
    it(c.name, () => {
      const got = classifyPartialSpec(c.raw);
      if (c.expect) {
        expect(got.asset).toBe(c.expect.asset);
        expect(got.quantity).toBe(c.expect.quantity);
        expect(got.floorTotalUsd).toBeCloseTo(c.expect.floorTotalUsd, 6);
        expect(got.horizonDays).toBe(c.expect.horizonDays);
      }
      if (c.expectMissing) expect(got.missingFields).toEqual(expect.arrayContaining(c.expectMissing));
      if (c.expectFieldError) expect(got.fieldErrors[c.expectFieldError]).toBeTruthy();
    });
  }
});
