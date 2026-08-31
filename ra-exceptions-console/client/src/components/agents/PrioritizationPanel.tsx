import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Skeleton,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { BlockedNotice } from './BlockedNotice';
import { DemoBadge } from '../DemoBadge';
import { LoadingRegion, ErrorRegion } from '../StatusRegion';
import { checkLabel, accountLabel, usd } from '../../lib/format';
import { analyticsApi } from '../../lib/analytics';
import { casesApi, type CaseRow } from '../../lib/cases';
import { rankExceptions } from '../../lib/agents/scoring';
import { isBlocked, type PipelineHealth, type PriorityScore } from '../../lib/agents/types';
import type { ExceptionRow } from '../../lib/types';

const BATCH_SIZE = 100;

interface RankedRow {
  row: ExceptionRow;
  score: PriorityScore;
}

export function PrioritizationPanel({ health }: { health: PipelineHealth }) {
  const [ranked, setRanked] = useState<RankedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (isBlocked(health.state)) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      analyticsApi.exceptions(
        { check_type: 'ALL', severity: 'ALL', search: '', row_limit: BATCH_SIZE, row_offset: 0 },
        controller.signal
      ),
      casesApi.list(false).catch(() => [] as CaseRow[]),
    ])
      .then(([rows, cases]) => {
        const createdAtById = new Map<string, string | null>(cases.map((c) => [c.exception_id, c.created_at ?? null]));
        const scores = rankExceptions(rows, createdAtById);
        const byId = new Map(rows.map((r) => [r.exception_id, r]));
        setRanked(
          scores
            .map((score) => {
              const row = byId.get(score.exception_id);
              return row ? { row, score } : null;
            })
            .filter((r): r is RankedRow => r != null)
        );
      })
      .catch((e) => {
        if (e instanceof Error && e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [health.state, refreshKey]);

  if (isBlocked(health.state)) {
    return <BlockedNotice health={health} />;
  }

  async function applyAssignment(item: RankedRow) {
    setApplyingId(item.row.exception_id);
    setApplyError(null);
    try {
      await casesApi.assign(item.row.exception_id, item.score.recommendedAnalyst, {
        reference_id: item.row.reference_id,
        account_name: item.row.account_name,
        check_type: item.row.check_type,
        severity: item.row.severity,
        amount_at_risk: item.row.amount_at_risk,
      });
      await casesApi.addNote(
        item.row.exception_id,
        `[Agent: Smart Prioritization & Routing] run_at=${new Date().toISOString()} · ` +
          `inputs={exception_id=${item.row.exception_id}} · ` +
          `output={score=${item.score.score}, recommended_analyst=${item.score.recommendedAnalyst}, recommended_queue=${item.score.recommendedQueue}}`,
        {}
      );
      setAppliedIds((prev) => new Set(prev).add(item.row.exception_id));
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'Failed to assign');
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Ranked exceptions</CardTitle>
          <DemoBadge kind="deterministic" />
        </div>
        <CardDescription>
          Score = amount (35) + severity (25) + case age (20) + evidence quality (20), highest first. Routing uses a{' '}
          <DemoBadge kind="demo-data" /> analyst roster.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorRegion
            message="Couldn't load the exception batch."
            onRetry={() => setRefreshKey((k) => k + 1)}
            className="p-0"
          />
        ) : loading ? (
          <LoadingRegion label="Ranking exceptions">
            <div className="flex flex-col gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : ranked.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No open exceptions to rank.</div>
        ) : (
          <>
            {applyError && <ErrorRegion message={applyError} className="mb-2 p-0" />}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Check</TableHead>
                    <TableHead className="text-right">$ at risk</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Recommended analyst</TableHead>
                    <TableHead>Queue</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ranked.slice(0, 20).map((item) => (
                    <TableRow key={item.row.exception_id}>
                      <TableCell className="max-w-40 truncate">{accountLabel(item.row.account_name)}</TableCell>
                      <TableCell className="text-muted-foreground">{checkLabel(item.row.check_type)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-destructive">
                        {usd(item.row.amount_at_risk)}
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold tabular-nums">
                        {item.score.score}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.score.recommendedAnalyst.split('@')[0]}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{item.score.recommendedQueue}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={applyingId === item.row.exception_id || appliedIds.has(item.row.exception_id)}
                          onClick={() => void applyAssignment(item)}
                        >
                          {appliedIds.has(item.row.exception_id) ? 'Assigned' : 'Apply: assign'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {ranked.length > 20 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing top 20 of {ranked.length} scored exceptions (batch capped at {BATCH_SIZE}).
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
