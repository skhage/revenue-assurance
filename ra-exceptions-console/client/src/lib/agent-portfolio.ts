// Thin client for the agent portfolio intelligence API (server/routes/agent-portfolio.ts).

export interface AgentRoiRow {
  agent_category: string;
  function_count: number;
  supervisor_tool_count: number;
  total_exceptions_detected: number;
  total_amount_at_risk_usd: number;
  total_recovered_usd: number;
  total_written_off_usd: number;
  recovery_rate_pct: number;
  unworked_count: number;
  unworked_amount_usd: number;
  estimated_recoverable_usd: number;
  triage_accuracy_pct: number;
  impact_categories: string;
  catalog_est_annual_usd: number;
  /** NULL for CROSS_CUTTING categories (not comparable). */
  roi_score: number | null;
  attribution_basis: 'PRIMARY' | 'CROSS_CUTTING';
}

export interface CoverageGapRow {
  gap_type: string;
  gap_priority: string;
  entity: string;
  gap_description: string;
  estimated_impact_usd: number;
  recommended_action: string;
  assigned_to: string;
}

export interface PortfolioSummary {
  category_count: number;
  total_functions: number;
  total_supervisors: number;
  total_at_risk: number;
  total_recovered: number;
  estimated_recoverable: number;
  avg_roi_score: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const agentPortfolioApi = {
  /** Per-category ROI metrics — 22 agent categories. */
  roi: (signal?: AbortSignal) =>
    fetch('/api/agent-portfolio/roi', { signal }).then((r) => json<AgentRoiRow[]>(r)),

  /** Coverage gaps — unworked hotspots and missing supervisor coverage. */
  gaps: (signal?: AbortSignal) =>
    fetch('/api/agent-portfolio/gaps', { signal }).then((r) => json<CoverageGapRow[]>(r)),

  /** Portfolio headline KPIs. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/agent-portfolio/summary', { signal }).then((r) => json<PortfolioSummary>(r)),
};
