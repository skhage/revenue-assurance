import { GenieChat } from '@databricks/appkit-ui/react';
import { Sparkles } from 'lucide-react';

/**
 * In-app Genie chat (Gap 4) — natural-language questions over the governed
 * revenue-assurance data, backed by the "Lakelink Revenue Assurance Analyst"
 * Genie space. The @databricks/appkit genie() plugin proxies to the Genie API
 * over SSE; the space id comes from DATABRICKS_GENIE_SPACE_ID (bundle-bound).
 */
export function GeniePage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10">
          <Sparkles className="h-5 w-5 text-brand" />
        </span>
        <div>
          <div className="text-sm font-semibold text-foreground">Ask the RA data a question</div>
          <p className="text-sm text-muted-foreground">
            Natural-language questions over the governed reconciliation data — e.g. “Which customers have the highest AR
            collection risk this quarter?” Answers run against Unity Catalog and inherit its access controls; each reply
            shows the generated SQL.
          </p>
        </div>
      </div>

      <div className="h-[calc(100vh-16rem)] min-h-96 overflow-hidden rounded-lg border border-border bg-card">
        {/* Single-space setup: the genie() plugin registers DATABRICKS_GENIE_SPACE_ID
            under the "default" alias. */}
        <GenieChat alias="default" />
      </div>
    </div>
  );
}
