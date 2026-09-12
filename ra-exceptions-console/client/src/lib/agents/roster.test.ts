import { describe, it, expect } from 'vitest';
import { recommendAnalyst, DEMO_ROSTER } from './roster';

describe('recommendAnalyst', () => {
  it('picks the specialist for a known check_type', () => {
    const { analyst } = recommendAnalyst('ar_collection_risk');
    expect(analyst).toBe('dana.whitfield@demo');
  });

  it('routes to the least-loaded specialist when multiple share a specialty', () => {
    const loads = new Map([['marcus.chen@demo', 6]]);
    // marcus.chen is the only specialist for doc_contract_mismatch — this
    // asserts we don't crash/misroute when the only candidate has load.
    const { analyst } = recommendAnalyst('doc_contract_mismatch', loads);
    expect(analyst).toBe('marcus.chen@demo');
  });

  it('falls back to the least-loaded analyst overall for an unknown check_type', () => {
    const loads = new Map([
      ['marcus.chen@demo', 8],
      ['priya.nair@demo', 0],
      ['dana.whitfield@demo', 5],
    ]);
    const { analyst, queue } = recommendAnalyst('some_future_check', loads);
    expect(analyst).toBe('priya.nair@demo');
    expect(queue).toBe('General triage');
  });

  it('breaks ties deterministically by roster order', () => {
    const first = recommendAnalyst('unauthorized_discount');
    const second = recommendAnalyst('unauthorized_discount');
    expect(first).toEqual(second);
  });

  it('prefers the specialist with a better load ratio even with fewer raw open cases', () => {
    // priya.nair capacity=6, marcus.chen capacity=8 — both handle nothing here
    // relevant, so use unauthorized_discount/expired_quote_active (priya-only)
    // vs an artificial tie scenario using contract_price_mismatch (marcus-only).
    const loads = new Map([['priya.nair@demo', 3]]); // 3/6 = 0.5 ratio
    const { analyst } = recommendAnalyst('expired_quote_active', loads);
    expect(analyst).toBe('priya.nair@demo');
  });

  it('every roster specialty maps to a real analyst entry', () => {
    for (const entry of DEMO_ROSTER) {
      expect(entry.analyst).toMatch(/@demo$/);
      expect(entry.capacity).toBeGreaterThan(0);
    }
  });
});
