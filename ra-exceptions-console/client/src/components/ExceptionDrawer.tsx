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
import { LoadingRegion, ErrorRegion } from './StatusRegion';
import { FileText, ExternalLink } from 'lucide-react';
import { usd, num, checkLabel, accountLabel, detectionLabel, sourceLabel } from '../lib/format';
import { casesApi, NEXT_STATUS, type CasePayload, type Status, type ExceptionMeta } from '../lib/cases';
import { evidenceApi, type EvidencePayload, type EvidenceRow, type EvidenceFormat } from '../lib/evidence';
import { useWhoAmI } from '../lib/whoami';
import type { ExceptionRow } from '../lib/types';

function fmtEvidence(v: unknown, format?: EvidenceFormat): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (format) {
    case 'usd':
      return usd(typeof v === 'number' ? v : Number(v));
    case 'int':
      return num(typeof v === 'number' ? v : Number(v));
    case 'bool':
      return v === true || v === 'true' ? 'Yes' : 'No';
    case 'pct': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return String(v);
      const pct = Math.abs(n) <= 1 ? n * 100 : n; // ratios (0.15) → 15%, percent-points (30) → 30%
      return `${(Math.round(pct * 10) / 10).toLocaleString()}%`;
    }
    default:
      return String(v);
  }
}

function EvidenceSection({ exception }: { exception: ExceptionRow }) {
  const [data, setData] = useState<EvidencePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    evidenceApi
      .get(
        { check_type: exception.check_type, reference_id: exception.reference_id, customer_id: exception.customer_id },
        ctrl.signal
      )
      .then((p) => setData(p))
      .catch(() => {
        if (!ctrl.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [exception.check_type, exception.reference_id, exception.customer_id, reloadKey]);

  if (loading) {
    return (
      <LoadingRegion label="Loading evidence">
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  if (error) {
    return <ErrorRegion message="Couldn't load detection evidence." onRetry={() => setReloadKey((k) => k + 1)} className="p-0" />;
  }
  if (!data || data.rows.length === 0) {
    return (
      <div role="status" className="text-sm text-muted-foreground">
        {data?.note ?? 'No additional detection evidence for this exception.'}
      </div>
    );
  }

  const comp = data.comparison;
  const compRows = data.rows.filter((r) => r.left !== undefined || r.right !== undefined);
  const kvRows = data.rows.filter((r) => r.left === undefined && r.right === undefined);

  return (
    <div className="flex flex-col gap-3">
      {comp && compRows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1.1fr_1fr_1fr] gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span />
            <span className="text-right">{comp.leftLabel}</span>
            <span className="text-right">{comp.rightLabel}</span>
          </div>
          {compRows.map((r: EvidenceRow) => (
            <div
              key={r.label}
              className={`grid grid-cols-[1.1fr_1fr_1fr] items-baseline gap-2 px-3 py-1.5 text-sm ${
                r.mismatch ? 'bg-destructive/5' : ''
              }`}
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span
                className={`text-right font-medium tabular-nums ${r.mismatch ? 'text-destructive' : 'text-foreground'}`}
              >
                {fmtEvidence(r.left, r.format)}
              </span>
              <span className="text-right font-medium tabular-nums text-foreground">
                {fmtEvidence(r.right, r.format)}
              </span>
            </div>
          ))}
        </div>
      )}
      {kvRows.map((r: EvidenceRow) => (
        <KV key={r.label} k={r.label} v={fmtEvidence(r.value, r.format)} />
      ))}
      {data.document && (
        <div className="mt-1">
          {data.document.url ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(data.document!.url!, '_blank', 'noopener,noreferrer')}
            >
              <FileText className="mr-1.5 h-4 w-4" />
              {data.document.label}
              <ExternalLink className="ml-1.5 h-3.5 w-3.5 opacity-60" />
            </Button>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              <span className="font-mono">{data.document.fileName}</span>
            </div>
          )}
        </div>
      )}
      {data.note && <p className="text-xs leading-relaxed text-muted-foreground">{data.note}</p>}
    </div>
  );
}

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

