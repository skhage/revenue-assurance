// Serves the workspace configuration the Architecture page needs to build
// deep links to the pipeline, jobs, dashboard, Genie space, and Lakebase
// project this app is built on. All values are optional bundle-time config
// (see databricks.yml `ra_*` variables) — when unset, the client falls back
// to the relevant workspace list page instead of a specific resource.

import type { Application } from 'express';

interface AppKitWithServer {
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function setupArchitectureRoutes(appkit: AppKitWithServer) {
  appkit.server.extend((app) => {
    app.get('/api/architecture', (_req, res) => {
      res.json({
        workspaceHost: optionalEnv('DATABRICKS_HOST'),
        workspaceId: optionalEnv('DATABRICKS_WORKSPACE_ID'),
        catalog: 'cdm_tmforum',
        schema: 'revenue_assurance',
        pipelineId: optionalEnv('RA_PIPELINE_ID'),
        mlJobId: optionalEnv('RA_ML_JOB_ID'),
        datasimJobId: optionalEnv('RA_DATASIM_JOB_ID'),
        dashboardId: optionalEnv('RA_DASHBOARD_ID'),
        genieSpaceId: optionalEnv('RA_GENIE_SPACE_ID'),
        lakebaseProject: optionalEnv('RA_LAKEBASE_PROJECT'),
      });
    });
  });
}
