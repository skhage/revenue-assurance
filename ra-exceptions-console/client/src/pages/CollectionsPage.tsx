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
  Badge,
} from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { Scale, AlertTriangle } from 'lucide-react';
import { KpiTile } from '../components/KpiTile';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { collectionsApi } from '../lib/collections';
import { usdCompact, usd, numCompact, accountLabel, checkLabel } from '../lib/format';
import { ChatPanel } from '../components/ChatPanel';
import type {
  CollectionsRecord,
  CollectionsSummary,
  CollectionsActionBreakdown,
  CollectionsAction,
} from '../lib/types';

// ── Action badge styling ────────────────────────────────────────────────────────

const ACTION_CONFIG: Record<
  string,
  { label: string; style: string; description: string }
> = {
  STOP_DUNNING: {
    label: 'Stop dunning',
    style: 'bg-destructive/10 text-destructive dark:text-red-300',
    description: 'Billing errors exceed overdue — halt collections immediately',
  },
  ADJUST_DUNNING: {
    label: 'Adjust dunning',
    style: 'bg-warning/15 text-warning',
    description: 'RA exceptions partially explain overdue — adjust collection amounts',
  },
  REVIEW_WRITE_OFF: {
    label: 'Review write-off',
    style: 'bg-primary/5 text-primary dark:text-blue-300',
    description: 'Written-off amounts may be recoverable via RA corrections',
  },
  EXPEDITE_COLLECTION: {
    label: 'Expedite',
    style: 'bg-success/10 text-green-800 dark:text-success',
    description: 'Valid overdue with no RA overlap — accelerate collection',
  },
  INVESTIGATE: {
    label: 'Investigate',
    style: 'bg-muted text-muted-foreground',
    description: 'Complex overlap requires analyst review before action',
  },
};

