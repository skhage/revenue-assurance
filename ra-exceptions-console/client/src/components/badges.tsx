// Semantic status/severity chips. Colors come only from design tokens
// (destructive / warning / success / primary / muted) — never raw hex.

const SEV_STYLES: Record<string, string> = {
  CRITICAL: 'bg-destructive/10 text-destructive dark:text-red-200',
  HIGH: 'bg-destructive/10 text-destructive',
  MEDIUM: 'bg-warning/15 text-warning',
  LOW: 'bg-muted text-muted-foreground',
};

const SEV_DOT: Record<string, string> = {
  CRITICAL: 'bg-destructive',
  HIGH: 'bg-destructive',
  MEDIUM: 'bg-warning',
  LOW: 'bg-muted-foreground',
};

export function SeverityBadge({ severity }: { severity: string }) {
  const key = (severity || 'LOW').toUpperCase();
  const label = key.charAt(0) + key.slice(1).toLowerCase();
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        SEV_STYLES[key] ?? SEV_STYLES.LOW
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[key] ?? SEV_DOT.LOW}`} />
      {label}
    </span>
  );
}

// ── Confidence badge (recovery page, exception drawer) ────────────────────────

const CONFIDENCE_STYLES: Record<string, string> = {
  HIGH: 'bg-success/10 text-green-800 dark:text-success',
  MEDIUM: 'bg-warning/15 text-warning', // V23 L1: light --warning is AA-darkened, raw amber-800 not needed
  LOW: 'bg-muted text-muted-foreground',
  INSUFFICIENT: 'bg-muted text-muted-foreground',
};

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const key = (confidence || 'LOW').toUpperCase();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        CONFIDENCE_STYLES[key] ?? CONFIDENCE_STYLES.LOW
      }`}
    >
      {key.charAt(0) + key.slice(1).toLowerCase()}
    </span>
  );
}

// Case lifecycle → token color.
const STATUS_DOT: Record<string, string> = {
  New: 'bg-destructive',
  Investigating: 'bg-warning',
  Recovering: 'bg-chart-2', // V22 N4: blue, hue-distinct from New (destructive red)
  Recovered: 'bg-success',
  WrittenOff: 'bg-muted-foreground',
};

// AI-triage priority badge (P1–P4). Exported so OverviewPage reuses one source (V23 L1).
export const PRIORITY_STYLES: Record<string, string> = {
  P1: 'bg-destructive text-destructive-foreground',
  // V22 N4: on-token (was raw orange-500 / yellow-500).
  P2: 'bg-warning text-warning-foreground',
  P3: 'bg-warning/15 text-warning ring-1 ring-inset ring-warning/40',
  P4: 'bg-muted text-muted-foreground',
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold ${
        PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.P4
      }`}
    >
      {priority}
    </span>
  );
}

// Urgency tier badge (Smart Queue — IMMEDIATE / PRIORITY / STANDARD).
const URGENCY_STYLES: Record<string, string> = {
  IMMEDIATE: 'bg-destructive text-destructive-foreground',
  // R193: on-token, matches PriorityBadge P2 (V22 N4) — was raw orange-500.
  PRIORITY: 'bg-warning text-warning-foreground',
  STANDARD: 'bg-muted text-muted-foreground',
};

const URGENCY_DOT: Record<string, string> = {
  IMMEDIATE: 'animate-pulse bg-destructive-foreground',
  PRIORITY: 'bg-warning-foreground',
  STANDARD: 'bg-muted-foreground',
};

export function UrgencyBadge({ tier }: { tier: string }) {
  const key = (tier || 'STANDARD').toUpperCase();
  const label = key === 'IMMEDIATE' ? 'Immediate' : key === 'PRIORITY' ? 'Priority' : 'Standard';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        URGENCY_STYLES[key] ?? URGENCY_STYLES.STANDARD
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${URGENCY_DOT[key] ?? URGENCY_DOT.STANDARD}`} />
      {label}
    </span>
  );
}

export function StatusChip({ status }: { status: string | null | undefined }) {
  const s = status ?? 'New';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s] ?? 'bg-muted-foreground'}`} />
      {s}
    </span>
  );
}
