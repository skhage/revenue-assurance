import { Badge } from '@databricks/appkit-ui/react';

const LABEL: Record<'deterministic' | 'demo-data', string> = {
  deterministic: 'Deterministic · rule-based',
  'demo-data': 'Demo data',
};

const TITLE: Record<'deterministic' | 'demo-data', string> = {
  deterministic: 'Computed by fixed rules over real data in this app — not an LLM or model output.',
  'demo-data': 'Illustrative config for this demo, not a live data feed.',
};

/**
 * Honesty label for every agent-computed value in the workbench: there is no
 * LLM behind these panels, and analyst capacity is a small demo roster, not a
 * live feed. Always render this next to text that could otherwise read as an
 * AI-generated insight or a real operational metric.
 */
export function DemoBadge({ kind }: { kind: 'deterministic' | 'demo-data' }) {
  return (
    <Badge variant="outline" className="gap-1 text-[10px] font-normal text-muted-foreground" title={TITLE[kind]}>
      {LABEL[kind]}
    </Badge>
  );
}
