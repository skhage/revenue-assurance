import {
  useAnalyticsQuery,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Button,
  Textarea,
  Separator,
  Skeleton,
  Alert,
  AlertTitle,
  AlertDescription,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useEffect, useState } from 'react';
import { SeverityBadge, StatusChip } from './badges';
import { usd, num, checkLabel, accountLabel, detectionLabel } from '../lib/format';
import { CasesApiError, casesApi, NEXT_STATUS, type CasePayload, type Status, type ExceptionMeta } from '../lib/cases';
import { useWhoAmI } from '../lib/whoami';
import type { ExceptionRow } from '../lib/types';
import { publishWorkflowInvalidation, useWorkflowRevision } from '../lib/workflowInvalidation';

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right font-medium text-foreground">{v}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

interface Props {
  exception: ExceptionRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCaseChange?: () => void;
}

export function ExceptionDrawer({ exception, open, onOpenChange, onCaseChange }: Props) {
  const workflowRevision = useWorkflowRevision();
  const me = useWhoAmI();
  const { data, loading, error } = useAnalyticsQuery('exception_detail', {
    exception_id: sql.string(exception?.exception_id ?? ''),
  });
  const detail = exception ? data?.[0] : undefined;

  const [payload, setPayload] = useState<CasePayload>({ case: null, notes: [] });
  const [caseLoading, setCaseLoading] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const meta: ExceptionMeta = exception
    ? {
        reference_id: exception.reference_id,
        account_name: exception.account_name,
        check_type: exception.check_type,
        source_table: exception.source_table,
        severity: exception.severity,
        amount_at_risk: exception.amount_at_risk,
      }
    : {};

  useEffect(() => {
    if (!exception || !open) return;
    setActionError(null);
    setNote('');
    setCaseLoading(true);
    casesApi
      .get(exception.exception_id)
      .then(setPayload)
      .catch((e) => setActionError(e instanceof Error ? e.message : 'Failed to load case'))
      .finally(() => setCaseLoading(false));
  }, [exception, open, workflowRevision]);

  const status: Status = payload.case?.status ?? 'New';
  const nextStates = NEXT_STATUS[status];
  const terminal = nextStates.length === 0 && payload.case != null;

  async function run(fn: () => Promise<CasePayload>) {
    if (!exception) return;
    const exceptionId = exception.exception_id;
    setBusy(true);
    setActionError(null);
    try {
      setPayload(await fn());
      publishWorkflowInvalidation();
      onCaseChange?.();
    } catch (e) {
      if (e instanceof CasesApiError && e.code === 'VERSION_CONFLICT') {
        setPayload(await casesApi.get(exceptionId));
        setActionError(`${e.message} The latest case state is now loaded.`);
      } else {
        setActionError(e instanceof Error ? e.message : 'Action failed');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!exception) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b p-5">
          <div className="text-xs font-mono text-muted-foreground">
            {exception.reference_id || exception.exception_id.slice(0, 10)}
          </div>
          <SheetTitle className="flex items-start justify-between gap-3">
            <span className="text-base">{accountLabel(exception.account_name)}</span>
            <SeverityBadge severity={exception.severity} />
          </SheetTitle>
          <div className="mt-1 font-mono text-lg font-semibold tabular-nums text-destructive">
            {usd(exception.amount_at_risk)}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">at risk</span>
          </div>
        </SheetHeader>

        <div className="flex flex-col gap-6 p-5">
          {/* Summary */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>Detection</SectionTitle>
            <KV k="Check" v={checkLabel(exception.check_type)} />
            <KV k="Method" v={detectionLabel(exception.detection_method)} />
            <KV k="Source system" v={<span className="font-mono text-xs">{exception.source_table}</span>} />
            <KV k="Known leakage" v={exception.known_leakage_flag ? 'Yes (ground truth)' : 'Model-flagged'} />
            <KV k="Customer ID" v={exception.customer_id ? num(exception.customer_id) : '—'} />
          </div>

          <Separator />

          {/* Customer scorecard evidence */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>Customer reconciliation scorecard</SectionTitle>
            {loading && <Skeleton className="h-20 w-full" />}
            {error && <div className="text-sm text-destructive">Couldn’t load scorecard.</div>}
            {!loading && !error && detail?.risk_tier && (
              <>
                <KV k="Risk tier" v={detail.risk_tier} />
                <KV k="Health score" v={`${Math.round(detail.composite_health_score ?? 0)} / 100`} />
                <KV k="ARPU tier" v={detail.arpu_tier ?? '—'} />
                <KV k="Billing currency" v={detail.billing_currency ?? '—'} />
                <KV k="Customer exceptions" v={num(detail.customer_total_exceptions)} />
                <KV k="Customer $ at risk" v={usd(detail.customer_total_at_risk)} />
              </>
            )}
            {!loading && !error && !detail?.risk_tier && (
              <div className="text-sm text-muted-foreground">
                No scorecard — this exception isn’t attributed to a scored customer.
              </div>
            )}
          </div>

          <Separator />

          {/* Case management */}
          <div className="flex flex-col gap-3">
            <SectionTitle>Case</SectionTitle>

            {actionError && (
              <Alert variant="destructive">
                <AlertTitle>Couldn’t save</AlertTitle>
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}

            {caseLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <StatusChip status={status} />
                  <span className="text-xs text-muted-foreground">
                    {payload.case?.assignee ? `Owner: ${payload.case.assignee.split('@')[0]}` : 'Unassigned'}
                  </span>
                </div>

                {terminal ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    This case is closed ({status}).
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || payload.case?.assignee === me}
                      onClick={() =>
                        void run(() => casesApi.assign(exception.exception_id, me, payload.case?.version ?? 0, meta))
                      }
                    >
                      {payload.case?.assignee === me ? 'Assigned to you' : 'Assign to me'}
                    </Button>

                    <Select
                      disabled={busy || nextStates.length === 0}
                      onValueChange={(v) =>
                        void run(() =>
                          casesApi.changeStatus(
                            exception.exception_id,
                            v as Status,
                            note.trim() || undefined,
                            payload.case?.version ?? 0,
                            meta
                          )
                        )
                      }
                    >
                      <SelectTrigger className="h-8 w-[168px]">
                        <SelectValue placeholder="Change status…" />
                      </SelectTrigger>
                      <SelectContent>
                        {nextStates.map((s) => (
                          <SelectItem key={s} value={s}>
                            Move to {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            {/* Notes timeline */}
            <div className="flex flex-col gap-2">
              <SectionTitle>Investigation notes</SectionTitle>
              {payload.notes.length === 0 ? (
                <div className="text-sm text-muted-foreground">No notes yet.</div>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {payload.notes.map((n) => (
                    <li key={n.id} className="border-l-2 border-border pl-3">
                      <div className="text-sm text-foreground">{n.body}</div>
                      <div className="text-xs text-muted-foreground">
                        {n.author?.split('@')[0] ?? 'unknown'} · {new Date(n.created_at).toLocaleString()}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {!terminal && (
              <div className="flex flex-col gap-2">
                <Textarea
                  placeholder="Add an investigation note for the audit trail…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="min-h-16"
                />
                <Button
                  size="sm"
                  disabled={busy || !note.trim()}
                  onClick={() =>
                    void run(async () => {
                      const p = await casesApi.addNote(
                        exception.exception_id,
                        note.trim(),
                        payload.case?.version ?? 0,
                        meta
                      );
                      setNote('');
                      return p;
                    })
                  }
                >
                  Add note
                </Button>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
