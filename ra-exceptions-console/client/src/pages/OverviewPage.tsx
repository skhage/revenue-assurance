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
import { usdCompact, num, numCompact, checkLabel } from '../lib/format';
import { casesApi, STATUSES, type Status } from '../lib/cases';
import type { KpiSummary } from '../lib/types';

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
        <BarChart
          data={chartData}
          xKey="check"
          yKey="Amount at risk"
          orientation="horizontal"
          colorPalette="sequential"
          showLegend={false}
          height={340}
        />
      </TabsContent>
      <TabsContent value="count">
        <BarChart
          data={chartData}
          xKey="check"
          yKey="Exception count"
          orientation="horizontal"
          colorPalette="sequential"
          showLegend={false}
          height={340}
        />
      </TabsContent>
    </Tabs>
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
      {kpiError && (
        <ErrorRegion
          message="Couldn't load overview metrics right now."
          onRetry={retryKpis}
          retryLabel="Retry overview metrics"
          className="p-4"
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
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
