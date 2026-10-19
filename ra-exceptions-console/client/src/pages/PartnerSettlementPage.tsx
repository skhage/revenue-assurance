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
  Button,
  Input,
} from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { Search, AlertTriangle, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { ToggleChip } from '../components/ToggleChip';
import { partnerSettlementApi } from '../lib/partner-settlement';
import { usdCompact, usd, numCompact } from '../lib/format';
import { SeverityBadge } from '../components/badges';
import type {
  PartnerSettlementRecord,
  PartnerDispute,
  PartnerSettlementSummary,
} from '../lib/types';

// ── Settlement type label ─────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  interconnect: 'Interconnect',
  data_roaming: 'Data roaming',
  mvno: 'MVNO',
  wholesale: 'Wholesale',
  revenue_share: 'Revenue share',
  content_licensing: 'Content licensing',
};

function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── View toggle ───────────────────────────────────────────────────────

type ViewMode = 'reconciliation' | 'disputes';

// ── Page component ────────────────────────────────────────────────────

export function PartnerSettlementPage() {
  const [summary, setSummary] = useState<PartnerSettlementSummary | null>(null);
  const [records, setRecords] = useState<PartnerSettlementRecord[]>([]);
  const [disputes, setDisputes] = useState<PartnerDispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<ViewMode>('reconciliation');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      partnerSettlementApi.summary(ctrl.signal),
      partnerSettlementApi.reconcile(
        { severity_filter: severityFilter, limit: 200 },
        ctrl.signal
      ),
      partnerSettlementApi.disputes({ top_n: 50 }, ctrl.signal),
    ])
      .then(([s, r, d]) => {
        setSummary(s);
        setRecords(r);
        setDisputes(d);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [severityFilter, refreshKey]);

  const retry = () => setRefreshKey((k) => k + 1);

  const filteredRecords = searchInput.trim()
    ? records.filter(
        (r) =>
          String(r.partner_party_role_id).includes(searchInput) ||
          r.settlement_type.toLowerCase().includes(searchInput.toLowerCase()) ||
          r.recon_status.toLowerCase().includes(searchInput.toLowerCase())
      )
    : records;

  const filteredDisputes = searchInput.trim()
    ? disputes.filter(
        (d) =>
          String(d.partner_party_role_id).includes(searchInput) ||
          d.settlement_types.some((t) => t.toLowerCase().includes(searchInput.toLowerCase()))
      )
    : disputes;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <KpiTile
          label="Total reconciliations"
          value={numCompact(summary?.total_records ?? 0)}
          sublabel="Inter-carrier settlement records"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Actionable variances"
          value={numCompact(summary?.actionable_count ?? 0)}
          sublabel="Exceeding tolerance thresholds"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Amount at risk"
          value={usdCompact(summary?.actionable_amount ?? 0)}
          sublabel="From actionable settlement variances"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Partners affected"
          value={numCompact(summary?.partners_affected ?? 0)}
          sublabel="Distinct counterparties with variances"
          loading={loading}
          error={error}
        />
      </div>

      {/* View toggle + filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View mode" className="flex items-center gap-2">
          <ToggleChip active={view === 'reconciliation'} onClick={() => setView('reconciliation')}>
            Reconciliation detail
          </ToggleChip>
          <ToggleChip active={view === 'disputes'} onClick={() => setView('disputes')}>
            Dispute priorities ({numCompact(disputes.length)})
          </ToggleChip>
        </div>
        {view === 'reconciliation' && (
          <div role="group" aria-label="Severity filter" className="flex items-center gap-2 ml-2">
            <ToggleChip active={severityFilter === ''} onClick={() => setSeverityFilter('')}>
              All
            </ToggleChip>
            <ToggleChip
              active={severityFilter === 'CRITICAL'}
              onClick={() => setSeverityFilter('CRITICAL')}
            >
              Critical
            </ToggleChip>
            <ToggleChip
              active={severityFilter === 'HIGH'}
              onClick={() => setSeverityFilter('HIGH')}
            >
              High
            </ToggleChip>
          </div>
        )}
        <div className="ml-auto relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search partner ID or type\u2026"
            className="h-9 w-56 pl-8"
            aria-label="Search settlements"
          />
        </div>
      </div>

      {/* Reconciliation detail table */}
      {view === 'reconciliation' && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Partner settlement reconciliation</CardTitle>
            <CardDescription>
              Inter-carrier and wholesale settlement variances · powered by AI settlement agent
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <ErrorRegion message="Couldn't load partner settlement data." onRetry={retry} />
            ) : loading ? (
              <LoadingRegion label="Loading partner settlements">
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : filteredRecords.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm font-medium text-foreground">No settlement variances</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {searchInput
                    ? 'Try adjusting your search.'
                    : 'No variances match the current severity filter.'}
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Partner</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Operator billed</TableHead>
                      <TableHead className="text-right">Partner reported</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                      <TableHead className="text-right">At risk</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Open issues</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="w-10">
                        <span className="sr-only">Flags</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRecords.map((r) => (
                      <TableRow key={r.rev_share_reconciliation_id}>
                        <TableCell className="font-mono text-xs">
                          P-{r.partner_party_role_id}
                        </TableCell>
                        <TableCell className="text-xs">{typeLabel(r.settlement_type)}</TableCell>
                        <TableCell>
                          <SeverityBadge severity={r.settlement_severity} />
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {usd(r.operator_billed_amount)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                          {usd(r.partner_reported_amount)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          <span
                            className={
                              r.variance_amount > 0 ? 'text-destructive' : 'text-success'
                            }
                          >
                            {usd(Math.abs(r.variance_amount))}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {usd(r.amount_at_risk)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 text-xs ${
                              r.recon_status === 'resolved' ? 'text-success' : 'text-muted-foreground'
                            }`}
                          >
                            {r.recon_status === 'resolved' ? (
                              <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <XCircle className="h-3 w-3" aria-hidden="true" />
                            )}
                            {r.recon_status.charAt(0).toUpperCase() + r.recon_status.slice(1)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {r.open_discrepancies > 0 ? (
                            <span className="text-destructive">{r.open_discrepancies}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell
                          className="max-w-xs truncate text-xs text-muted-foreground"
                          title={r.recommended_action}
                        >
                          {r.recommended_action || '\u2014'}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {r.has_sla_breach && (
                              <ShieldAlert
                                className="h-4 w-4 text-destructive"
                                aria-label="SLA breach"
                              />
                            )}
                            {r.has_escalation && (
                              <AlertTriangle
                                className="h-4 w-4 text-warning"
                                aria-label="Escalated"
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dispute priority table */}
      {view === 'disputes' && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Partner dispute priorities</CardTitle>
            <CardDescription>
              ROI-ranked partner disputes with recovery strategy · powered by AI dispute prioritizer
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <ErrorRegion message="Couldn't load dispute priorities." onRetry={retry} />
            ) : loading ? (
              <LoadingRegion label="Loading dispute priorities">
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : filteredDisputes.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm font-medium text-foreground">No disputes found</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  No partner disputes match the current search.
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Partner</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Actionable</TableHead>
                      <TableHead className="text-right">Amount at risk</TableHead>
                      <TableHead className="text-right">Open issues</TableHead>
                      <TableHead className="text-right">Avg variance %</TableHead>
                      <TableHead className="text-right">Priority score</TableHead>
                      <TableHead>Types</TableHead>
                      <TableHead>Strategy</TableHead>
                      <TableHead className="w-10">
                        <span className="sr-only">Flags</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDisputes.map((d) => (
                      <TableRow key={d.partner_party_role_id}>
                        <TableCell className="font-mono text-xs">
                          P-{d.partner_party_role_id}
                        </TableCell>
                        <TableCell>
                          <SeverityBadge severity={d.worst_severity} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {d.actionable_recons}/{d.total_reconciliations}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {usd(d.actionable_amount_at_risk)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {d.total_open_discrepancies > 0 ? (
                            <span className="text-destructive">{d.total_open_discrepancies}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {d.avg_variance_pct.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums font-semibold">
                          {d.recovery_priority_score.toFixed(1)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {d.settlement_types.map(typeLabel).join(', ')}
                        </TableCell>
                        <TableCell
                          className="max-w-xs truncate text-xs text-muted-foreground"
                          title={d.dispute_strategy}
                        >
                          {d.dispute_strategy || '\u2014'}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {d.any_sla_breach && (
                              <ShieldAlert
                                className="h-4 w-4 text-destructive"
                                aria-label="SLA breach"
                              />
                            )}
                            {d.any_escalation && (
                              <AlertTriangle
                                className="h-4 w-4 text-warning"
                                aria-label="Escalated"
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
