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
import { FileWarning, CalendarClock, Activity, ClipboardList } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { ExpandToggle, domId } from '../components/expand-toggle';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { SeverityBadge } from '../components/badges';
import { contractComplianceApi } from '../lib/contract-compliance';
import { usdCompact, numCompact } from '../lib/format';
import type {
  ContractViolationRow,
  ExpiringContractRow,
  LifecycleRiskRow,
  ContractRiskReportRow,
  ContractComplianceSummary,
} from '../lib/types';

// ── Risk color helpers (RED / AMBER / GREEN) ──────────────────────────────────

const RISK_STYLES: Record<string, string> = {
  RED: 'bg-destructive/10 text-destructive',
  AMBER: 'bg-warning/15 text-warning',
  GREEN: 'bg-success/10 text-green-800 dark:text-success',
};

const URGENCY_STYLES: Record<string, string> = {
  CRITICAL: 'bg-destructive/10 text-destructive',
  EXPIRING_SOON: 'bg-warning/15 text-warning',
  // V23 L1: on-token. warning/10 = 6.2:1 light, 7.5:1 dark card.
  EXPIRING: 'bg-warning/10 text-warning',
  // chart-2 text on chart-2/10 is 4.45:1 in light (fails AA), so light uses
  // text-foreground + chart-2 ring; dark text-chart-2 is 4.6:1 on card.
  WATCH: 'bg-chart-2/10 text-foreground ring-1 ring-inset ring-chart-2/40 dark:text-chart-2',
  STABLE: 'bg-success/10 text-green-800 dark:text-success',
};

function RiskBadge({ risk }: { risk: string }) {
  const key = (risk || 'GREEN').toUpperCase();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        RISK_STYLES[key] ?? RISK_STYLES.GREEN
      }`}
    >
      {key}
    </span>
  );
}

// V23 L2: renamed so it no longer shadows the shared badges.tsx UrgencyBadge.
function ContractUrgencyBadge({ urgency }: { urgency: string }) {
  const key = (urgency || 'WATCH').toUpperCase().replace(/ /g, '_');
  const label = key.replace(/_/g, ' ');
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        URGENCY_STYLES[key] ?? URGENCY_STYLES.WATCH
      }`}
    >
      {label.charAt(0) + label.slice(1).toLowerCase()}
    </span>
  );
}

