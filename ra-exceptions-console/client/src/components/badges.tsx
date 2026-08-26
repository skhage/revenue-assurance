// Semantic status/severity chips. Colors come only from design tokens
// (destructive / warning / success / primary / muted) — never raw hex.

const SEV_STYLES: Record<string, string> = {
  HIGH: 'bg-destructive/10 text-destructive',
  MEDIUM: 'bg-warning/15 text-warning',
  LOW: 'bg-muted text-muted-foreground',
};

const SEV_DOT: Record<string, string> = {
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
      <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[key] ?? SEV_DOT.LOW}`} />
      {label}
    </span>
  );
}

// Case lifecycle → token color.
const STATUS_DOT: Record<string, string> = {
  New: 'bg-destructive',
  Investigating: 'bg-warning',
  Recovering: 'bg-primary',
  Recovered: 'bg-success',
  WrittenOff: 'bg-muted-foreground',
};

export function StatusChip({ status }: { status: string | null | undefined }) {
  const s = status ?? 'New';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s] ?? 'bg-muted-foreground'}`} />
      {s}
    </span>
  );
}
