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
import { Search, AlertTriangle } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { ToggleChip } from '../components/ToggleChip';
import { SeverityBadge } from '../components/badges';
import { orderToBillApi } from '../lib/order-to-bill';
import { usdCompact, usd, numCompact } from '../lib/format';
import type {
  OrderToBillSummary,
  OrderToBillVector,
  OrderToBillException,
} from '../lib/types';

// ── Leakage vector labels ──────────────────────────────────────────────

const VECTOR_LABELS: Record<string, string> = {
  phantom_billing: 'Phantom billing',
  service_order_misalignment: 'Service-order misalignment',
  stale_in_progress: 'Stale in-progress',
  stuck_provisioned: 'Stuck provisioned',
};

function vectorLabel(v: string): string {
  return VECTOR_LABELS[v] ?? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── View toggle ─────────────────────────────────────────────────────────

type ViewMode = 'vectors' | 'exceptions';

// ── Page component ──────────────────────────────────────────────────────

export function OrderToBillPage() {
  const [summary, setSummary] = useState<OrderToBillSummary | null>(null);
  const [vectors, setVectors] = useState<OrderToBillVector[]>([]);
  const [exceptions, setExceptions] = useState<OrderToBillException[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<ViewMode>('vectors');
  const [vectorFilter, setVectorFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      orderToBillApi.summary(ctrl.signal),
      orderToBillApi.vectors(ctrl.signal),
      orderToBillApi.list(
        {
          leakage_vector: vectorFilter || undefined,
          severity: severityFilter || undefined,
          limit: 200,
        },
        ctrl.signal
      ),
    ])
      .then(([s, v, e]) => {
        setSummary(s);
        setVectors(v);
        setExceptions(e);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [vectorFilter, severityFilter, refreshKey]);

  const retry = () => setRefreshKey((k) => k + 1);

  const filteredExceptions = searchInput.trim()
    ? exceptions.filter(
        (e) =>
          String(e.exception_id).includes(searchInput) ||
          String(e.order_id).includes(searchInput) ||
          String(e.customer_id).includes(searchInput) ||
          e.leakage_vector.toLowerCase().includes(searchInput.toLowerCase()) ||
          e.order_status.toLowerCase().includes(searchInput.toLowerCase())
      )
    : exceptions;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <KpiTile
          label="Total exceptions"
          value={numCompact(summary?.total_exceptions ?? 0)}
          sublabel="Order-to-bill misalignment"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Amount at risk"
          value={usdCompact(summary?.total_at_risk ?? 0)}
          sublabel="Across all leakage vectors"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Leakage vectors"
          value={numCompact(summary?.vector_count ?? 0)}
          sublabel="Distinct misalignment patterns"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="SLA breaches"
          value={numCompact(summary?.sla_breached_count ?? 0)}
          sublabel="Orders exceeding SLA thresholds"
          loading={loading}
          error={error}
        />
      </div>

      {/* View toggle + filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View mode" className="flex items-center gap-2">
          <ToggleChip active={view === 'vectors'} onClick={() => setView('vectors')}>
            Leakage vectors
          </ToggleChip>
          <ToggleChip active={view === 'exceptions'} onClick={() => setView('exceptions')}>
            Exception list ({numCompact(filteredExceptions.length)})
          </ToggleChip>
        </div>
        {view === 'exceptions' && (
          <>
            <div role="group" aria-label="Vector filter" className="flex items-center gap-2 ml-2">
              <ToggleChip active={vectorFilter === ''} onClick={() => setVectorFilter('')}>
                All vectors
              </ToggleChip>
              {['phantom_billing', 'stale_in_progress', 'stuck_provisioned', 'service_order_misalignment'].map((v) => (
                <ToggleChip key={v} active={vectorFilter === v} onClick={() => setVectorFilter(v)}>
                  {vectorLabel(v)}
                </ToggleChip>
              ))}
            </div>
            <div role="group" aria-label="Severity filter" className="flex items-center gap-2 ml-2">
              <ToggleChip active={severityFilter === ''} onClick={() => setSeverityFilter('')}>
                All
              </ToggleChip>
              <ToggleChip active={severityFilter === 'HIGH'} onClick={() => setSeverityFilter('HIGH')}>
                High
              </ToggleChip>
              <ToggleChip active={severityFilter === 'MEDIUM'} onClick={() => setSeverityFilter('MEDIUM')}>
                Medium
              </ToggleChip>
            </div>
          </>
        )}
        <div className="ml-auto relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search ID or vector\u2026"
            className="h-9 w-56 pl-8"
            aria-label="Search order-to-bill exceptions"
          />
        </div>
      </div>

      {/* Leakage vector breakdown */}
      {view === 'vectors' && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Leakage vector breakdown</CardTitle>
            <CardDescription>
              Order-to-bill reconciliation — 4 misalignment patterns by severity and impact
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <ErrorRegion message="Couldn't load leakage vector data." onRetry={retry} />
            ) : loading ? (
              <LoadingRegion label="Loading leakage vectors">
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : vectors.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm font-medium text-foreground">No leakage vectors found</div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Leakage vector</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Exceptions</TableHead>
                      <TableHead className="text-right">Amount at risk</TableHead>
                      <TableHead className="text-right">SLA breached</TableHead>
                      <TableHead className="text-right">Avg days since order</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vectors.map((v) => (
                      <TableRow key={`${v.leakage_vector}-${v.severity}`}>
                        <TableCell className="font-medium">{vectorLabel(v.leakage_vector)}</TableCell>
                        <TableCell>
                          <SeverityBadge severity={v.severity} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {numCompact(v.exception_count)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium text-destructive">
                          {usdCompact(v.total_at_risk)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {v.sla_breached > 0 ? (
                            <span className="inline-flex items-center gap-1 text-destructive">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {numCompact(v.sla_breached)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {v.avg_days_since_order}d
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

      {/* Exception list table */}
      {view === 'exceptions' && (
        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Order-to-bill exceptions</CardTitle>
            <CardDescription>
              Individual exceptions — order/provisioning/billing state mismatches
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <ErrorRegion message="Couldn't load order-to-bill exceptions." onRetry={retry} />
            ) : loading ? (
              <LoadingRegion label="Loading exceptions">
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : filteredExceptions.length === 0 ? (
              <div className="p-10 text-center">
                <div className="text-sm font-medium text-foreground">No exceptions found</div>
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
                      <TableHead>ID</TableHead>
                      <TableHead>Vector</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Order status</TableHead>
                      <TableHead>Provisioning</TableHead>
                      <TableHead>Service state</TableHead>
                      <TableHead className="text-right">At risk</TableHead>
                      <TableHead>Urgency</TableHead>
                      <TableHead>Recommended action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredExceptions.map((e) => (
                      <TableRow key={e.exception_id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {e.exception_id}
                        </TableCell>
                        <TableCell className="text-sm">{vectorLabel(e.leakage_vector)}</TableCell>
                        <TableCell>
                          <SeverityBadge severity={e.severity} />
                        </TableCell>
                        <TableCell className="text-sm">
                          <span
                            className={`inline-flex items-center gap-1 ${
                              e.order_status === 'failed' || e.order_status === 'cancelled'
                                ? 'text-destructive'
                                : ''
                            }`}
                          >
                            {e.order_status}
                            {e.is_sla_breached && (
                              <AlertTriangle className="h-3 w-3 text-destructive" aria-label="SLA breached" />
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm">{e.provisioning_status}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {e.service_state || '\u2014'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium text-destructive">
                          {usd(e.amount_at_risk)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`text-xs font-medium ${
                              e.recovery_urgency === 'immediate'
                                ? 'text-destructive'
                                : e.recovery_urgency === 'high'
                                  ? 'text-warning'
                                  : 'text-muted-foreground'
                            }`}
                          >
                            {e.recovery_urgency || '\u2014'}
                          </span>
                        </TableCell>
                        <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground" title={e.recommended_action}>
                          {e.recommended_action || '\u2014'}
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
