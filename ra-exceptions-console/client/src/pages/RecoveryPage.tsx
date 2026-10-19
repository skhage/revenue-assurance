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
} from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { ArrowUpRight, AlertTriangle } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { recoveryApi } from '../lib/recovery';
import { usdCompact, usd, numCompact, checkLabel, accountLabel } from '../lib/format';
import { ConfidenceBadge } from '../components/badges';
import type { RecoveryOpportunity, RecoverySummary } from '../lib/types';
import { ChatPanel } from '../components/ChatPanel';

export function RecoveryPage() {
  const [summary, setSummary] = useState<RecoverySummary | null>(null);
  const [rows, setRows] = useState<RecoveryOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      recoveryApi.summary(ctrl.signal),
      recoveryApi.actionPlan({ max_results: 50 }, ctrl.signal),
    ])
      .then(([s, r]) => {
        setSummary(s);
        setRows(r);
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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiTile
          label="Total recoverable"
          value={usdCompact(summary?.total_recoverable ?? 0)}
          sublabel="AI recovery orchestrator estimate"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Opportunities"
          value={numCompact(summary?.opportunity_count ?? 0)}
          sublabel="Customer accounts with recovery potential"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Total at risk"
          value={usdCompact(summary?.total_at_risk ?? 0)}
          sublabel="Gross leakage across all opportunities"
          loading={loading}
          error={error}
        />
      </div>

      {/* Action plan table */}
      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recovery action plan</CardTitle>
          <CardDescription>
            Ranked by estimated recoverable amount · powered by AI recovery orchestrator
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorRegion message="Couldn't load recovery opportunities." onRetry={retry} />
          ) : loading ? (
            <LoadingRegion label="Loading recovery plan">
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </LoadingRegion>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <div className="text-sm font-medium text-foreground">No recovery opportunities</div>
              <div className="mt-1 text-sm text-muted-foreground">
                The AI recovery orchestrator found no actionable opportunities at this time.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Top check type</TableHead>
                    <TableHead className="text-right">Recoverable</TableHead>
                    <TableHead className="text-right">At risk</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Action plan</TableHead>
                    <TableHead>Analyst</TableHead>
                    <TableHead className="w-10"><span className="sr-only">Escalation</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={`${r.customer_id}-${r.recovery_rank}`}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.recovery_rank}
                      </TableCell>
                      <TableCell className="font-medium">{accountLabel(r.account_name)}</TableCell>
                      <TableCell className="text-xs">{checkLabel(r.top_check_type)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {usd(r.estimated_recoverable)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                        {usd(r.total_amount_at_risk)}
                      </TableCell>
                      <TableCell>
                        <ConfidenceBadge confidence={r.recovery_confidence} />
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={r.action_plan}>
                        {r.action_plan}
                      </TableCell>
                      <TableCell className="text-xs">{r.assigned_analyst}</TableCell>
                      <TableCell>
                        {r.escalation_needed && (
                          <AlertTriangle className="h-4 w-4 text-destructive" aria-label="Escalation needed" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {/* Recovery assistant chat */}
      <ChatPanel />
    </div>
  );
}