function RiskScoreBar({ score }: { score: number }) {
  // V21 F4: align with high-risk KPI + server route (risk_score >= 70)
  const color = score >= 70 ? 'bg-destructive' : score >= 40 ? 'bg-warning' : 'bg-success';
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2 w-16 rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label="Risk score"
      >
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(score, 100)}%` }} />
      </div>
      <span className="font-mono tabular-nums text-xs">{score}</span>
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────────────

export function ContractCompliancePage() {
  const [summary, setSummary] = useState<ContractComplianceSummary | null>(null);
  const [violations, setViolations] = useState<ContractViolationRow[]>([]);
  const [expiring, setExpiring] = useState<ExpiringContractRow[]>([]);
  const [lifecycle, setLifecycle] = useState<LifecycleRiskRow[]>([]);
  const [report, setReport] = useState<ContractRiskReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      contractComplianceApi.summary(ctrl.signal),
      contractComplianceApi.violations({}, ctrl.signal),
      contractComplianceApi.expiring({}, ctrl.signal),
      contractComplianceApi.lifecycle({}, ctrl.signal),
      contractComplianceApi.report(ctrl.signal),
    ])
      .then(([s, v, e, l, r]) => {
        setSummary(s);
        setViolations(v);
        setExpiring(e);
        setLifecycle(l);
        setReport(r);
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

  // Group report rows by section
  const reportSections = report.reduce<Record<string, ContractRiskReportRow[]>>((acc, row) => {
    const key = row.section;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile
          label="Compliance violations"
          value={numCompact(summary?.violation_count ?? 0)}
          sublabel="Contract vs billing mismatches"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Amount at risk"
          value={usdCompact(summary?.total_at_risk ?? 0)}
          sublabel="Total exposure from violations"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Customers affected"
          value={numCompact(summary?.customers_affected ?? 0)}
          sublabel="Unique accounts with findings"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Expiring soon"
          value={numCompact(summary?.expiring_count ?? 0)}
          sublabel="Critical/expiring within 180 days"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="High-risk contracts"
          value={numCompact(summary?.high_risk_count ?? 0)}
          sublabel="Risk score \u2265 70"
          loading={loading}
          error={error}
        />
      </div>

      {/* Tabs: Violations | Expiring | Lifecycle | Executive Summary */}
      <Tabs defaultValue="violations">
        <div className="overflow-x-auto">
        <TabsList>
          <TabsTrigger value="violations" className="gap-1.5">
            <FileWarning className="h-3.5 w-3.5" /> Violations
          </TabsTrigger>
          <TabsTrigger value="expiring" className="gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" /> Expiring contracts
          </TabsTrigger>
          <TabsTrigger value="lifecycle" className="gap-1.5">
            <Activity className="h-3.5 w-3.5" /> Lifecycle risks
          </TabsTrigger>
          <TabsTrigger value="report" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" /> Executive summary
          </TabsTrigger>
        </TabsList>
        </div>

        {/* ── Violations tab ─────────────────────────────────────────── */}
        <TabsContent value="violations">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Contract compliance violations</CardTitle>
              <CardDescription>
                Cross-references Salesforce contracts, parsed contract PDFs, SLA commitments, and billing records
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load compliance violations." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Scanning contract compliance">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 8 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : violations.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No violations found</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    All contracts are compliant with the current scan scope.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Contract compliance violations">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Check</TableHead>
                        <TableHead>Severity</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Contract</TableHead>
                        <TableHead className="text-right">Amount at risk</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {violations.map((row, idx) => {
                        const rowKey = `v-${row.contract_number}-${row.compliance_check}-${idx}`;
                        const isExpanded = expandedRows.has(rowKey);
                        const detailRowId = `cc-violation-detail-${domId(rowKey)}`;
                        return (
                          <Fragment key={rowKey}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(rowKey)}
                            >
                              <TableCell className="text-xs">
                                {row.compliance_check.replace(/_/g, ' ')}
                              </TableCell>
                              <TableCell>
                                <SeverityBadge severity={row.severity} />
                              </TableCell>
                              <TableCell className="text-xs">{row.account_name}</TableCell>
                              <TableCell className="font-mono text-xs">{row.contract_number}</TableCell>
                              <TableCell className="font-mono tabular-nums text-right text-xs">
                                {usdCompact(row.amount_at_risk)}
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`${row.account_name} ${row.compliance_check.replace(/_/g, ' ')}`}
                                  onToggle={() => toggleExpand(rowKey)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={6} className="px-6 py-3">
                                  <div className="space-y-2 text-xs">
                                    <div>
                                      <span className="font-semibold text-foreground">Finding: </span>
                                      <span className="text-muted-foreground">{row.finding}</span>
                                    </div>
                                    <div>
                                      <span className="font-semibold text-foreground">Action: </span>
                                      <span className="text-muted-foreground">{row.recommended_action}</span>
                                    </div>
                                    <div>
                                      <span className="font-semibold text-foreground">Sources: </span>
                                      <span className="text-muted-foreground">{row.data_sources}</span>
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

        {/* ── Expiring contracts tab ───────────────────────────────── */}
        <TabsContent value="expiring">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Expiring contracts</CardTitle>
              <CardDescription>
                Contracts approaching renewal or expiry — sorted by urgency and annual revenue
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load expiring contracts." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Detecting expiring contracts">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 8 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : expiring.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No expiring contracts</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    No contracts are approaching expiry within the selected horizon.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Expiring contracts">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Urgency</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Contract</TableHead>
                        <TableHead>SLA tier</TableHead>
                        <TableHead className="text-right">Days left</TableHead>
                        <TableHead className="text-right">Annual revenue</TableHead>
                        <TableHead>Risk</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {expiring.map((row, idx) => {
                        const rowKey = `e-${row.contract_number}-${idx}`;
                        const isExpanded = expandedRows.has(rowKey);
                        const detailRowId = `cc-expiring-detail-${domId(rowKey)}`;
                        return (
                          <Fragment key={rowKey}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(rowKey)}
                            >
                              <TableCell>
                                <ContractUrgencyBadge urgency={row.urgency} />
                              </TableCell>
                              <TableCell className="text-xs">{row.account_name}</TableCell>
                              <TableCell className="font-mono text-xs">{row.contract_number}</TableCell>
                              <TableCell className="text-xs">{row.sla_tier}</TableCell>
                              <TableCell className="font-mono tabular-nums text-right text-xs">
                                {row.days_until_expiry}
                              </TableCell>
                              <TableCell className="font-mono tabular-nums text-right text-xs">
                                {usdCompact(row.annual_revenue)}
                              </TableCell>
                              <TableCell>
                                <RiskBadge risk={row.risk_category} />
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`${row.account_name} contract ${row.contract_number}`}
                                  onToggle={() => toggleExpand(rowKey)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={8} className="px-6 py-3">
                                  <div className="space-y-2 text-xs">
                                    <div>
                                      <span className="font-semibold text-foreground">Status: </span>
                                      <span className="text-muted-foreground">{row.contract_status}</span>
                                      <span className="mx-2 text-muted-foreground">·</span>
                                      <span className="font-semibold text-foreground">Term: </span>
                                      <span className="text-muted-foreground">{row.term_months} months</span>
                                      <span className="mx-2 text-muted-foreground">·</span>
                                      <span className="font-semibold text-foreground">Auto-renew: </span>
                                      <span className="text-muted-foreground">{row.auto_renew ? 'Yes' : 'No'}</span>
                                    </div>
                                    <div>
                                      <span className="font-semibold text-foreground">Period: </span>
                                      <span className="text-muted-foreground">{row.start_date} — {row.end_date}</span>
                                    </div>
                                    <div>
                                      <span className="font-semibold text-foreground">Action: </span>
                                      <span className="text-muted-foreground">{row.recommended_action}</span>
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

        {/* ── Lifecycle risks tab ───────────────────────────────────── */}
        <TabsContent value="lifecycle">
          <Card className="overflow-hidden shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Contract lifecycle risks</CardTitle>
              <CardDescription>
                Multi-dimensional risk scoring — expiry, leakage exposure, SLA tier, and exception density
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {error ? (
                <ErrorRegion message="Couldn't load lifecycle risks." onRetry={retry} />
              ) : loading ? (
                <LoadingRegion label="Analyzing lifecycle risks">
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 8 }, (_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : lifecycle.length === 0 ? (
                <div className="p-10 text-center">
                  <div className="text-sm font-medium text-foreground">No lifecycle risks</div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    No contracts have elevated risk scores in the selected horizon.
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="Contract lifecycle risks">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Contract</TableHead>
                        <TableHead>SLA</TableHead>
                        <TableHead>Risk type</TableHead>
                        <TableHead>Score</TableHead>
                        <TableHead className="text-right">MRR</TableHead>
                        <TableHead className="text-right">Days left</TableHead>
                        <TableHead className="text-right">Exceptions</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Expand</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lifecycle.map((row, idx) => {
                        const rowKey = `l-${row.contract_number}-${row.risk_type}-${idx}`;
                        const isExpanded = expandedRows.has(rowKey);
                        const detailRowId = `cc-lifecycle-detail-${domId(rowKey)}`;
                        return (
                          <Fragment key={rowKey}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleExpand(rowKey)}
                            >
                              <TableCell className="text-xs">{row.account_name}</TableCell>
                              <TableCell className="font-mono text-xs">{row.contract_number}</TableCell>
                              <TableCell className="text-xs">{row.sla_tier}</TableCell>
                              <TableCell className="text-xs">
                                {row.risk_type.replace(/_/g, ' ')}
                              </TableCell>
                              <TableCell>
                                <RiskScoreBar score={row.risk_score} />
                              </TableCell>
                              <TableCell className="font-mono tabular-nums text-right text-xs">
                                {usdCompact(row.total_mrr)}
                              </TableCell>
                              <TableCell className="font-mono tabular-nums text-right text-xs">
                                {row.days_to_expiry}
                              </TableCell>
                              <TableCell className="font-mono tabular-nums text-right text-xs">
                                {row.existing_exceptions}
                              </TableCell>
                              <TableCell>
                                <ExpandToggle
                                  isExpanded={isExpanded}
                                  controlsId={detailRowId}
                                  name={`${row.account_name} contract ${row.contract_number} ${row.risk_type.replace(/_/g, ' ')}`}
                                  onToggle={() => toggleExpand(rowKey)}
                                />
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow id={detailRowId} className="bg-muted/30">
                                <TableCell colSpan={9} className="px-6 py-3">
                                  <div className="space-y-2 text-xs">
                                    <div>
                                      <span className="font-semibold text-foreground">Risk detail: </span>
                                      <span className="text-muted-foreground">{row.risk_detail}</span>
                                    </div>
                                    <div>
                                      <span className="font-semibold text-foreground">Action: </span>
                                      <span className="text-muted-foreground">{row.recommended_action}</span>
                                    </div>
                                    <div>
                                      <span className="font-semibold text-foreground">Existing leakage: </span>
                                      <span className="font-mono tabular-nums text-muted-foreground">
                                        {usdCompact(row.existing_leakage_amount)}
                                      </span>
                                      <span className="mx-2 text-muted-foreground">·</span>
                                      <span className="font-semibold text-foreground">Line items: </span>
                                      <span className="text-muted-foreground">{row.line_item_count}</span>
                                      <span className="mx-2 text-muted-foreground">·</span>
                                      <span className="font-semibold text-foreground">Period: </span>
                                      <span className="text-muted-foreground">{row.start_date} — {row.end_date}</span>
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

        {/* ── Executive summary tab ────────────────────────────────── */}
        <TabsContent value="report">
          {error ? (
            <ErrorRegion message="Couldn't load contract risk report." onRetry={retry} />
          ) : loading ? (
            <LoadingRegion label="Generating executive summary">
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-32 w-full" />
                ))}
              </div>
            </LoadingRegion>
          ) : Object.keys(reportSections).length === 0 ? (
            <div className="p-10 text-center">
              <div className="text-sm font-medium text-foreground">No report data</div>
              <div className="mt-1 text-sm text-muted-foreground">
                The contract risk report did not return any metrics.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {Object.entries(reportSections)
                .sort(([, a], [, b]) => (a[0]?.section_order ?? 0) - (b[0]?.section_order ?? 0))
                .map(([section, rows]) => (
                  <Card key={section} className="shadow-sm">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{section}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                      <Table aria-label={`${section} metrics`}>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Metric</TableHead>
                            <TableHead>Value</TableHead>
                            <TableHead>Detail</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((r, i) => (
                            <TableRow key={`${r.metric_name}-${i}`}>
                              <TableCell className="text-xs font-medium">{r.metric_name}</TableCell>
                              <TableCell className="font-mono tabular-nums text-xs">
                                {r.metric_value}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {r.detail}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
