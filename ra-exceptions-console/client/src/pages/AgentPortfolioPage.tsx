import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@databricks/appkit-ui/react';
import { Fragment, useEffect, useState } from 'react';
import { KpiTile } from '../components/KpiTile';
import { ExpandToggle, domId } from '../components/expand-toggle';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { agentPortfolioApi } from '../lib/agent-portfolio';
import type { AgentRoiRow, CoverageGapRow, PortfolioSummary } from '../lib/agent-portfolio';
import { usdCompact, numCompact } from '../lib/format';

function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}

// V24 (c): renamed so it no longer shadows badges.tsx PRIORITY_STYLES/PriorityBadge.
const GAP_PRIORITY_STYLES: Record<string, string> = {
  HIGH: 'bg-destructive/10 text-destructive',
  MEDIUM: 'bg-warning/15 text-warning',
  LOW: 'bg-success/10 text-green-800 dark:text-success',
};

function GapPriorityBadge({ priority }: { priority: string }) {
  const key = (priority || 'MEDIUM').toUpperCase();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        GAP_PRIORITY_STYLES[key] ?? GAP_PRIORITY_STYLES.MEDIUM
      }`}
    >
      {key.charAt(0) + key.slice(1).toLowerCase()}
    </span>
  );
}

// V23 M1 ExpandToggle + domId now live in components/expand-toggle.tsx (V24).

const GAP_TYPE_LABELS: Record<string, string> = {
  NO_SUPERVISOR: 'No supervisor',
  UNWORKED_HOTSPOT: 'Unworked hotspot',
  MISSING_FUNCTION: 'Missing function',
  LOW_COVERAGE: 'Low coverage',
};

export function AgentPortfolioPage() {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [roi, setRoi] = useState<AgentRoiRow[]>([]);
  const [gaps, setGaps] = useState<CoverageGapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      agentPortfolioApi.summary(ctrl.signal),
      agentPortfolioApi.roi(ctrl.signal),
      agentPortfolioApi.gaps(ctrl.signal),
    ])
      .then(([s, r, g]) => {
        setSummary(s);
        setRoi(r);
        setGaps(g);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [refreshKey]);

  const retry = () => setRefreshKey((k) => k + 1);

  const toggleExpand = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const categoryLabel = (cat: string) =>
    cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Portfolio KPIs">
        <KpiTile
          label="Agent categories"
          value={summary ? numCompact(summary.category_count) : '—'}
          sublabel={summary ? `${numCompact(summary.total_functions)} total functions` : undefined}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Supervisor agents"
          value={summary ? numCompact(summary.total_supervisors) : '—'}
          sublabel="Deployed on serving endpoints"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Est. recoverable"
          value={summary ? usdCompact(summary.estimated_recoverable) : '—'}
          sublabel="Via unworked exception backlog"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Avg ROI score"
          value={summary ? summary.avg_roi_score.toFixed(1) : '—'}
          sublabel="Attributed categories only"
          loading={loading}
          error={error}
        />
      </div>

      {/* Main content — two tabs */}
      <Tabs defaultValue="roi">
        <TabsList>
          <TabsTrigger value="roi">ROI by category</TabsTrigger>
          <TabsTrigger value="gaps">Coverage gaps</TabsTrigger>
        </TabsList>

        {/* ── ROI tab ───────────────────────────────────────────────── */}
        <TabsContent value="roi">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Agent ROI by category</CardTitle>
              <CardDescription>
                Each check type is credited to one category, ranked by attributed $ at risk. Cross-cutting categories show no ROI score.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load agent ROI metrics." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading agent ROI metrics">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : roi.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No agent categories found</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    Agent ROI data not yet available.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Agent ROI by category">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Functions</TableHead>
                        <TableHead className="text-right">Supervisors</TableHead>
                        <TableHead className="text-right">At risk</TableHead>
                        <TableHead className="text-right">Recovered</TableHead>
                        <TableHead className="text-right">Recovery %</TableHead>
                        <TableHead className="text-right">Unworked</TableHead>
                        <TableHead className="text-right">ROI</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {roi.map((row) => {
                        const isExpanded = expandedRows.has(row.agent_category);
                        const detailRowId = `roi-detail-${domId(row.agent_category)}`;
                        return (
                          <Fragment key={row.agent_category}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(row.agent_category)}
                            >
                              <TableCell className="text-sm font-medium">
                                {categoryLabel(row.agent_category)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {row.function_count}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {row.supervisor_tool_count}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {usdCompact(row.total_amount_at_risk_usd)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs font-semibold text-success">
                                {usdCompact(row.total_recovered_usd)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {pct(row.recovery_rate_pct)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs text-destructive">
                                {usdCompact(row.unworked_amount_usd)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs font-semibold">
                                {row.attribution_basis === 'PRIMARY' && row.roi_score != null ? (
                                  row.roi_score.toFixed(1)
                                ) : (
                                  <span
                                    className="font-normal text-muted-foreground"
                                    title="Cross-cutting category: no exceptions directly attributed, so ROI is not comparable"
                                  >
                                    —<span className="sr-only"> cross-cutting, not scored</span>
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={categoryLabel(row.agent_category)}
                                  onToggle={() => toggleExpand(row.agent_category)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={9} className="px-6 py-3">
                                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Exceptions detected</div>
                                      <div className="mt-0.5 font-mono tabular-nums text-sm">{numCompact(row.total_exceptions_detected)}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Written off</div>
                                      <div className="mt-0.5 font-mono tabular-nums text-sm">{usdCompact(row.total_written_off_usd)}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Triage accuracy</div>
                                      <div className="mt-0.5 font-mono tabular-nums text-sm">{pct(row.triage_accuracy_pct)}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Est. recoverable</div>
                                      <div className="mt-0.5 font-mono tabular-nums text-sm font-semibold text-success">{usdCompact(row.estimated_recoverable_usd)}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Impact categories</div>
                                      <div className="mt-0.5 text-sm">{row.impact_categories.replace(/,/g, ', ')}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Catalog est. annual</div>
                                      <div className="mt-0.5 font-mono tabular-nums text-sm">{usdCompact(row.catalog_est_annual_usd)}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Unworked count</div>
                                      <div className="mt-0.5 font-mono tabular-nums text-sm">{numCompact(row.unworked_count)}</div>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Coverage gaps tab ─────────────────────────────────────── */}
        <TabsContent value="gaps">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Coverage gaps</CardTitle>
              <CardDescription>
                Check types with no specialized agent, unworked exception hotspots, and missing supervisor coverage
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load coverage gaps." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading coverage gaps">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : gaps.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No coverage gaps — full coverage</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    All check types have agent coverage.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Agent coverage gaps">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Priority</TableHead>
                        <TableHead>Gap type</TableHead>
                        <TableHead>Entity</TableHead>
                        <TableHead className="text-right">Est. impact</TableHead>
                        <TableHead>Assigned</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {gaps.map((row, idx) => {
                        const rowKey = `${row.gap_type}-${row.entity}-${idx}`;
                        const isExpanded = expandedRows.has(rowKey);
                        const detailRowId = `gap-detail-${domId(rowKey)}`;
                        const entityLabel = row.entity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                        return (
                          <Fragment key={rowKey}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(rowKey)}
                            >
                              <TableCell>
                                <GapPriorityBadge priority={row.gap_priority} />
                              </TableCell>
                              <TableCell className="text-xs">
                                {GAP_TYPE_LABELS[row.gap_type] ?? row.gap_type.replace(/_/g, ' ')}
                              </TableCell>
                              <TableCell className="max-w-48 truncate text-sm font-medium" title={row.entity}>
                                {row.entity.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs font-semibold text-destructive">
                                {usdCompact(row.estimated_impact_usd)}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {row.assigned_to}
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`${entityLabel} gap`}
                                  onToggle={() => toggleExpand(rowKey)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={6} className="px-6 py-3">
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Gap description</div>
                                      <div className="mt-0.5 text-sm">{row.gap_description}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Recommended action</div>
                                      <div className="mt-0.5 text-sm">{row.recommended_action}</div>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
