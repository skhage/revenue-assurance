// Databricks logo lockup — a lava logomark (stacked lakehouse layers) plus the
// "databricks" wordmark. Used for the "Built on Databricks" credit in the app
// shell. The mark fills with its own Lava color; the wordmark uses currentColor
// so it adapts to whatever surface it sits on (navy sidebar, light footer, etc.).

const LAVA = '#FF3621';

export function DatabricksMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      {/* three stacked isometric layers → lakehouse / stacked data */}
      <path d="M16 4l11 4.6-11 4.6L5 8.6 16 4Z" fill={LAVA} opacity="0.55" />
      <path d="M16 11.4l11 4.6-11 4.6L5 16l11-4.6Z" fill={LAVA} opacity="0.78" />
      <path d="M16 18.8l11 4.6L16 28 5 23.4l11-4.6Z" fill={LAVA} />
    </svg>
  );
}

/**
 * Full lockup: mark + "databricks" wordmark. `label` prefixes it (e.g. "Built on").
 * Decorative — adjacent text carries the meaning for screen readers.
 */
export function DatabricksLogo({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`} aria-hidden="true">
      {label && <span className="text-[11px] text-muted-foreground">{label}</span>}
      <DatabricksMark className="h-4 w-4 shrink-0" />
      <span className="text-sm font-semibold lowercase tracking-tight text-sidebar-foreground">databricks</span>
    </div>
  );
}
