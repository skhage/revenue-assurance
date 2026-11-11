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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@databricks/appkit-ui/react';
import { Fragment, useEffect, useState } from 'react';
import { Target, TrendingUp, BarChart3, Info } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { ExpandToggle, domId } from '../components/expand-toggle';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { UrgencyBadge, ConfidenceBadge } from '../components/badges';
import { smartQueueApi } from '../lib/smart-queue';
import { usdCompact, usd, numCompact, checkLabel, accountLabel } from '../lib/format';
import type {
  SmartQueueItem,
  SmartQueueSummary,
  PredictedRecoveryItem,
  TriageEffectivenessRow,
} from '../lib/types';

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pctInt(v: number): string {
  return `${Math.round(v)}%`;
}

export function SmartQueuePage() {
  const [summary, setSummary] = useState<SmartQueueSummary | null>(null);
  const [queue, setQueue] = useState<SmartQueueItem[]>([]);
  const [recoveryOpps, setRecoveryOpps] = useState<PredictedRecoveryItem[]>([]);
  const [triageEff, setTriageEff] = useState<TriageEffectivenessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Expanded investigation starter rows.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      smartQueueApi.summary(ctrl.signal),
      smartQueueApi.workQueue({}, ctrl.signal),
      smartQueueApi.recoveryOpportunities({ top_n: 25 }, ctrl.signal),
      smartQueueApi.triageEffectiveness({}, ctrl.signal),
    ])
      .then(([s, q, r, t]) => {
        setSummary(s);
        setQueue(q);
        setRecoveryOpps(r);
        setTriageEff(t);
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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Predicted recovery"
          value={usdCompact(summary?.total_predicted_recovery ?? 0)}
          sublabel="From today's optimized queue"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Queue size"
          value={numCompact(summary?.queue_size ?? 0)}
          sublabel="Exceptions ranked by ROI"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Total at risk"
          value={usdCompact(summary?.total_at_risk ?? 0)}
          sublabel="Gross leakage in queued items"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Avg ROI / hour"
          value={summary ? usdCompact(summary.avg_roi_per_hour) : '$0'}
          sublabel="Predicted recovery per analyst-hour"
          loading={loading}
          error={error}
        />
      </div>

      {/* Tabs: Smart Queue | Recovery Opportunities | Triage Accuracy */}
      <Tabs defaultValue="queue">
        <div className="overflow-x-auto">
        <TabsList>
          <TabsTrigger value="queue" className="gap-1.5">
            <Target className="h-3.5 w-3.5" /> Smart queue
          </TabsTrigger>
          <TabsTrigger value="recovery" className="gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" /> Recovery opportunities
          </TabsTrigger>
          <TabsTrigger value="triage" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" /> Triage accuracy
          </TabsTrigger>
        </TabsList>
        </div>

        {/* ── Smart Queue tab ─────────────────────────────────────── */}
        <TabsContent value="queue">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Today's optimized work queue</CardTitle>
              <CardDescription>
                Ranked by ROI-per-hour · predicted recovery value / expected investigation hours
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load the smart queue." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading smart queue">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 8 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : queue.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No queued items</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    The smart queue found no unworked exceptions meeting the threshold.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Smart work queue">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Urgency</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Check type</TableHead>
                        <TableHead className="text-right">Predicted recovery</TableHead>
                        <TableHead className="text-right">$ at risk</TableHead>
                        <TableHead className="text-right">ROI / hr</TableHead>
                        <TableHead className="text-right">Est. hours</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Investigation starter</span>
                        </TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {queue.map((item) => {
                        const isExpanded = expandedRows.has(item.exception_id);
                        const detailRowId = `sq-detail-${domId(item.exception_id)}`;
                        return (
                          <Fragment key={item.exception_id}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(item.exception_id)}
                            >
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {item.queue_position}
                              </TableCell>
                              <TableCell>
                                <UrgencyBadge tier={item.urgency_tier} />
                              </TableCell>
                              <TableCell className="max-w-40 truncate font-medium" title={item.account_name}>
                                {accountLabel(item.account_name)}
                              </TableCell>
                              <TableCell className="text-xs">{checkLabel(item.check_type)}</TableCell>
                              <TableCell className="text-right font-mono tabular-nums font-semibold text-success">
                                {usd(item.predicted_recovery_value)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-destructive">
                                {usd(item.amount_at_risk)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums">
                                {usdCompact(item.roi_per_hour)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                                {item.expected_hours.toFixed(1)}h
                              </TableCell>
                              <TableCell>
                                <TooltipProvider delayDuration={200}>
                                  <Tooltip>
                                    {/* V29 L1 (WCAG 2.1.1, 1.4.13): a focusable button trigger lets keyboard users open the tooltip. */}
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        aria-label="Investigation guidance"
                                        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                      >
                                        <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="left" className="max-w-xs text-xs">
                                      {item.investigation_starter}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`${accountLabel(item.account_name)} ${checkLabel(item.check_type)}`}
                                  onToggle={() => toggleExpand(item.exception_id)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} key={`${item.exception_id}-detail`}>
                                <TableCell colSpan={10} className="bg-muted/30 px-6 py-3">
                                  <div className="flex flex-col gap-1">
                                    <div className="text-xs font-semibold text-foreground">Investigation starter</div>
                                    <div className="text-sm text-muted-foreground">
                                      {item.investigation_starter}
                                    </div>
                                    <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
                                      <span>Exception: <span className="font-mono">{item.exception_id}</span></span>
                                      <span>Recovery rate: {pct(item.predicted_recovery_rate)}</span>
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

        {/* ── Recovery Opportunities tab ───────────────────────────── */}
        <TabsContent value="recovery">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Predicted recovery opportunities</CardTitle>
              <CardDescription>
                Unworked exceptions ranked by predicted dollar recovery · from 1.15M+ backlog
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load recovery opportunities." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading recovery opportunities">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : recoveryOpps.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No recovery opportunities</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    The predictive model found no unworked exceptions above the threshold.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Recovery opportunities">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Check type</TableHead>
                        <TableHead className="text-right">Predicted recovery</TableHead>
                        <TableHead className="text-right">$ at risk</TableHead>
                        <TableHead>Recovery rate</TableHead>
                        <TableHead>Confidence</TableHead>
                        <TableHead>Risk tier</TableHead>
                        <TableHead>Reasoning</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recoveryOpps.map((r) => (
                        <TableRow key={`${r.exception_id}-${r.opportunity_rank}`}>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.opportunity_rank}
                          </TableCell>
                          <TableCell className="font-medium">{accountLabel(r.account_name)}</TableCell>
                          <TableCell className="text-xs">{checkLabel(r.check_type)}</TableCell>
                          <TableCell className="text-right font-mono tabular-nums font-semibold text-success">
                            {usd(r.predicted_recovery_value)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums text-destructive">
                            {usd(r.amount_at_risk)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{pct(r.predicted_recovery_rate)}</TableCell>
                          <TableCell>
                            <ConfidenceBadge confidence={r.confidence} />
                          </TableCell>
                          <TableCell className="text-xs">{r.customer_risk_tier}</TableCell>
                          <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={r.recovery_reasoning}>
                            {r.recovery_reasoning}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Triage Accuracy tab ─────────────────────────────────── */}
        <TabsContent value="triage">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Triage effectiveness by check type</CardTitle>
              <CardDescription>
                Where the auto-triage is over/under-prioritizing · 40% overall accuracy = 60% wrong priority
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load triage effectiveness." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading triage effectiveness">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : triageEff.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No triage data</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    No check types have sufficient feedback data for accuracy analysis.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Triage effectiveness">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Check type</TableHead>
                        <TableHead className="text-right">Cases</TableHead>
                        <TableHead className="text-right">Accuracy</TableHead>
                        <TableHead>Priority error</TableHead>
                        <TableHead>Common misclass.</TableHead>
                        <TableHead>Recommendation</TableHead>
                        <TableHead className="text-right">Recovery (accurate)</TableHead>
                        <TableHead className="text-right">Recovery (inaccurate)</TableHead>
                        <TableHead className="text-right">Impact Δ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {triageEff.map((row) => {
                        const isLow = row.triage_accuracy_pct < 50;
                        return (
                          <TableRow key={row.check_type}>
                            <TableCell className="text-xs font-medium">{checkLabel(row.check_type)}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                              {numCompact(row.total_cases)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono tabular-nums font-semibold ${
                                isLow ? 'text-destructive' : 'text-success'
                              }`}
                            >
                              {pctInt(row.triage_accuracy_pct)}
                            </TableCell>
                            <TableCell className="text-xs">{row.avg_priority_error}</TableCell>
                            <TableCell className="max-w-32 truncate text-xs text-muted-foreground" title={row.most_common_misclass}>
                              {row.most_common_misclass}
                            </TableCell>
                            <TableCell className="max-w-40 truncate text-xs" title={row.recommended_adjustment}>
                              {row.recommended_adjustment}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-success">
                              {pct(row.recovery_rate_when_accurate)}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                              {pct(row.recovery_rate_when_inaccurate)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono tabular-nums ${
                                row.accuracy_delta_impact_pct > 0 ? 'text-success' : 'text-destructive'
                              }`}
                            >
                              {row.accuracy_delta_impact_pct > 0 ? '+' : ''}
                              {pct(row.accuracy_delta_impact_pct)}
                            </TableCell>
                          </TableRow>
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
