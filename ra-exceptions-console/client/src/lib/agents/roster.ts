// Demo-only analyst roster for the Smart Prioritization & Routing agent.
// There is no live capacity/workload feed in this app — this is a small,
// clearly-labeled, deterministic config used to make routing suggestions
// legible in a demo. It is NOT a source of real analyst capacity.

export interface RosterEntry {
  analyst: string;
  specialties: string[];
  capacity: number;
}

export const DEMO_ROSTER: readonly RosterEntry[] = [
  {
    analyst: 'marcus.chen@demo',
    specialties: ['contract_price_mismatch', 'doc_contract_mismatch', 'doc_invoice_mismatch'],
    capacity: 8,
  },
  {
    analyst: 'priya.nair@demo',
    specialties: ['unauthorized_discount', 'expired_quote_active'],
    capacity: 6,
  },
  {
    analyst: 'dana.whitfield@demo',
    specialties: ['ar_collection_risk', 'rev_rec_timing_mismatch'],
    capacity: 5,
  },
] as const;

const DEFAULT_QUEUE = 'General triage';
const QUEUE_BY_SPECIALTY: Record<string, string> = {
  contract_price_mismatch: 'Billing Ops queue',
  doc_contract_mismatch: 'Contract Ops queue',
  doc_invoice_mismatch: 'Billing Ops queue',
  unauthorized_discount: 'Deal Desk queue',
  expired_quote_active: 'Sales Ops queue',
  ar_collection_risk: 'Collections queue',
  rev_rec_timing_mismatch: 'Revenue Accounting queue',
};

/**
 * Picks the roster entry whose specialties include `checkType` with the
 * lowest current load ratio (openCount / capacity). Falls back to the
 * least-loaded analyst overall if no specialty match exists. Deterministic:
 * ties break by roster order, never randomly.
 */
export function recommendAnalyst(
  checkType: string,
  openCountByAnalyst: Map<string, number> = new Map()
): { analyst: string; queue: string } {
  const loadRatio = (entry: RosterEntry) => (openCountByAnalyst.get(entry.analyst) ?? 0) / entry.capacity;

  const specialists = DEMO_ROSTER.filter((entry) => entry.specialties.includes(checkType));
  const candidates = specialists.length > 0 ? specialists : DEMO_ROSTER;

  let best = candidates[0];
  for (const entry of candidates.slice(1)) {
    if (loadRatio(entry) < loadRatio(best)) best = entry;
  }

  return { analyst: best.analyst, queue: QUEUE_BY_SPECIALTY[checkType] ?? DEFAULT_QUEUE };
}