function CustomerScorecard({ exceptionId, onRetry }: { exceptionId: string; onRetry: () => void }) {
  const { data, loading, error } = useAnalyticsQuery('exception_detail', {
    exception_id: sql.string(exceptionId),
  });
  const detail = data?.[0];

  if (loading) {
    return (
      <LoadingRegion label="Loading scorecard">
        <Skeleton className="h-20 w-full" />
      </LoadingRegion>
    );
  }
  if (error) {
    return <ErrorRegion message="Couldn't load scorecard." onRetry={onRetry} className="p-0" />;
  }
  if (!detail?.risk_tier) {
    return (
      <div role="status" className="text-sm text-muted-foreground">
        No scorecard — this exception isn’t attributed to a scored customer.
      </div>
    );
  }
  return (
    <>
      <KV k="Risk tier" v={detail.risk_tier} />
      <KV k="Health score" v={`${Math.round(detail.composite_health_score ?? 0)} / 100`} />
      <KV k="ARPU tier" v={detail.arpu_tier ?? '—'} />
      <KV k="Billing currency" v={detail.billing_currency ?? '—'} />
      <KV k="Customer exceptions" v={num(detail.customer_total_exceptions)} />
      <KV k="Customer $ at risk" v={usd(detail.customer_total_at_risk)} />
    </>
  );
}

interface Props {
  exception: ExceptionRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCaseChange?: () => void;
}

export function ExceptionDrawer({ exception, open, onOpenChange, onCaseChange }: Props) {
  const me = useWhoAmI();
  const [scorecardRefreshKey, setScorecardRefreshKey] = useState(0);

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
        severity: exception.severity,
        amount_at_risk: exception.amount_at_risk,
      }
    : {};

  useEffect(() => {
    if (!exception || !open) return;
    setActionError(null);
    setNote('');
    setScorecardRefreshKey(0);
    setCaseLoading(true);
    casesApi
      .get(exception.exception_id)
      .then(setPayload)
      .catch((e) => setActionError(e instanceof Error ? e.message : 'Failed to load case'))
      .finally(() => setCaseLoading(false));
  }, [exception, open]);

  const status: Status = payload.case?.status ?? 'New';
  const nextStates = NEXT_STATUS[status];
  const terminal = nextStates.length === 0 && payload.case != null;

  async function run(fn: () => Promise<CasePayload>) {
    setBusy(true);
    setActionError(null);
    try {
      setPayload(await fn());
      onCaseChange?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
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
            <KV k="Source system" v={<span className="text-xs">{sourceLabel(exception.source_table)}</span>} />
            <KV k="Known leakage" v={exception.known_leakage_flag ? 'Yes (seeded ground truth)' : 'No'} />
            <KV k="Customer ID" v={exception.customer_id ? num(exception.customer_id) : '—'} />
          </div>

          <Separator />

          {/* Check-type-aware reconciliation evidence */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>Reconciliation evidence</SectionTitle>
            <EvidenceSection key={exception.exception_id} exception={exception} />
          </div>

          <Separator />

          {/* Customer scorecard evidence */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>Customer reconciliation scorecard</SectionTitle>
            <CustomerScorecard
              key={scorecardRefreshKey}
              exceptionId={exception.exception_id}
              onRetry={() => setScorecardRefreshKey((k) => k + 1)}
            />
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
              <LoadingRegion label="Loading case">
                <Skeleton className="h-24 w-full" />
              </LoadingRegion>
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
                      onClick={() => void run(() => casesApi.assign(exception.exception_id, me, meta))}
                    >
                      {payload.case?.assignee === me ? 'Assigned to you' : 'Assign to me'}
                    </Button>

                    <Select
                      disabled={busy || nextStates.length === 0}
                      onValueChange={(v) =>
                        void run(() =>
                          casesApi.changeStatus(exception.exception_id, v as Status, note.trim() || undefined, meta)
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
                      const p = await casesApi.addNote(exception.exception_id, note.trim(), meta);
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
