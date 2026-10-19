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
  Input,
} from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { Search, AlertTriangle, ShieldAlert, RotateCcw, Copy, Ban, UserX } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { ToggleChip } from '../components/ToggleChip';
import { SeverityBadge } from '../components/badges';
import { commissionApi } from '../lib/commission';
import { usdCompact, usd, numCompact, checkLabel } from '../lib/format';
import type {
  CommissionRecord,
  CommissionSummary,
  CommissionSubTypeBreakdown,
  CommissionAgentSummary,
  CommissionSubCheckType,
} from '../lib/types';

// ── Sub-check type icons + labels ───────────────────────────────────────

const SUB_CHECK_META: Record<string, { label: string; icon: typeof AlertTriangle }> = {
  commission_cap_violation: { label: 'Cap violation', icon: ShieldAlert },
  spec_max_exceeded: { label: 'Spec max exceeded', icon: ShieldAlert },
  unauthorized_override: { label: 'Unauthorized override', icon: UserX },
  clawback_failure: { label: 'Clawback failure', icon: RotateCcw },
  duplicate_commission: { label: 'Duplicate commission', icon: Copy },
  cancelled_order_commission: { label: 'Cancelled order', icon: Ban },
};

function subCheckLabel(t: string): string {
  return SUB_CHECK_META[t]?.label ?? checkLabel(t);
}

// ── View mode ────────────────────────────────────────────────────────

type ViewMode = 'breakdown' | 'detail' | 'agents';

// ── Page component ────────────────────────────────────────────────────

