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
import { analyticsApi } from '../lib/analytics';
import { usdCompact, num, numCompact, checkLabel } from '../lib/format';
import { casesApi, STATUSES, type Status } from '../lib/cases';
import type { KpiSummary } from '../lib/types';

const SOURCE = 'cdm_tmforum.revenue_assurance';

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

export function OverviewPage() {
  const [kpi, setKpi] = useState<KpiSummary | null>(null);
  const [kpiLoading, setKpiLoading] = useState(true);
  const [kpiError, setKpiError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    analyticsApi
      .kpis(controller.signal)
      .then(setKpi)
      .catch((err) => {
        if (err instanceof Error && err.name !== 'AbortError') setKpiError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setKpiLoading(false);
      });
    return () => controller.abort();
  }, []);

  const breakdown = useAnalyticsQuery('rootcause_breakdown', { severity: sql.string('ALL') });
  const chartData = (breakdown.data ?? []).map((r) => ({
    check: checkLabel(r.check_type),
    'Amount at risk': r.amount_at_risk,
    'Exception count': r.exception_count,
  }));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
          sublabel={`${SOURCE}`}
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
      </div>

      <CaseProgress />

      {/* Root-cause breakdown */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle>Leakage by reconciliation check</CardTitle>
          <CardDescription>Where detected revenue leakage concentrates · {SOURCE}.gold_leakage_summary</CardDescription>
        </CardHeader>
        <CardContent>
          {breakdown.loading && <Skeleton className="h-72 w-full" />}
          {breakdown.error && (
            <div className="text-sm text-destructive">Couldn’t load the breakdown from the warehouse.</div>
          )}
          {!breakdown.loading && !breakdown.error && (
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
