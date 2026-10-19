import {
  Card,
  CardContent,
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
import {
  Search,
  AlertTriangle,
  ShieldAlert,
  Clock,
  Scale,
  RefreshCw,
  ShieldOff,
  Fingerprint,
  type LucideIcon,
} from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { ToggleChip } from '../components/ToggleChip';
import { SeverityBadge } from '../components/badges';
import { disputeApi } from '../lib/disputes';
import { usdCompact, usd, numCompact, checkLabel } from '../lib/format';
import type {
  DisputeRecord,
  DisputeSummary,
  DisputeCheckTypeBreakdown,
  DisputeCustomerSummary,
  DisputeCheckType,
} from '../lib/types';

// ── Check-type icons + labels ───────────────────────────────────────

const CHECK_META: Record<string, { label: string; icon: LucideIcon }> = {
  over_credit: { label: 'Over-credit', icon: ShieldAlert },
  fraud_pattern: { label: 'Fraud pattern', icon: Fingerprint },
  sla_breach: { label: 'SLA breach', icon: ShieldOff },
  stale_dispute: { label: 'Stale dispute', icon: Clock },
  regulatory_escalation: { label: 'Regulatory escalation', icon: Scale },
  reopened_dispute: { label: 'Reopened dispute', icon: RefreshCw },
  unauthorized_waiver: { label: 'Unauthorized waiver', icon: AlertTriangle },
};

function disputeLabel(t: string): string {
  return CHECK_META[t]?.label ?? checkLabel(t);
}

// ── View mode ────────────────────────────────────────────────────

type ViewMode = 'breakdown' | 'detail' | 'customers';

// ── Page component ────────────────────────────────────────────────

export function DisputesPage() {
  const [summary, setSummary] = useState<DisputeSummary | null>(null);
  const [breakdown, setBreakdown] = useState<DisputeCheckTypeBreakdown[]>([]);
  const [detail, setDetail] = useState<DisputeRecord[]>([]);
  const [customers, setCustomers] = useState<DisputeCustomerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<ViewMode>('breakdown');
  const [checkTypeFilter, setCheckTypeFilter] = useState<DisputeCheckType | ''>('');
  const [severityFilter, setSeverityFilter] = useState<'critical' | 'high' | 'medium' | 'low' | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Fetch all data on mount and when filters change
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      disputeApi.summary(ctrl.signal),
      disputeApi.breakdown(ctrl.signal),
      disputeApi.detail(
        {
          check_type: checkTypeFilter || undefined,
          severity: severityFilter || undefined,
          limit: 200,
        },
        ctrl.signal
      ),
      disputeApi.customers(
        { top_n: 50, check_type: checkTypeFilter || undefined },
        ctrl.signal
      ),
    ])
      .then(([s, b, d, c]) => {
        setSummary(s);
        setBreakdown(b);
        setDetail(d);
        setCustomers(c);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [checkTypeFilter, severityFilter, refreshKey]);

  const retry = () => setRefreshKey((k) => k + 1);

  // Client-side search filter
  const filteredDetail = searchInput.trim()
    ? detail.filter(
        (r) =>
          String(r.customer_id).includes(searchInput) ||
          r.account_name.toLowerCase().includes(searchInput.toLowerCase()) ||
          r.reference_id.toLowerCase().includes(searchInput.toLowerCase())
      )
    : detail;

  const filteredCustomers = searchInput.trim()
    ? customers.filter(
        (c) =>
          String(c.customer_id).includes(searchInput) ||
          c.account_name.toLowerCase().includes(searchInput.toLowerCase())
      )
    : customers;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
        <KpiTile
          label="Dispute exceptions"
          sublabel="Total across 7 check types"
          value={numCompact(summary?.total_exceptions ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Amount at risk"
          sublabel="Total billing dispute exposure"
          value={usdCompact(summary?.total_at_risk ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Customers affected"
          sublabel="Distinct customers with disputes"
          value={numCompact(summary?.customers_affected ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Critical severity"
          sublabel="Stale, regulatory, and high-value disputes"
          value={numCompact(summary?.critical_count ?? 0)}
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Fraud patterns"
          sublabel="Suspected fraudulent dispute behavior"
          value={numCompact(summary?.fraud_pattern_count ?? 0)}
          loading={loading}
          error={error}
        />
      </div>

      {/* View toggle + filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View mode" className="flex items-center gap-2">
          <ToggleChip active={view === 'breakdown'} onClick={() => setView('breakdown')}>
            Check-type breakdown
          </ToggleChip>
          <ToggleChip active={view === 'detail'} onClick={() => setView('detail')}>
            Exception detail ({numCompact(detail.length)})
          </ToggleChip>
          <ToggleChip active={view === 'customers'} onClick={() => setView('customers')}>
            Customer drill-down ({numCompact(customers.length)})
          </ToggleChip>
        </div>

        {(view === 'detail' || view === 'customers') && (
          <div role="group" aria-label="Check-type filter" className="flex items-center gap-2 ml-2">
            <ToggleChip active={checkTypeFilter === ''} onClick={() => setCheckTypeFilter('')}>
              All types
            </ToggleChip>
            <ToggleChip
              active={checkTypeFilter === 'fraud_pattern'}
              onClick={() => setCheckTypeFilter('fraud_pattern')}
            >
              Fraud
            </ToggleChip>
            <ToggleChip
              active={checkTypeFilter === 'stale_dispute'}
              onClick={() => setCheckTypeFilter('stale_dispute')}
            >
              Stale
            </ToggleChip>
            <ToggleChip
              active={checkTypeFilter === 'regulatory_escalation'}
              onClick={() => setCheckTypeFilter('regulatory_escalation')}
            >
              Regulatory
            </ToggleChip>
          </div>
        )}

        {view === 'detail' && (
          <div role="group" aria-label="Severity filter" className="flex items-center gap-2 ml-2">
            <ToggleChip active={severityFilter === ''} onClick={() => setSeverityFilter('')}>
              All
            </ToggleChip>
            <ToggleChip
              active={severityFilter === 'critical'}
              onClick={() => setSeverityFilter('critical')}
            >
              Critical
            </ToggleChip>
            <ToggleChip
              active={severityFilter === 'high'}
              onClick={() => setSeverityFilter('high')}
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
            placeholder="Search customer or ref ID\u2026"
            className="h-9 w-56 pl-8"
            aria-label="Search dispute exceptions"
          />
        </div>
      </div>

      {/* Check-type breakdown cards */}
      {view === 'breakdown' && (
        loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <Card key={i}><CardContent className="p-4"><Skeleton className="h-24 w-full" /></CardContent></Card>
            ))}
          </div>
        ) : error ? (
          <ErrorRegion message="Couldn't load dispute breakdown." onRetry={retry} />
        ) : breakdown.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-sm font-medium text-foreground">No dispute breakdowns</div>
            <div className="mt-1 text-sm text-muted-foreground">
              No billing dispute check types found at this time.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {breakdown.map((b) => {
              const meta = CHECK_META[b.check_type];
              const Icon = meta?.icon ?? AlertTriangle;
              return (
                <Card
                  key={b.check_type}
                  className="shadow-sm transition-colors hover:border-primary/30 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => {
                    setCheckTypeFilter(b.check_type as DisputeCheckType);
                    setView('detail');
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${disputeLabel(b.check_type)} exceptions`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setCheckTypeFilter(b.check_type as DisputeCheckType);
                      setView('detail');
                    }
                  }}
                >
                  <CardContent className="flex flex-col gap-3 p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span className="text-sm font-medium text-foreground">
                          {disputeLabel(b.check_type)}
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
                          {numCompact(b.customer_count)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">Customers</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      )}

      {/* Exception detail table */}
      {view === 'detail' && (
        loading ? (
          <LoadingRegion label="Loading dispute detail\u2026" />
        ) : error ? (
          <ErrorRegion message="Couldn't load dispute detail." onRetry={retry} />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-48">Reference</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Check type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead className="text-right">Amount at risk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDetail.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No disputes match the current filters
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredDetail.map((r) => (
                    <TableRow key={r.reference_id}>
                      <TableCell className="font-mono text-xs truncate max-w-[12rem]" title={r.reference_id}>
                        {r.reference_id.slice(0, 12)}\u2026
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{r.account_name}</div>
                        <div className="text-xs text-muted-foreground">ID {r.customer_id}</div>
                      </TableCell>
                      <TableCell>{disputeLabel(r.check_type)}</TableCell>
                      <TableCell>
                        <SeverityBadge severity={r.severity.toUpperCase()} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {usd(r.amount_at_risk)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        )
      )}

      {/* Customer drill-down table */}
      {view === 'customers' && (
        loading ? (
          <LoadingRegion label="Loading customer drill-down\u2026" />
        ) : error ? (
          <ErrorRegion message="Couldn't load customer drill-down." onRetry={retry} />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Exceptions</TableHead>
                  <TableHead className="text-right">Total at risk</TableHead>
                  <TableHead>Worst severity</TableHead>
                  <TableHead className="text-right">Fraud</TableHead>
                  <TableHead className="text-right">Stale</TableHead>
                  <TableHead className="text-right">Regulatory</TableHead>
                  <TableHead>Check types</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCustomers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No customers match the current filters
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCustomers.map((c) => (
                    <TableRow key={c.customer_id}>
                      <TableCell>
                        <div className="text-sm">{c.account_name}</div>
                        <div className="text-xs text-muted-foreground">ID {c.customer_id}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.exception_count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium text-destructive">
                        {usd(c.total_at_risk)}
                      </TableCell>
                      <TableCell>
                        <SeverityBadge severity={c.worst_severity.toUpperCase()} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.fraud_count}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.stale_count}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.regulatory_count}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.check_types.map(disputeLabel).join(', ')}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        )
      )}
    </div>
  );
}