export function CommissionPage() {
  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [breakdown, setBreakdown] = useState<CommissionSubTypeBreakdown[]>([]);
  const [detail, setDetail] = useState<CommissionRecord[]>([]);
  const [agents, setAgents] = useState<CommissionAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<ViewMode>('breakdown');
  const [subCheckFilter, setSubCheckFilter] = useState<CommissionSubCheckType | ''>('');
  const [severityFilter, setSeverityFilter] = useState<'CRITICAL' | 'HIGH' | 'MEDIUM' | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch all data on mount and when filters change
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      commissionApi.summary(ctrl.signal),
      commissionApi.breakdown(ctrl.signal),
      commissionApi.detail(
        {
          sub_check_type: subCheckFilter || undefined,
          severity: severityFilter || undefined,
          limit: 200,
        },
        ctrl.signal
      ),
      commissionApi.agents(
        { top_n: 50, sub_check_type: subCheckFilter || undefined },
        ctrl.signal
      ),
    ])
      .then(([s, b, d, a]) => {
        setSummary(s);
        setBreakdown(b);
        setDetail(d);
        setAgents(a);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [subCheckFilter, severityFilter, refreshKey]);

  const retry = () => setRefreshKey((k) => k + 1);

  // Client-side search filter
  const filteredDetail = searchInput.trim()
    ? detail.filter(
        (r) =>
          String(r.sales_agent_id).includes(searchInput) ||
          String(r.commission_id).includes(searchInput) ||
          r.commission_type.toLowerCase().includes(searchInput.toLowerCase()) ||
          r.customer_segment.toLowerCase().includes(searchInput.toLowerCase())
      )
    : detail;

  const filteredAgents = searchInput.trim()
    ? agents.filter((a) => String(a.sales_agent_id).includes(searchInput))
    : agents;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
        <KpiTile
          label="Commission exceptions"
          sublabel="Total across 6 leakage types"
          value={numCompact(summary?.total_exceptions ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Amount at risk"
          sublabel="Total commission leakage exposure"
          value={usdCompact(summary?.total_at_risk ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Agents involved"
          sublabel="Distinct sales agents with exceptions"
          value={numCompact(summary?.agents_involved ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Clawback failures"
          sublabel="Commissions not recovered after cancellation"
          value={numCompact(summary?.clawback_failures ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Critical severity"
          sublabel="Duplicates, cancelled orders, large breaches"
          value={numCompact(summary?.critical_count ?? 0)}
          loading={loading}
          error={error}
        />
      </div>

      {/* View toggle + filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View mode" className="flex items-center gap-2">
          <ToggleChip active={view === 'breakdown'} onClick={() => setView('breakdown')}>
            Sub-type breakdown
          </ToggleChip>
          <ToggleChip active={view === 'detail'} onClick={() => setView('detail')}>
            Exception detail ({numCompact(detail.length)})
          </ToggleChip>
          <ToggleChip active={view === 'agents'} onClick={() => setView('agents')}>
            Agent drill-down ({numCompact(agents.length)})
          </ToggleChip>
        </div>

        {(view === 'detail' || view === 'agents') && (
          <div role="group" aria-label="Sub-check filter" className="flex items-center gap-2 ml-2">
            <ToggleChip active={subCheckFilter === ''} onClick={() => setSubCheckFilter('')}>
              All types
            </ToggleChip>
            <ToggleChip
              active={subCheckFilter === 'clawback_failure'}
              onClick={() => setSubCheckFilter('clawback_failure')}
            >
              Clawback
            </ToggleChip>
            <ToggleChip
              active={subCheckFilter === 'unauthorized_override'}
              onClick={() => setSubCheckFilter('unauthorized_override')}
            >
              Override
            </ToggleChip>
            <ToggleChip
              active={subCheckFilter === 'duplicate_commission'}
              onClick={() => setSubCheckFilter('duplicate_commission')}
            >
              Duplicate
            </ToggleChip>
          </div>
        )}

        {view === 'detail' && (
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
            placeholder="Search agent ID or type\u2026"
            className="h-9 w-56 pl-8"
            aria-label="Search commission exceptions"
          />
        </div>
      </div>

      {/* Sub-type breakdown cards */}
      {view === 'breakdown' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {error ? (
            <div className="col-span-full">
              <ErrorRegion message="Couldn't load commission breakdown." onRetry={retry} />
            </div>
          ) : loading ? (
            Array.from({ length: 6 }, (_, i) => (
              <Card key={i} className="shadow-sm">
                <CardContent className="p-5">
                  <LoadingRegion label="Loading breakdown">
                    <Skeleton className="h-24 w-full" />
                  </LoadingRegion>
                </CardContent>
              </Card>
            ))
          ) : (
            breakdown.map((b) => {
              const meta = SUB_CHECK_META[b.sub_check_type];
              const Icon = meta?.icon ?? AlertTriangle;
              return (
                <Card
                  key={b.sub_check_type}
                  className="shadow-sm transition-colors hover:border-primary/30 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => {
                    setSubCheckFilter(b.sub_check_type as CommissionSubCheckType);
                    setView('detail');
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${subCheckLabel(b.sub_check_type)} exceptions`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSubCheckFilter(b.sub_check_type as CommissionSubCheckType);
                      setView('detail');
                    }
                  }}
                >
                  <CardContent className="flex flex-col gap-3 p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span className="text-sm font-medium text-foreground">
                          {subCheckLabel(b.sub_check_type)}
                        </span>
                      </div>
                      <SeverityBadge severity={b.severity_mode} />
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                          {numCompact(b.exception_count)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">Exceptions</div>
                      </div>
                      <div>
                        <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                          {usdCompact(b.total_at_risk)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">At risk</div>
                      </div>
                      <div>
                        <div className="font-mono text-lg font-semibold tabular-nums text-foreground">
                          {numCompact(b.agent_count)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">Agents</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      )}

      {/* Exception detail table */}
      {view === 'detail' && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Commission exception detail</CardTitle>
            <CardDescription>
              Individual commission leakage exceptions · highest exposure first
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <ErrorRegion message="Couldn't load commission exceptions." onRetry={retry} />
            ) : loading ? (
              <LoadingRegion label="Loading commission detail">
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : filteredDetail.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm font-medium text-foreground">No commission exceptions</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {searchInput
                    ? 'Try adjusting your search.'
                    : 'No exceptions match the current filters.'}
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Sub-check</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Commission paid</TableHead>
                      <TableHead className="text-right">Cap / Spec max</TableHead>
                      <TableHead className="text-right">At risk</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Flags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDetail.map((r) => (
                      <TableRow key={r.commission_id}>
                        <TableCell className="font-mono text-xs">
                          {r.sales_agent_id}
                        </TableCell>
                        <TableCell className="text-xs">
                          {subCheckLabel(r.sub_check_type)}
                        </TableCell>
                        <TableCell>
                          <SeverityBadge severity={r.severity} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {usd(r.commission_paid)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {r.rule_maximum != null
                            ? usd(r.rule_maximum)
                            : r.spec_maximum != null
                              ? usd(r.spec_maximum)
                              : '\u2014'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-destructive">
                          {usd(r.amount_at_risk)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.commission_type.replace(/_/g, ' ')}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.commission_status.replace(/_/g, ' ')}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {r.clawback_flag && (
                              <span
                                className="inline-flex items-center rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
                                title="Clawback pending"
                              >
                                CLB
                              </span>
                            )}
                            {r.override_flag && (
                              <span
                                className="inline-flex items-center rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive"
                                title="Manager override"
                              >
                                OVR
                              </span>
                            )}
                            {r.split_commission_flag && (
                              <span
                                className="inline-flex items-center rounded bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold text-primary dark:text-blue-300"
                                title="Split commission"
                              >
                                SPL
                              </span>
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

      {/* Agent drill-down table */}
      {view === 'agents' && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Agent fraud drill-down</CardTitle>
            <CardDescription>
              Top sales agents by commission leakage exposure · clawback and override concentration
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <ErrorRegion message="Couldn't load agent drill-down." onRetry={retry} />
            ) : loading ? (
              <LoadingRegion label="Loading agent drill-down">
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : filteredAgents.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm font-medium text-foreground">No agents found</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {searchInput ? 'Try adjusting your search.' : 'No agents match the current filter.'}
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent ID</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Exceptions</TableHead>
                      <TableHead className="text-right">Total at risk</TableHead>
                      <TableHead className="text-right">Clawbacks</TableHead>
                      <TableHead className="text-right">Overrides</TableHead>
                      <TableHead>Leakage types</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAgents.map((a) => (
                      <TableRow key={a.sales_agent_id}>
                        <TableCell className="font-mono text-xs font-medium">
                          {a.sales_agent_id}
                        </TableCell>
                        <TableCell>
                          <SeverityBadge severity={a.worst_severity} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {numCompact(a.exception_count)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums text-destructive">
                          {usdCompact(a.total_at_risk)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {a.clawback_count > 0 ? (
                            <span className="text-warning">{numCompact(a.clawback_count)}</span>
                          ) : (
                            '\u2014'
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {a.override_count > 0 ? (
                            <span className="text-destructive">{numCompact(a.override_count)}</span>
                          ) : (
                            '\u2014'
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {a.sub_check_types.map((t) => (
                              <span
                                key={t}
                                className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                              >
                                {subCheckLabel(t)}
                              </span>
                            ))}
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
