import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Alert,
  AlertTitle,
  AlertDescription,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { LoadingRegion, ErrorRegion } from '../StatusRegion';
import { dqAuditApi } from '../../lib/dqAudit';
import { isBlocked, type PipelineHealth } from '../../lib/agents/types';

export interface UsePipelineHealthResult {
  health: PipelineHealth | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * Fetches pipeline DQ health once and shares it across the Investigation,
 * Prioritization, and Recovery Playbook panels — the Pipeline Reliability
 * agent's veto is a single source of truth, not re-derived per panel.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usePipelineHealth(): UsePipelineHealthResult {
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    dqAuditApi
      .health(controller.signal)
      .then((r) => {
        setHealth(r.health);
        setError(null);
      })
      .catch((e) => {
        if (e instanceof Error && e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey]);

  return {
    health,
    loading,
    error,
    retry: () => {
      setLoading(true);
      setError(null);
      setRefreshKey((k) => k + 1);
    },
  };
}

const STATE_COPY: Record<PipelineHealth['state'], { title: string; variant: 'default' | 'destructive' }> = {
  unavailable: { title: 'Pipeline evidence unavailable', variant: 'destructive' },
  red: { title: 'Pipeline DQ checks are failing', variant: 'destructive' },
  stale: { title: 'Pipeline evidence is stale', variant: 'destructive' },
  ok: { title: 'Pipeline evidence is fresh and green', variant: 'default' },
};

export function PipelineReliabilityPanel({ result }: { result: UsePipelineHealthResult }) {
  const { health, loading, error, retry } = result;

  if (error) {
    return <ErrorRegion message="Couldn't load pipeline health." onRetry={retry} className="p-4" />;
  }
  if (loading || !health) {
    return (
      <LoadingRegion label="Loading pipeline health">
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </LoadingRegion>
    );
  }

  const copy = STATE_COPY[health.state];
  const greenCount = health.rows.filter((r) => r.status === 'GREEN').length;
  const redCount = health.rows.filter((r) => r.status === 'RED').length;

  return (
    <div className="flex flex-col gap-4">
      <Alert variant={copy.variant}>
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>{health.reason}</AlertDescription>
      </Alert>

      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">DQ audit snapshot</CardTitle>
          <CardDescription>
            From <code className="text-xs">cdm_tmforum.revenue_assurance.dq_audit</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-4">
          <div className="flex flex-col">
            <span className="font-mono text-xl font-semibold tabular-nums text-success">{greenCount}</span>
            <span className="text-xs text-muted-foreground">Checks green</span>
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-xl font-semibold tabular-nums text-destructive">{redCount}</span>
            <span className="text-xs text-muted-foreground">Checks red</span>
          </div>
          <div className="flex flex-col">
            <span className="font-mono text-sm font-medium tabular-nums text-foreground">
              {health.freshestObservedAt ? new Date(health.freshestObservedAt).toLocaleString() : '—'}
            </span>
            <span className="text-xs text-muted-foreground">Freshest observation</span>
          </div>
        </CardContent>
      </Card>

      {isBlocked(health.state) && (
        <p className="text-sm text-muted-foreground" role="status">
          Investigation, Prioritization, and Recovery Playbook recommendations are blocked until this clears — a human
          can still browse the queue directly, but no agent recommendation will render.
        </p>
      )}
    </div>
  );
}
