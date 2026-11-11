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
import { ShieldCheck, ScrollText, Calculator, Info } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { ExpandToggle, domId } from '../components/expand-toggle';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { SeverityBadge } from '../components/badges';
import { preventionApi } from '../lib/prevention';
import { usdCompact, numCompact, checkLabel } from '../lib/format';
import type {
  PreventionIntelligenceRow,
  PreventionSummary,
  PreventionRuleRow,
  PreventionRoiRow,
} from '../lib/types';

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pctInt(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function months(v: number): string {
  if (v < 0.01) return '< 1 day';
  if (v < 1) return `${Math.round(v * 30)} days`;
  return `${v.toFixed(1)} mo`;
}

const COMPLEXITY_STYLES: Record<string, string> = {
  HIGH: 'bg-destructive/10 text-destructive',
  MEDIUM: 'bg-warning/15 text-warning',
  LOW: 'bg-success/10 text-green-800 dark:text-success',
};

function ComplexityBadge({ complexity }: { complexity: string }) {
  const key = (complexity || 'MEDIUM').toUpperCase();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        COMPLEXITY_STYLES[key] ?? COMPLEXITY_STYLES.MEDIUM
      }`}
    >
      {key.charAt(0) + key.slice(1).toLowerCase()}
    </span>
  );
}

export function PreventionPage() {
  const [summary, setSummary] = useState<PreventionSummary | null>(null);
  const [intelligence, setIntelligence] = useState<PreventionIntelligenceRow[]>([]);
  const [rules, setRules] = useState<PreventionRuleRow[]>([]);
  const [roi, setRoi] = useState<PreventionRoiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      preventionApi.summary(ctrl.signal),
      preventionApi.intelligence({}, ctrl.signal),
      preventionApi.rules({ top_n: 20 }, ctrl.signal),
      preventionApi.roi({}, ctrl.signal),
    ])
      .then(([s, i, r, ro]) => {
        setSummary(s);
        setIntelligence(i);
        setRules(r);
        setRoi(ro);
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
          label="Preventable leakage"
          value={usdCompact(summary?.total_preventable ?? 0)}
          sublabel="Annual amount addressable by upstream controls"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Annual write-offs"
          value={usdCompact(summary?.total_written_off ?? 0)}
          sublabel="Losses that could have been prevented"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Root causes"
          value={numCompact(summary?.root_cause_count ?? 0)}
          sublabel="Systemic issues identified"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Avg prevention rate"
          value={summary ? pctInt(summary.avg_prevention_rate) : '0%'}
          sublabel="Estimated leakage reduction per control"
          loading={loading}
          error={error}
        />
      </div>

      {/* Tabs: Intelligence | Rules | ROI */}
      <Tabs defaultValue="intelligence">
        <div className="overflow-x-auto">
        <TabsList>
          <TabsTrigger value="intelligence" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Prevention intelligence
          </TabsTrigger>
          <TabsTrigger value="rules" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" /> Prevention rules
          </TabsTrigger>
          <TabsTrigger value="roi" className="gap-1.5">
            <Calculator className="h-3.5 w-3.5" /> ROI calculator
          </TabsTrigger>
        </TabsList>
        </div>

        {/* ── Intelligence tab ─────────────────────────────────────── */}
        <TabsContent value="intelligence">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Systemic root causes</CardTitle>
              <CardDescription>
                Ranked by priority score · preventable leakage × recurrence rate × write-off concentration
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load prevention intelligence." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading prevention intelligence">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 8 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : intelligence.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No root causes found</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    No systemic root causes meet the recurrence and write-off thresholds.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Prevention intelligence">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Check type</TableHead>
                        <TableHead>Root cause</TableHead>
                        <TableHead className="text-right">Customers</TableHead>
                        <TableHead className="text-right">Exceptions</TableHead>
                        <TableHead className="text-right">Preventable</TableHead>
                        <TableHead className="text-right">Written off</TableHead>
                        <TableHead>Complexity</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {intelligence.map((row) => {
                        const rowKey = `${row.check_type}-${row.systemic_root_cause}`;
                        const isExpanded = expandedRows.has(rowKey);
                        const detailRowId = `prev-intel-detail-${domId(rowKey)}`;
                        return (
                          <Fragment key={rowKey}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(rowKey)}
                            >
                              <TableCell className="max-w-32 truncate text-xs font-medium" title={row.prevention_category}>
                                {row.prevention_category.replace(/_/g, ' ')}
                              </TableCell>
                              <TableCell className="max-w-36 truncate" title={row.check_type}>
                                {checkLabel(row.check_type)}
                              </TableCell>
                              <TableCell className="max-w-36 truncate text-xs" title={row.systemic_root_cause}>
                                {row.systemic_root_cause.replace(/_/g, ' ')}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {numCompact(row.affected_customers)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {numCompact(row.total_exceptions)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs font-semibold text-success">
                                {usdCompact(row.preventable_amount)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs text-destructive">
                                {usdCompact(row.annual_written_off)}
                              </TableCell>
                              <TableCell>
                                <ComplexityBadge complexity={row.implementation_complexity} />
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`${checkLabel(row.check_type)} (${row.systemic_root_cause.replace(/_/g, ' ')})`}
                                  onToggle={() => toggleExpand(rowKey)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={9} className="px-6 py-3">
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Recommended control</div>
                                      <div className="mt-0.5 text-sm">{row.recommended_control}</div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                      <div>
                                        <div className="text-xs font-semibold text-muted-foreground">Prevention rate</div>
                                        <div className="mt-0.5 font-mono text-sm">{pct(row.prevention_rate_estimate)}</div>
                                      </div>
                                      <div>
                                        <div className="text-xs font-semibold text-muted-foreground">Recurrence rate</div>
                                        <div className="mt-0.5 font-mono text-sm">{pct(row.recurrence_rate)}</div>
                                      </div>
                                      <div>
                                        <div className="text-xs font-semibold text-muted-foreground">Avg resolution time</div>
                                        <div className="mt-0.5 font-mono text-sm">{row.avg_detection_to_resolution_hrs.toFixed(1)}h</div>
                                      </div>
                                      <div>
                                        <div className="text-xs font-semibold text-muted-foreground">Priority score</div>
                                        <div className="mt-0.5 font-mono text-sm">{row.priority_score.toFixed(1)}</div>
                                      </div>
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

        {/* ── Rules tab ───────────────────────────────────────────── */}
        <TabsContent value="rules">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Prevention rules</CardTitle>
              <CardDescription>
                Actionable rules with trigger conditions, validation logic, and enforcement points
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load prevention rules." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading prevention rules">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : rules.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No rules generated</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    No prevention rules found for the current filters.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Prevention rules">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Rule ID</TableHead>
                        <TableHead>Rule name</TableHead>
                        <TableHead>Target checks</TableHead>
                        <TableHead>Enforcement</TableHead>
                        <TableHead className="text-right">Annual prevention</TableHead>
                        <TableHead className="text-right">Exception reduction</TableHead>
                        <TableHead>Complexity</TableHead>
                        <TableHead className="text-right">ROI score</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rules.map((rule) => {
                        const isExpanded = expandedRows.has(rule.rule_id);
                        const detailRowId = `prev-rule-detail-${domId(rule.rule_id)}`;
                        return (
                          <Fragment key={rule.rule_id}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(rule.rule_id)}
                            >
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {rule.rule_id}
                              </TableCell>
                              <TableCell className="max-w-48 truncate text-sm font-medium" title={rule.rule_name}>
                                {rule.rule_name}
                              </TableCell>
                              <TableCell className="max-w-36 truncate text-xs" title={rule.target_check_types}>
                                {checkLabel(rule.target_check_types)}
                              </TableCell>
                              <TableCell className="text-xs">
                                {rule.enforcement_point.replace(/_/g, ' ')}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs font-semibold text-success">
                                {usdCompact(rule.estimated_annual_prevention)}
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs">
                                {pct(rule.exception_reduction_pct / 100)}
                              </TableCell>
                              <TableCell>
                                <ComplexityBadge complexity={rule.complexity} />
                              </TableCell>
                              <TableCell className="text-right font-mono tabular-nums text-xs font-semibold">
                                {rule.roi_score.toFixed(0)}
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`rule ${rule.rule_id} ${rule.rule_name}`}
                                  onToggle={() => toggleExpand(rule.rule_id)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={9} className="px-6 py-3">
                                  <div className="grid gap-4 sm:grid-cols-2">
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Trigger condition</div>
                                      <div className="mt-0.5 text-sm">{rule.trigger_condition}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Validation logic</div>
                                      <div className="mt-0.5 text-sm">{rule.validation_logic}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Implementation steps</div>
                                      <div className="mt-0.5 text-sm">{rule.implementation_steps}</div>
                                    </div>
                                    <div>
                                      <div className="text-xs font-semibold text-muted-foreground">Data sources required</div>
                                      <div className="mt-0.5 text-sm">{rule.data_sources_required}</div>
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

        {/* ── ROI tab ────────────────────────────────────────────── */}
        <TabsContent value="roi">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Prevention ROI calculator</CardTitle>
              <CardDescription>
                Business case builder · initiatives ranked by net ROI with payback period and cumulative benefit
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load ROI analysis." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Loading ROI analysis">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 6 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : roi.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No ROI data</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    No prevention initiatives found for the given budget.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Prevention ROI calculator">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Initiative</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Annual benefit</TableHead>
                        <TableHead className="text-right">Impl. cost</TableHead>
                        <TableHead className="text-right">Payback</TableHead>
                        <TableHead className="text-right">Net ROI</TableHead>
                        <TableHead className="text-right">Cumulative</TableHead>
                        <TableHead>Recommendation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {roi.map((row) => (
                        <TooltipProvider key={row.priority_rank}>
                          <TableRow className="hover:bg-muted/50">
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {row.priority_rank}
                            </TableCell>
                            <TableCell className="max-w-48 truncate text-sm font-medium" title={row.initiative_name}>
                              {row.initiative_name}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.prevention_category.replace(/_/g, ' ')}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-xs font-semibold text-success">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help">{usdCompact(row.total_annual_benefit)}</span>
                                </TooltipTrigger>
                                <TooltipContent side="left" className="max-w-xs text-xs">
                                  <div>Leakage prevented: {usdCompact(row.annual_leakage_prevented)}</div>
                                  <div>Investigation saved: {usdCompact(row.annual_investigation_cost_saved)}</div>
                                  <div>Write-offs avoided: {usdCompact(row.annual_write_off_avoided)}</div>
                                </TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-xs">
                              {usdCompact(row.estimated_implementation_cost)}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-xs">
                              {months(row.payback_period_months)}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-xs font-semibold">
                              {row.net_roi_pct > 10000
                                ? `${(row.net_roi_pct / 1000).toFixed(0)}K%`
                                : `${row.net_roi_pct.toFixed(0)}%`}
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-xs">
                              {usdCompact(row.cumulative_benefit)}
                            </TableCell>
                            <TableCell className="max-w-40 truncate text-xs" title={row.recommendation}>
                              {row.recommendation}
                            </TableCell>
                          </TableRow>
                        </TooltipProvider>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ROI summary cards */}
          {roi.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <div className="text-xs text-muted-foreground">Total annual benefit (all initiatives)</div>
                  <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-success">
                    {usdCompact(roi.reduce((s, r) => s + r.total_annual_benefit, 0))}
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <div className="text-xs text-muted-foreground">Total implementation cost</div>
                  <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {usdCompact(roi.reduce((s, r) => s + r.estimated_implementation_cost, 0))}
                  </div>
                </CardContent>
              </Card>
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <div className="text-xs text-muted-foreground">Exceptions eliminated</div>
                  <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                    {numCompact(roi.reduce((s, r) => s + r.exceptions_eliminated, 0))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
