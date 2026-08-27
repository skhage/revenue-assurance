// Thin client + link-building for the Architecture page (server/routes/architecture.ts).
//
// Every "Open in workspace" link is built from real bundle config (or the
// live DATABRICKS_HOST) — never a guessed workspace path. When a specific
// resource id isn't configured, we fall back to the matching workspace list
// page rather than omitting the link, so the button is always useful.

export interface ArchitectureConfig {
  workspaceHost: string | null;
  workspaceId: string | null;
  catalog: string;
  schema: string;
  pipelineId: string | null;
  mlJobId: string | null;
  datasimJobId: string | null;
  dashboardId: string | null;
  genieSpaceId: string | null;
  lakebaseProject: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const architectureApi = {
  config: () => fetch('/api/architecture').then((r) => json<ArchitectureConfig>(r)),
};

function withHost(cfg: ArchitectureConfig, path: string): string | null {
  if (!cfg.workspaceHost) return null;
  const base = cfg.workspaceHost.replace(/\/+$/, '');
  const suffix = cfg.workspaceId ? `${path}${path.includes('?') ? '&' : '?'}o=${cfg.workspaceId}` : path;
  return `${base}${suffix}`;
}

/** Catalog Explorer deep link for a table/schema/catalog. Always available — no id needed. */
export function exploreDataUrl(cfg: ArchitectureConfig, path?: string): string | null {
  const suffix = path ? `/explore/data/${path}` : `/explore/data/${cfg.catalog}/${cfg.schema}`;
  return withHost(cfg, suffix);
}

/** Pipeline detail page if pipelineId is configured, else the Pipelines list. */
export function pipelineUrl(cfg: ArchitectureConfig): string | null {
  return withHost(cfg, cfg.pipelineId ? `/pipelines/${cfg.pipelineId}` : '/pipelines');
}

/** Job detail page if jobId is configured, else the Jobs list. */
export function jobUrl(cfg: ArchitectureConfig, jobId: string | null): string | null {
  return withHost(cfg, jobId ? `/jobs/${jobId}` : '/jobs');
}

/** Dashboard page if dashboardId is configured, else the Dashboards list. */
export function dashboardUrl(cfg: ArchitectureConfig): string | null {
  return withHost(cfg, cfg.dashboardId ? `/sql/dashboardsv3/${cfg.dashboardId}` : '/sql/dashboardsv3');
}

/** Genie space chat if genieSpaceId is configured, else the Genie landing page. */
export function genieUrl(cfg: ArchitectureConfig): string | null {
  return withHost(cfg, cfg.genieSpaceId ? `/genie/rooms/${cfg.genieSpaceId}` : '/genie');
}

/** MLflow experiment search — anomaly-detection runs are logged under this named experiment. */
export function mlflowExperimentUrl(cfg: ArchitectureConfig): string | null {
  return withHost(cfg, '/ml/experiments');
}

/** Lakebase has no stable deep-link path (Databricks docs: open via the app switcher); always the workspace root. */
export function lakebaseUrl(cfg: ArchitectureConfig): string | null {
  return withHost(cfg, '/');
}
