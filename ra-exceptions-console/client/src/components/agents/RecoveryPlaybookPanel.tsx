import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button } from '@databricks/appkit-ui/react';
import { useState } from 'react';
import { ExceptionPicker } from './ExceptionPicker';
import { BlockedNotice } from './BlockedNotice';
import { DemoBadge } from '../DemoBadge';
import { ErrorRegion } from '../StatusRegion';
import { buildRecommendation } from '../../lib/agents/playbook';
import { casesApi, type ExceptionMeta } from '../../lib/cases';
import { useWhoAmI } from '../../lib/whoami';
import { usd } from '../../lib/format';
import { isBlocked, type PipelineHealth } from '../../lib/agents/types';
import type { ExceptionRow } from '../../lib/types';

interface Props {
  health: PipelineHealth;
  selected: ExceptionRow | null;
  onSelect: (row: ExceptionRow) => void;
}

export function RecoveryPlaybookPanel({ health, selected, onSelect }: Props) {
  if (isBlocked(health.state)) {
    return <BlockedNotice health={health} />;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[320px_1fr]">
      <ExceptionPicker selected={selected} onSelect={onSelect} label="Pick an exception for a recovery plan" />

      {!selected ? (
        <div className="rounded-md bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
          Select an exception to draft a recovery plan.
        </div>
      ) : (
        // Keyed on the selected exception so switching exceptions remounts
        // this card, resetting apply state — without an effect that calls
        // setState synchronously on every render. Note deduplication itself
        // is server-side (idempotencyKey), so it survives this remount
        // (and a full page reload) regardless.
        <RecoveryCard key={selected.exception_id} selected={selected} />
      )}
    </div>
  );
}

function RecoveryCard({ selected }: { selected: ExceptionRow }) {
  const me = useWhoAmI();
  const [applyState, setApplyState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);

  const rec = buildRecommendation(selected);

  async function applyRecovery() {
    setApplyState('busy');
    setApplyError(null);
    const meta: ExceptionMeta = {
      reference_id: selected.reference_id,
      account_name: selected.account_name,
      check_type: selected.check_type,
      severity: selected.severity,
      amount_at_risk: selected.amount_at_risk,
    };
    const note =
      `[Agent: Recovery Playbook] run_at=${new Date().toISOString()} · ` +
      `inputs={exception_id=${selected.exception_id}} · ` +
      `output={action="${rec.entry.action}", expected_recovery_usd=${rec.expectedRecoveryUsd}, owner=${rec.entry.ownerRole}, deadline=${rec.deadline}}`;
    // Stable per (agent, exception) — NOT re-derived per click. The server
    // enforces at most one note per (exception_id, idempotencyKey) pair, so
    // this call is safe to retry after a lost response, a component
    // remount, or a full page reload; it never depends on component-local
    // state to avoid duplicates, unlike a client-only "already noted" flag,
    // which is wiped out by exactly those events.
    const idempotencyKey = `agent:recovery-playbook:${selected.exception_id}`;
    try {
      // Record the human-approved recommendation BEFORE attempting any case
      // mutation. If this write fails, no mutation is attempted at all — a
      // mutation can never happen without a preceding audit record. If a
      // later mutation step fails, this note has already landed, so a
      // human reviewing the case sees exactly what was approved even if the
      // lifecycle transition didn't finish; retrying resumes at the
      // mutation, and the server-side unique index guarantees the note
      // itself is never duplicated no matter how many times this call runs.
      await casesApi.addNote(selected.exception_id, note, meta, idempotencyKey);

      // The case lifecycle only allows New→Investigating→Recovering (see
      // server/routes/cases.ts TRANSITIONS); walk that chain instead of
      // jumping straight to Recovering, which the API would reject.
      const { case: existing } = await casesApi.get(selected.exception_id);
      const status = existing?.status ?? 'New';
      if (status === 'New') {
        await casesApi.assign(selected.exception_id, existing?.assignee ?? me, meta);
        await casesApi.changeStatus(selected.exception_id, 'Investigating', undefined, meta);
      }
      if (status !== 'Recovering') {
        await casesApi.changeStatus(selected.exception_id, 'Recovering', undefined, meta);
      }
      setApplyState('done');
    } catch (e) {
      setApplyState('error');
      setApplyError(e instanceof Error ? e.message : 'Failed to move case to Recovering');
    }
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Recovery playbook</CardTitle>
          <DemoBadge kind="deterministic" />
        </div>
        <CardDescription>
          Templated action by check_type, deterministically selected — not a measured outcome.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">{rec.entry.action}</div>

        <div className="flex items-center gap-2">
          <DemoBadge kind="demo-data" />
          <p className="text-xs text-muted-foreground">
            Expected recovery %, owner, and deadline below are fixed template assumptions for this demo, not measured
            recovery-rate history — treat them as illustrative, not a forecast.
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Expected recovery</dt>
            <dd className="font-mono font-semibold tabular-nums text-foreground">{usd(rec.expectedRecoveryUsd)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Owner</dt>
            <dd className="font-medium text-foreground">{rec.entry.ownerRole}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Deadline</dt>
            <dd className="font-medium text-foreground">{new Date(rec.deadline).toLocaleDateString()}</dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">{rec.rationale}</p>

        {applyError && <ErrorRegion message={applyError} onRetry={() => void applyRecovery()} className="p-0" />}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={applyState === 'busy' || applyState === 'done'}
            onClick={() => void applyRecovery()}
          >
            {applyState === 'done' ? 'Moved to Recovering' : 'Apply: move case to Recovering'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Requires your review — nothing is applied automatically.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
