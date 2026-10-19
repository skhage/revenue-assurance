import {
  useAnalyticsQuery,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Button,
  Textarea,
  Input,
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
import { SeverityBadge, StatusChip, ConfidenceBadge } from './badges';
import { LoadingRegion, ErrorRegion } from './StatusRegion';
import { FileText, ExternalLink, Shield, ChevronRight, BrainCircuit, AlertTriangle } from 'lucide-react';
import { usd, num, checkLabel, accountLabel, detectionLabel, sourceLabel } from '../lib/format';
import { casesApi, NEXT_STATUS, type CasePayload, type Status, type ExceptionMeta } from '../lib/cases';
import { triageApi } from '../lib/triage';
import { evidenceApi, type EvidencePayload, type EvidenceRow, type EvidenceFormat } from '../lib/evidence';
import { architectureApi, exploreDataUrl, type ArchitectureConfig } from '../lib/architecture';
import { useWhoAmI } from '../lib/whoami';
import type { ExceptionRow, TriageClassification, PlaybookStep, AdaptiveTriageResult } from '../lib/types';
import { PriorityBadge } from './badges';

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
  const [showPdf, setShowPdf] = useState(false);

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
        <div className="mt-1 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={showPdf ? 'default' : 'outline'} size="sm" onClick={() => setShowPdf((v) => !v)}>
              <FileText className="mr-1.5 h-4 w-4" />
              {showPdf ? 'Hide PDF' : 'View PDF'}
            </Button>
            {data.document.url && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => window.open(data.document!.url!, '_blank', 'noopener,noreferrer')}
              >
                Open in workspace
                <ExternalLink className="ml-1.5 h-3.5 w-3.5 opacity-60" />
              </Button>
            )}
          </div>
          {showPdf && (
            <object
              data={`/api/documents?path=${encodeURIComponent(data.document.fileName)}`}
              type="application/pdf"
              className="h-[26rem] w-full rounded-md border border-border"
              aria-label="Source document PDF"
            >
              <div className="p-3 text-xs text-muted-foreground">
                Can’t display the PDF inline.{' '}
                {data.document.url && (
                  <a href={data.document.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    Open it in the workspace
                  </a>
                )}
              </div>
            </object>
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
  return <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
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

function TriagePanel({ exception }: { exception: ExceptionRow }) {
  const [classification, setClassification] = useState<TriageClassification | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    triageApi
      .classify(
        { check_type: exception.check_type, amount_at_risk: exception.amount_at_risk },
        ctrl.signal
      )
      .then(setClassification)
      .catch(() => { /* triage is supplemental */ })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [exception.check_type, exception.amount_at_risk]);

  if (loading) {
    return (
      <LoadingRegion label="Classifying">
        <Skeleton className="h-16 w-full" />
      </LoadingRegion>
    );
  }
  if (!classification) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <PriorityBadge priority={classification.priority} />
        <span className="text-xs text-muted-foreground">
          Urgency {classification.urgency_score}/100 · SLA {classification.sla_hours}h
        </span>
      </div>
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
        {classification.rationale}
      </div>
      <KV k="Assigned analyst" v={classification.assigned_analyst} />
    </div>
  );
}

// ConfidenceBadge imported from shared badges.tsx (single source of truth)

function AdaptiveTriagePanel({ exception }: { exception: ExceptionRow }) {
  const [result, setResult] = useState<AdaptiveTriageResult | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    triageApi
      .adaptiveTriage(
        {
          check_type: exception.check_type,
          amount_at_risk: exception.amount_at_risk,
          customer_id: exception.customer_id,
          severity: exception.severity,
        },
        ctrl.signal
      )
      .then(setResult)
      .catch(() => { /* adaptive triage is supplemental */ })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [exception.check_type, exception.amount_at_risk, exception.customer_id, exception.severity]);

  if (loading) {
    return (
      <LoadingRegion label="Loading adaptive recommendation">
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  if (!result) return null;

  const pct = (v: number) => `${(Math.round(v * 1000) / 10).toLocaleString()}%`;

  return (
    <div className="flex flex-col gap-3">
      {/* Priority + confidence header */}
      <div className="flex items-center gap-2">
        <PriorityBadge priority={result.adaptive_priority} />
        <ConfidenceBadge confidence={result.learning_confidence} />
        {result.compound_risk_flag && (
          <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Compound risk
          </span>
        )}
      </div>

      {/* Routing rationale */}
      {result.routing_rationale && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
          {result.routing_rationale}
        </div>
      )}

      {/* Key metrics grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <KV
          k="Expected recovery"
          v={<span>{usd(result.expected_recovery_value)} <span className="text-xs text-muted-foreground">({pct(result.expected_recovery_rate)})</span></span>}
        />
        <KV k="Est. hours" v={`${result.expected_hours.toFixed(1)}h`} />
        <KV k="ROI/hour" v={usd(result.recovery_roi_per_hour)} />
        <KV k="Best analyst" v={result.recommended_analyst} />
      </div>

      {/* Recommended method */}
      <KV k="Recommended method" v={result.recommended_method.replace(/_/g, ' ')} />
    </div>
  );
}

function InvestigationPlaybook({ exception }: { exception: ExceptionRow }) {
  const [steps, setSteps] = useState<PlaybookStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    triageApi
      .playbook(
        {
          check_type: exception.check_type,
          customer_id: exception.customer_id,
          amount_at_risk: exception.amount_at_risk,
          reference_id: exception.reference_id,
        },
        ctrl.signal
      )
      .then((s) => { setSteps(s); setError(false); })
      .catch(() => { if (!ctrl.signal.aborted) setError(true); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [exception.check_type, exception.customer_id, exception.amount_at_risk, exception.reference_id]);

  if (loading) {
    return (
      <LoadingRegion label="Generating playbook">
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  if (error || steps.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No investigation playbook available for this check type.
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step) => (
        <li
          key={step.step_number}
          className="rounded-md border border-border transition-colors hover:bg-muted/30"
        >
          <button
            type="button"
            onClick={() =>
              setExpandedStep((prev) => (prev === step.step_number ? null : step.step_number))
            }
            aria-expanded={expandedStep === step.step_number}
            className="flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">
              {step.step_number}
            </span>
            <span className="flex-1 text-sm font-medium text-foreground">{step.action}</span>
            <ChevronRight
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                expandedStep === step.step_number ? 'rotate-90' : ''
              }`}
            />
          </button>
          {expandedStep === step.step_number && (
            <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
              <KV k="Data source" v={step.data_source} />
              {step.query_hint && (
                <div className="rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {step.query_hint}
                </div>
              )}
              {step.escalation_trigger && (
                <div className="text-xs text-warning">
                  Escalate if: {step.escalation_trigger}
                </div>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
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
  const [pendingRecovered, setPendingRecovered] = useState(false);
  const [recoveredInput, setRecoveredInput] = useState('');
  const [ucCfg, setUcCfg] = useState<ArchitectureConfig | null>(null);

  useEffect(() => {
    if (!open || ucCfg) return;
    architectureApi
      .config()
      .then(setUcCfg)
      .catch(() => {
        /* lineage link stays hidden if config is unavailable */
      });
  }, [open, ucCfg]);

  const sourceUcUrl =
    ucCfg && exception?.source_table
      ? exploreDataUrl(ucCfg, `${ucCfg.catalog}/${exception.source_table.replace('.', '/')}`)
      : null;

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
    setPendingRecovered(false);
    setRecoveredInput('');
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
          <SheetDescription className="sr-only">
            {checkLabel(exception.check_type)} exception — {usd(exception.amount_at_risk)} at risk
          </SheetDescription>
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
            {sourceUcUrl && (
              <a
                href={sourceUcUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View source in Unity Catalog (lineage)
                <ExternalLink className="h-3.5 w-3.5 opacity-70" />
              </a>
            )}
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

          {/* AI triage classification */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>
              <span className="inline-flex items-center gap-1">
                <Shield className="h-3.5 w-3.5" /> AI triage
              </span>
            </SectionTitle>
            <TriagePanel key={`triage-${exception.exception_id}`} exception={exception} />
          </div>

          <Separator />

          {/* Adaptive triage — learning-informed recommendation */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>
              <span className="inline-flex items-center gap-1">
                <BrainCircuit className="h-3.5 w-3.5" /> Adaptive triage
              </span>
            </SectionTitle>
            <AdaptiveTriagePanel key={`adaptive-${exception.exception_id}`} exception={exception} />
          </div>

          <Separator />

          {/* Investigation playbook */}
          <div className="flex flex-col gap-2.5">
            <SectionTitle>Investigation playbook</SectionTitle>
            <InvestigationPlaybook key={`playbook-${exception.exception_id}`} exception={exception} />
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
                    {status === 'Recovered' && payload.case?.recovered_amount != null && (
                      <span className="ml-1 font-medium text-success">
                        {usd(payload.case.recovered_amount)} recovered.
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
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
                        disabled={busy || nextStates.length === 0 || pendingRecovered}
                        value=""
                        onValueChange={(v) => {
                          if (v === 'Recovered') {
                            setRecoveredInput(String(Math.round(exception.amount_at_risk)));
                            setPendingRecovered(true);
                          } else {
                            void run(() =>
                              casesApi.changeStatus(exception.exception_id, v as Status, note.trim() || undefined, meta)
                            );
                          }
                        }}
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

                    {pendingRecovered && (
                      <div className="flex flex-col gap-2 rounded-md border border-success/40 bg-success/5 p-3">
                        <label className="text-xs font-medium text-foreground" htmlFor="recovered-amt">
                          Recovered amount (USD)
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            id="recovered-amt"
                            type="number"
                            min={0}
                            inputMode="decimal"
                            value={recoveredInput}
                            onChange={(e) => setRecoveredInput(e.target.value)}
                            className="h-8 w-40"
                            aria-describedby="recovered-amt-help"
                          />
                          <Button
                            size="sm"
                            disabled={busy || recoveredInput === '' || Number(recoveredInput) < 0}
                            onClick={() =>
                              void run(async () => {
                                const p = await casesApi.changeStatus(
                                  exception.exception_id,
                                  'Recovered',
                                  note.trim() || undefined,
                                  meta,
                                  Number(recoveredInput)
                                );
                                setPendingRecovered(false);
                                return p;
                              })
                            }
                          >
                            Confirm recovery
                          </Button>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPendingRecovered(false)}>
                            Cancel
                          </Button>
                        </div>
                        <p id="recovered-amt-help" className="text-[11px] text-muted-foreground">
                          Defaults to the full amount at risk ({usd(exception.amount_at_risk)}). Adjust to the amount
                          actually recovered or prevented.
                        </p>
                      </div>
                    )}
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
                  aria-label="Investigation note"
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
