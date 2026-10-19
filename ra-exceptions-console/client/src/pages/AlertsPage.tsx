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
import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, Radio } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { alertsApi } from '../lib/alerts';
import { usdCompact, usd, numCompact, checkLabel, accountLabel } from '../lib/format';
import type { EmergingRisk, LeakageAlert, CriticalSummary } from '../lib/types';

const SIGNAL_STYLES: Record<string, string> = {
  CRITICAL: 'bg-destructive/10 text-destructive',
  ELEVATED: 'bg-warning/15 text-amber-800 dark:text-warning',
  WATCH: 'bg-muted text-muted-foreground',
};

const SIGNAL_DOT: Record<string, string> = {
  CRITICAL: 'bg-destructive',
  ELEVATED: 'bg-warning',
  WATCH: 'bg-muted-foreground',
};

function SignalBadge({ signal }: { signal: string }) {
  const key = (signal || 'WATCH').toUpperCase();
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        SIGNAL_STYLES[key] ?? SIGNAL_STYLES.WATCH
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${SIGNAL_DOT[key] ?? SIGNAL_DOT.WATCH}`} />
      {key}
    </span>
  );
}

const ALERT_SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: 'bg-destructive text-destructive-foreground dark:bg-red-900 dark:text-red-100',
  ELEVATED: 'bg-orange-500 text-orange-950',
  WATCH: 'bg-muted text-muted-foreground',
};

function AlertSeverityBadge({ severity }: { severity: string }) {
  const key = (severity || 'WATCH').toUpperCase();
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold ${
        ALERT_SEVERITY_STYLES[key] ?? ALERT_SEVERITY_STYLES.WATCH
      }`}
    >
      {key}
    </span>
  );
}

function EmergingRiskTable({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: EmergingRisk[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return <ErrorRegion message="Couldn't load emerging risk data." onRetry={onRetry} />;
  }
  if (loading) {
    return (
      <LoadingRegion label="Loading emerging risks">
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </LoadingRegion>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-10 text-center">
        <div className="text-sm font-medium text-foreground">No emerging risks detected</div>
        <div className="mt-1 text-sm text-muted-foreground">
          The predictive alerting system has not detected any emerging leakage patterns.
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Risk tier</TableHead>
            <TableHead>Signal</TableHead>
            <TableHead className="text-right">At risk</TableHead>
            <TableHead className="text-right">Exceptions</TableHead>
            <TableHead>Dominant check</TableHead>
            <TableHead className="text-right">Anomaly score</TableHead>
            <TableHead>Rationale</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.customer_id}>
              <TableCell className="font-medium">{accountLabel(r.account_name)}</TableCell>
              <TableCell className="text-xs">{r.risk_tier}</TableCell>
              <TableCell>
                <SignalBadge signal={r.emerging_risk_signal} />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {usd(r.total_amount_at_risk)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {r.total_exceptions}
              </TableCell>
              <TableCell className="text-xs">{checkLabel(r.dominant_check_type)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {r.max_anomaly_score.toFixed(2)}
              </TableCell>
              <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={r.risk_rationale}>
                {r.risk_rationale}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LeakageAlertTable({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: LeakageAlert[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return <ErrorRegion message="Couldn't load leakage alerts." onRetry={onRetry} />;
  }
  if (loading) {
    return (
      <LoadingRegion label="Loading alerts">
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </LoadingRegion>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-10 text-center">
        <div className="text-sm font-medium text-foreground">No active alerts</div>
        <div className="mt-1 text-sm text-muted-foreground">No leakage alerts meet the current filter criteria.</div>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Severity</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Title</TableHead>
            <TableHead className="text-right">At risk</TableHead>
            <TableHead className="text-right">Customers</TableHead>
            <TableHead>Recommended action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a) => (
            <TableRow key={a.alert_id}>
              <TableCell>
                <AlertSeverityBadge severity={a.severity} />
              </TableCell>
              <TableCell className="text-xs">{a.alert_type.replace(/_/g, ' ')}</TableCell>
              <TableCell className="font-medium">{a.title}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {usd(a.total_amount_at_risk)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {a.affected_customers}
              </TableCell>
              <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={a.recommended_action}>
                {a.recommended_action}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function AlertsPage() {
  const [criticalSummary, setCriticalSummary] = useState<CriticalSummary | null>(null);
  const [emergingRisks, setEmergingRisks] = useState<EmergingRisk[]>([]);
  const [leakageAlerts, setLeakageAlerts] = useState<LeakageAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      alertsApi.criticalSummary(ctrl.signal),
      alertsApi.emerging({}, ctrl.signal),
      alertsApi.leakage({ severity_floor: 'WATCH' }, ctrl.signal),
    ])
      .then(([cs, er, la]) => {
        setCriticalSummary(cs);
        setEmergingRisks(er);
        setLeakageAlerts(la);
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
  const criticalRisks = emergingRisks.filter((r) => r.emerging_risk_signal === 'CRITICAL');
  const elevatedRisks = emergingRisks.filter((r) => r.emerging_risk_signal === 'ELEVATED');

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiTile
          label="Critical signals"
          value={numCompact(criticalSummary?.critical_count ?? 0)}
          sublabel="Customers with CRITICAL emerging risk"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Critical amount"
          value={usdCompact(criticalSummary?.critical_amount ?? 0)}
          sublabel="Revenue at risk from critical signals"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Active alerts"
          value={numCompact(leakageAlerts.length)}
          sublabel="Structured leakage alerts generated by AI"
          loading={loading}
          error={error}
        />
      </div>

      {/* Tabbed view */}
      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Predictive alerting</CardTitle>
          <CardDescription>
            AI-powered risk detection · emerging leakage signals and structured alerts
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Tabs defaultValue="emerging" className="w-full">
            <div className="border-b px-4 pt-2">
              <TabsList>
                <TabsTrigger value="emerging">
                  <Radio className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Emerging risks ({emergingRisks.length})
                </TabsTrigger>
                <TabsTrigger value="alerts">
                  <AlertTriangle className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Alerts ({leakageAlerts.length})
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="emerging">
              <EmergingRiskTable rows={emergingRisks} loading={loading} error={error} onRetry={retry} />
            </TabsContent>
            <TabsContent value="alerts">
              <LeakageAlertTable rows={leakageAlerts} loading={loading} error={error} onRetry={retry} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