function ActionBadge({ action }: { action: string }) {
  const config = ACTION_CONFIG[action] ?? ACTION_CONFIG.INVESTIGATE;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${config.style}`}
    >
      {config.label}
    </span>
  );
}

// ── Action summary card ───────────────────────────────────────────────────────

function ActionCard({
  action,
  selected,
  onClick,
  loading,
}: {
  action: CollectionsActionBreakdown;
  selected: boolean;
  onClick: () => void;
  loading: boolean;
}) {
  const config = ACTION_CONFIG[action.recommended_action] ?? ACTION_CONFIG.INVESTIGATE;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`w-full rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ${
        selected
          ? 'border-brand bg-brand/5 ring-1 ring-brand'
          : 'border-border bg-card hover:border-brand/40'
      }`}
    >
      <div className="flex items-center justify-between">
        <ActionBadge action={action.recommended_action} />
        {loading ? (
          <Skeleton className="h-4 w-10" />
        ) : (
          <Badge variant="secondary" className="text-xs">
            {numCompact(action.customer_count)}
          </Badge>
        )}
      </div>
      <div className="mt-2 font-mono text-lg font-semibold tabular-nums text-foreground">
        {loading ? <Skeleton className="h-6 w-20" /> : usdCompact(action.recoverable || action.at_risk)}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        {config.description}
      </div>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function CollectionsPage() {
  const [summary, setSummary] = useState<CollectionsSummary | null>(null);
  const [actions, setActions] = useState<CollectionsActionBreakdown[]>([]);
  const [rows, setRows] = useState<CollectionsRecord[]>([]);
  const [selectedAction, setSelectedAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [queueLoading, setQueueLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Initial load: summary + action breakdown + full queue.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      collectionsApi.summary(ctrl.signal),
      collectionsApi.actions(ctrl.signal),
      collectionsApi.queue({ limit: 50 }, ctrl.signal),
    ])
      .then(([s, a, q]) => {
        setSummary(s);
        setActions(a);
        setRows(q);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [refreshKey]);

  // Filter queue when action card is clicked.
  useEffect(() => {
    if (loading) return;
    const ctrl = new AbortController();
    setQueueLoading(true);
    collectionsApi
      .queue({ action: selectedAction ?? undefined, limit: 50 }, ctrl.signal)
      .then(setRows)
      .catch(() => {
        if (!ctrl.signal.aborted) setRows([]);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setQueueLoading(false);
      });
    return () => ctrl.abort();
  }, [selectedAction, loading]);

  const retry = () => setRefreshKey((k) => k + 1);

  const toggleAction = (action: string) => {
    setSelectedAction((prev) => (prev === action ? null : action));
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          label="Recoverable"
          value={usdCompact(summary?.total_recoverable ?? 0)}
          sublabel="Collections-RA overlap recovery"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Customers affected"
          value={numCompact(summary?.total_customers ?? 0)}
          sublabel="With both RA exceptions and dunning"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Active dunning cases"
          value={numCompact(summary?.total_dunning_cases ?? 0)}
          sublabel="Across all affected customers"
          loading={loading}
          error={error}
        />
        <KpiTile
          label="Legal action"
          value={numCompact(summary?.legal_action_count ?? 0)}
          sublabel="Customers with legal proceedings"
          loading={loading}
          error={error}
        />
      </div>

      {/* Action summary cards */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recommended actions</CardTitle>
          <CardDescription>
            Click a card to filter the queue below · powered by Collections-RA Intelligence Agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <ErrorRegion message="Couldn't load action breakdown." onRetry={retry} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {loading
                ? Array.from({ length: 5 }, (_, i) => (
                    <div key={i} className="rounded-lg border border-border p-4">
                      <Skeleton className="mb-2 h-5 w-24" />
                      <Skeleton className="h-7 w-20" />
                      <Skeleton className="mt-2 h-3 w-full" />
                    </div>
                  ))
                : actions.map((a) => (
                    <ActionCard
                      key={a.recommended_action}
                      action={a}
                      selected={selectedAction === a.recommended_action}
                      onClick={() => toggleAction(a.recommended_action)}
                      loading={false}
                    />
                  ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Priority-ranked customer queue */}
      <Card className="overflow-hidden shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">
                Customer queue{selectedAction ? ` — ${(ACTION_CONFIG[selectedAction] ?? ACTION_CONFIG.INVESTIGATE).label}` : ''}
              </CardTitle>
              <CardDescription>
                Ranked by collections priority score · {rows.length} customers
              </CardDescription>
            </div>
            {selectedAction && (
              <button
                type="button"
                onClick={() => setSelectedAction(null)}
                className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
              >
                Clear filter
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <ErrorRegion message="Couldn't load collections queue." onRetry={retry} />
          ) : loading || queueLoading ? (
            <LoadingRegion label="Loading collections queue">
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </LoadingRegion>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <div className="text-sm font-medium text-foreground">No customers found</div>
              <div className="mt-1 text-sm text-muted-foreground">
                No dunning-leakage correlations match the current filter.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Segment</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="text-right">Recoverable</TableHead>
                    <TableHead className="text-right">At risk</TableHead>
                    <TableHead className="text-right">Dunning cases</TableHead>
                    <TableHead className="text-right">RA exceptions</TableHead>
                    <TableHead>Guidance</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Legal</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.customer_id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.queue_position}
                      </TableCell>
                      <TableCell className="font-medium">
                        {accountLabel(r.account_name)}
                      </TableCell>
                      <TableCell className="text-xs capitalize">
                        {r.customer_segment}
                      </TableCell>
                      <TableCell>
                        <ActionBadge action={r.recommended_action} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {r.estimated_recoverable_amount > 0
                          ? usd(r.estimated_recoverable_amount)
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                        {usd(r.ra_total_at_risk)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.dunning_active_cases}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.ra_exception_count}
                      </TableCell>
                      <TableCell
                        className="max-w-xs truncate text-xs text-muted-foreground"
                        title={r.investigation_guidance}
                      >
                        {r.investigation_guidance}
                      </TableCell>
                      <TableCell>
                        {r.has_legal_action && (
                          <Scale
                            className="h-4 w-4 text-destructive"
                            aria-label="Legal action in progress"
                          />
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

      {/* Collections assistant chat */}
      <ChatPanel />
    </div>
  );
}
