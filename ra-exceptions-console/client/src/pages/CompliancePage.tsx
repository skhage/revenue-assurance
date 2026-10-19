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
import { Search, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { ToggleChip } from '../components/ToggleChip';
import { complianceApi } from '../lib/compliance';
import { usdCompact, usd, numCompact, accountLabel } from '../lib/format';
import type { ComplianceContract, ComplianceStatusCount } from '../lib/types';

const STATUS_STYLES: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  COMPLIANT: { icon: CheckCircle2, color: 'text-success' },
  MISMATCH_DETECTED: { icon: XCircle, color: 'text-destructive' },
  MISMATCH: { icon: XCircle, color: 'text-destructive' },
  WARNING: { icon: AlertTriangle, color: 'text-warning' },
  UNMATCHED: { icon: AlertTriangle, color: 'text-muted-foreground' },
};

function ComplianceStatusBadge({ status }: { status: string }) {
  const key = (status || 'UNMATCHED').toUpperCase();
  const config = STATUS_STYLES[key] ?? STATUS_STYLES.UNMATCHED;
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${config.color}`}>
      <Icon className="h-3.5 w-3.5" />
      {key.charAt(0) + key.slice(1).toLowerCase()}
    </span>
  );
}

function MismatchDot({ value }: { value: boolean }) {
  return value ? (
    <XCircle className="h-3.5 w-3.5 text-destructive" aria-label="Mismatch" />
  ) : (
    <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-label="Match" />
  );
}

export function CompliancePage() {
  const [statusCounts, setStatusCounts] = useState<ComplianceStatusCount[]>([]);
  const [rows, setRows] = useState<ComplianceContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [mismatchOnly, setMismatchOnly] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      complianceApi.summary(ctrl.signal),
      complianceApi.scan({ mismatch_only: mismatchOnly }, ctrl.signal),
    ])
      .then(([sc, r]) => {
        setStatusCounts(sc);
        setRows(r);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [mismatchOnly, refreshKey]);

  const retry = () => setRefreshKey((k) => k + 1);
  const totalContracts = statusCounts.reduce((sum, s) => sum + s.contract_count, 0);
  const mismatchCount = statusCounts
    .filter((s) => s.compliance_status !== 'COMPLIANT')
    .reduce((sum, s) => sum + s.contract_count, 0);
  const totalBillingRisk = rows.reduce((sum, r) => sum + r.billing_amount_at_risk, 0);

  const filteredRows = searchInput.trim()
    ? rows.filter(
        (r) =>
          r.contract_number.toLowerCase().includes(searchInput.toLowerCase()) ||
          r.account_name.toLowerCase().includes(searchInput.toLowerCase())
      )
    : rows;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <KpiTile
          label="Contracts scanned"
          value={numCompact(totalContracts)}
          sublabel="AI contract compliance scanner"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Mismatches found"
          value={numCompact(mismatchCount)}
          sublabel="SLA, term, auto-renew, or status"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Billing at risk"
          value={usdCompact(totalBillingRisk)}
          sublabel="From mismatched contracts"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Compliance rate"
          value={
            totalContracts > 0
              ? `${Math.round(((totalContracts - mismatchCount) / totalContracts) * 100)}%`
              : '—'
          }
          sublabel="Contracts without mismatches"
          loading={loading}
          error={error}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Exception filter" className="flex items-center gap-2">
          <ToggleChip active={!mismatchOnly} onClick={() => setMismatchOnly(false)}>
            All contracts
          </ToggleChip>
          <ToggleChip active={mismatchOnly} onClick={() => setMismatchOnly(true)}>
            Mismatches only ({numCompact(mismatchCount)})
          </ToggleChip>
        </div>
        <div className="ml-auto relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search contract or account…"
            className="h-9 w-56 pl-8"
            aria-label="Search contracts"
          />
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Contract compliance scan</CardTitle>
          <CardDescription>
            Contract document fields vs billing system records · powered by AI compliance scanner
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorRegion message="Couldn't load compliance data." onRetry={retry} />
          ) : loading ? (
            <LoadingRegion label="Loading compliance scan">
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </LoadingRegion>
          ) : filteredRows.length === 0 ? (
            <div className="p-10 text-center">
              <div className="text-sm font-medium text-foreground">No contracts found</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {searchInput ? 'Try adjusting your search.' : 'No contracts match the current filters.'}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">SLA</TableHead>
                    <TableHead className="text-center">Term</TableHead>
                    <TableHead className="text-center">Auto-renew</TableHead>
                    <TableHead className="text-center">Doc status</TableHead>
                    <TableHead className="text-right">Mismatches</TableHead>
                    <TableHead className="text-right">Billing at risk</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((c) => (
                    <TableRow key={c.contract_number}>
                      <TableCell className="font-mono text-xs">{c.contract_number}</TableCell>
                      <TableCell className="font-medium">{accountLabel(c.account_name)}</TableCell>
                      <TableCell>
                        <ComplianceStatusBadge status={c.compliance_status} />
                      </TableCell>
                      <TableCell className="text-center">
                        <MismatchDot value={c.sla_mismatch} />
                      </TableCell>
                      <TableCell className="text-center">
                        <MismatchDot value={c.term_mismatch} />
                      </TableCell>
                      <TableCell className="text-center">
                        <MismatchDot value={c.auto_renew_mismatch} />
                      </TableCell>
                      <TableCell className="text-center">
                        <MismatchDot value={c.status_mismatch} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {c.total_mismatches}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {usd(c.billing_amount_at_risk)}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={c.compliance_detail}>
                        {c.compliance_detail}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
