import {
  useAnalyticsQuery,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useState } from 'react';
import { ExceptionPicker } from './ExceptionPicker';
import { BlockedNotice } from './BlockedNotice';
import { DemoBadge } from '../DemoBadge';
import { LoadingRegion, ErrorRegion } from '../StatusRegion';
import { buildHypothesis, type ExceptionDetailRow } from '../../lib/agents/hypothesis';
import { beginApprovedRun, completeApprovedRun, type ApprovedRun } from '../../lib/agents/approvedRun';
import { casesApi, type ExceptionMeta } from '../../lib/cases';
import { isBlocked, type PipelineHealth } from '../../lib/agents/types';
import type { ExceptionRow } from '../../lib/types';

interface Props {
  health: PipelineHealth;
  selected: ExceptionRow | null;
  onSelect: (row: ExceptionRow) => void;
}

function noteBody(exceptionId: string, hypothesis: ReturnType<typeof buildHypothesis>, approvedAt: string): string {
  return (
    `[Agent: Exception Investigation] run_at=${approvedAt} · ` +
    `inputs={exception_id=${exceptionId}} · ` +
    `output={confidence=${hypothesis.confidence}, hypothesis="${hypothesis.text}", next_step="${hypothesis.nextStep}"}`
  );
}

export function InvestigationPanel({ health, selected, onSelect }: Props) {
  if (isBlocked(health.state)) {
    return <BlockedNotice health={health} />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[320px_1fr]">
      <ExceptionPicker selected={selected} onSelect={onSelect} label="Pick an exception to investigate" />

      {!selected ? (
        <div className="rounded-md bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
          Select an exception to see a cited root-cause hypothesis.
        </div>
      ) : (
        // Keyed on the selected exception (plus an internal retry counter
        // folded in below) so switching exceptions remounts this subtree —
        // resetting local apply state and forcing a fresh evidence fetch
        // (useAnalyticsQuery has no public restart method) — without an
        // effect that calls setState synchronously on every render.
        <EvidenceCard key={selected.exception_id} selected={selected} />
      )}
    </div>
  );
}

function EvidenceCard({ selected }: { selected: ExceptionRow }) {
  const [retryKey, setRetryKey] = useState(0);
  return <EvidenceCardInner key={retryKey} selected={selected} onRetryEvidence={() => setRetryKey((k) => k + 1)} />;
}

function EvidenceCardInner({ selected, onRetryEvidence }: { selected: ExceptionRow; onRetryEvidence: () => void }) {
  const [applyState, setApplyState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);

  const detailQuery = useAnalyticsQuery('exception_detail', { exception_id: sql.string(selected.exception_id) });
  const detail = detailQuery.data?.[0] as ExceptionDetailRow | undefined;

  async function applyAsNote() {
    if (!detail) return;
    setApplyState('busy');
    setApplyError(null);
    const hypothesis = buildHypothesis(detail);
    const meta: ExceptionMeta = {
      reference_id: selected.reference_id,
      account_name: selected.account_name,
      check_type: selected.check_type,
      severity: selected.severity,
      amount_at_risk: selected.amount_at_risk,
    };
    let run: ApprovedRun;
    try {
      run = beginApprovedRun('exception-investigation', selected.exception_id, (approvedAt) =>
        noteBody(selected.exception_id, hypothesis, approvedAt)
      );
    } catch (e) {
      setApplyState('error');
      setApplyError(e instanceof Error ? e.message : 'Failed to persist approved run');
      return;
    }
    try {
      await casesApi.addNote(selected.exception_id, run.noteBody, meta, run.idempotencyKey);
      completeApprovedRun('exception-investigation', selected.exception_id, run.idempotencyKey);
      setApplyState('done');
    } catch (e) {
      setApplyState('error');
      setApplyError(e instanceof Error ? e.message : 'Failed to add note');
    }
  }

  if (detailQuery.loading) {
    return (
      <LoadingRegion label="Loading exception evidence">
        <Skeleton className="h-40 w-full" />
      </LoadingRegion>
    );
  }
  if (detailQuery.error) {
    return (
      <ErrorRegion message="Couldn't load evidence for this exception." onRetry={onRetryEvidence} className="p-4" />
    );
  }
  if (!detail) {
    return (
      <div className="rounded-md bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
        No evidence found for this exception.
      </div>
    );
  }

  const hypothesis = buildHypothesis(detail);
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Root-cause hypothesis</CardTitle>
          <DemoBadge kind="deterministic" />
        </div>
        <CardDescription>Cited from the evidence fields below — nothing here is invented.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-foreground">{hypothesis.text}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Confidence:</span>
          <span className="font-mono font-semibold text-foreground">{hypothesis.confidence}/100</span>
        </div>
        <div className="rounded-md bg-muted px-3 py-2 text-sm">
          <span className="font-medium text-foreground">Recommended next step: </span>
          {hypothesis.nextStep}
        </div>

        {applyError && <ErrorRegion message={applyError} onRetry={() => void applyAsNote()} className="p-0" />}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={applyState === 'busy' || applyState === 'done'}
            onClick={() => void applyAsNote()}
          >
            {applyState === 'done' ? 'Added to case notes' : 'Add hypothesis as investigation note'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Requires your review — nothing is applied automatically.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
