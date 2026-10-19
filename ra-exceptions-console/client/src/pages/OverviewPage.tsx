import {
  useAnalyticsQuery,
  BarChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useEffect, useState } from 'react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { analyticsApi } from '../lib/analytics';
import { triageApi } from '../lib/triage';
import { usdCompact, num, numCompact, checkLabel } from '../lib/format';
import { casesApi, STATUSES, type Status } from '../lib/cases';
import type { KpiSummary, P1Summary, PriorityDistribution } from '../lib/types';
import { AlertTriangle, Shield } from 'lucide-react';

function CaseProgress() {
  const [stats, setStats] = useState<Record<Status, number> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    casesApi
      .stats()
      .then(setStats)
      .catch(() => setFailed(true));
  }, []);
  const worked = stats ? Object.values(stats).reduce((a, b) => a + b, 0) : 0;
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Case progress</CardTitle>
        <CardDescription>
          {worked} exception{worked === 1 ? '' : 's'} worked so far · live from Lakebase
        </CardDescription>
      </CardHeader>
      <CardContent>
        {failed ? (
          <div className="text-sm text-muted-foreground">Case store unavailable.</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {STATUSES.map((s) => (
              <div key={s} className="flex flex-col">
                <span className="font-mono text-xl font-semibold tabular-nums text-foreground">
                  {stats ? num(stats[s]) : '—'}
                </span>
                <span className="text-xs text-muted-foreground">{s}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RootCauseBreakdown({ onRetry }: { onRetry: () => void }) {
  const breakdown = useAnalyticsQuery('rootcause_breakdown', { severity: sql.string('ALL') });
  const chartData = (breakdown.data ?? []).map((r) => ({
    check: checkLabel(r.check_type),
    'Amount at risk': r.amount_at_risk,
    'Exception count': r.exception_count,
  }));

  if (breakdown.loading) {
    return (
      <LoadingRegion label="Loading breakdown">
        <Skeleton className="h-72 w-full" />
      </LoadingRegion>
    );
  }
  if (breakdown.error) {
    return <ErrorRegion message="Couldn't load the breakdown from the warehouse." onRetry={onRetry} className="p-0" />;
  }
  if (chartData.length === 0) {
    return (
      <div className="p-10 text-center">
        <div className="text-sm font-medium text-foreground">No leakage detected</div>
        <div className="mt-1 text-sm text-muted-foreground">No reconciliation checks have flagged leakage yet.</div>
      </div>
    );
  }
  return (
    <Tabs defaultValue="amount">
      <TabsList>
        <TabsTrigger value="amount">By $ at risk</TabsTrigger>
        <TabsTrigger value="count">By exception count</TabsTrigger>
      </TabsList>
      <TabsContent value="amount">
        <div role="img" aria-label="Bar chart: amount at risk by reconciliation check type, sorted descending">
          <BarChart
            data={chartData}
            xKey="check"
            yKey="Amount at risk"
            orientation="horizontal"
            colorPalette="sequential"
            showLegend={false}
            height={340}
          />
        </div>
      </TabsContent>
      <TabsContent value="count">
        <div role="img" aria-label="Bar chart: exception count by reconciliation check type">
          <BarChart
            data={chartData}
            xKey="check"
            yKey="Exception count"
            orientation="horizontal"
            colorPalette="sequential"
            showLegend={false}
            height={340}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}

function P1AlertBanner() {
  const [p1, setP1] = useState<P1Summary | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ctrl = new AbortController();
    triageApi
      .p1Summary(ctrl.signal)
      .then(setP1)
      .catch(() => { /* silent — badge is supplemental */ })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, []);

  if (loading || !p1 || p1.p1_count === 0) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-5 w-5 text-destructive" />
      </div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-destructive">
          {numCompact(p1.p1_count)} P1 exceptions require immediate triage
        </div>
        <div className="text-xs text-muted-foreground">
          {usdCompact(p1.p1_amount)} at risk · SLA: 4 hours · Assigned to Dana Whitfield (VP RA)
        </div>
      </div>
      <a
        href="/queue?severity=HIGH"
        className="shrink-0 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Triage now
      </a>
    </div>
  );
}

function PriorityBreakdown() {
  const [dist, setDist] = useState<PriorityDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    triageApi
      .distribution(ctrl.signal)
      .then((d) => { setDist(d); setError(false); })
      .catch(() => { if (!ctrl.signal.aborted) setError(true); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, []);

  const priorityColors: Record<string, string> = {
    P1: 'bg-destructive text-destructive-foreground',
    P2: 'bg-orange-500 text-orange-950',
    P3: 'bg-yellow-500 text-yellow-950',
    P4: 'bg-muted text-muted-foreground',
  };

  if (loading) {
    return (
      <LoadingRegion label="Loading priority distribution">
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  if (error || dist.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        Priority distribution unavailable. Triage functions may still be initializing.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {dist.map((d) => (
        <div key={d.priority} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 items-center rounded px-2 text-xs font-bold ${priorityColors[d.priority] ?? 'bg-muted text-muted-foreground'}`}
            >
              {d.priority}
            </span>
            <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
              {numCompact(d.exception_count)}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{usdCompact(d.total_at_risk)} at risk</span>
        </div>
      ))}
    </div>
  );
}

export function OverviewPage() {
  const [kpi, setKpi] = useState<KpiSummary | null>(null);
  const [kpiLoading, setKpiLoading] = useState(true);
  const [kpiError, setKpiError] = useState(false);
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    analyticsApi
      .kpis(controller.signal)
      .then((next) => {
        setKpi(next);
        setKpiError(false);
      })
      .catch((err) => {
        if (err instanceof Error && err.name !== 'AbortError') setKpiError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setKpiLoading(false);
      });
    return () => controller.abort();
  }, [kpiRefreshKey]);

  const retryKpis = () => {
    setKpiLoading(true);
    setKpiError(false);
    setKpiRefreshKey((k) => k + 1);
  };

  // useAnalyticsQuery has no refetch callback — bump a key to remount the
  // querying subtree and re-subscribe on retry.
  const [breakdownRefreshKey, setBreakdownRefreshKey] = useState(0);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <P1AlertBanner />

      {kpiError && (
        <ErrorRegion
          message="Couldn't load overview metrics right now."
          onRetry={retryKpis}
          retryLabel="Retry overview metrics"
          className="p-4"
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Leakage at risk"
          value={usdCompact(kpi?.total_at_risk)}
          sublabel="Across all reconciliation checks"
          loading={kpiLoading}
          error={kpiError}
        />
        <KpiTile
          label="Open exceptions"
          value={numCompact(kpi?.open_exceptions)}
          sublabel="Detected across all reconciliation checks"
          loading={kpiLoading}
          error={kpiError}
        />
        <KpiTile
          label="High-severity"
          value={numCompact(kpi?.high_severity)}
          sublabel="Prioritized for triage"
          loading={kpiLoading}
          error={kpiError}
        />
        <KpiTile
          label="Accounts affected"
          value={numCompact(kpi?.accounts_affected)}
          sublabel="Distinct customers"
          loading={kpiLoading}
          error={kpiError}
        />
        <KpiTile
          label="Recovered"
          value={usdCompact(kpi?.recovered_amount)}
          sublabel={`Converted to recovered revenue · ${numCompact(kpi?.recovered_count)} cases`}
          loading={kpiLoading}
          error={kpiError}
        />
      </div>

      <CaseProgress />

      {/* AI-powered triage priority distribution */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-brand" />
            <CardTitle className="text-sm">AI triage priority distribution</CardTitle>
          </div>
          <CardDescription>
            Exceptions classified by composite urgency score · P1+P2 = 14% of volume, 97% of $ value
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PriorityBreakdown />
        </CardContent>
      </Card>

      {/* Root-cause breakdown */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle>Leakage by reconciliation check</CardTitle>
          <CardDescription>Where detected revenue leakage concentrates, by reconciliation check</CardDescription>
        </CardHeader>
        <CardContent>
          <RootCauseBreakdown key={breakdownRefreshKey} onRetry={() => setBreakdownRefreshKey((k) => k + 1)} />
        </CardContent>
      </Card>
    </div>
  );
}
