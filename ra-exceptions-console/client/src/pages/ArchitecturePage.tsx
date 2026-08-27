import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Badge,
  Skeleton,
} from '@databricks/appkit-ui/react';
import { Database, Waypoints, Sparkles, LayoutDashboard, Boxes } from 'lucide-react';
import { WorkspaceLinkButton } from '../components/WorkspaceLinkButton';
import { architectureApi, type ArchitectureConfig } from '../lib/architecture';
import {
  exploreDataUrl,
  pipelineUrl,
  jobUrl,
  dashboardUrl,
  genieUrl,
  mlflowExperimentUrl,
  lakebaseUrl,
} from '../lib/architecture';

interface Stage {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  tagline: string;
  explanation: string;
  links: (cfg: ArchitectureConfig) => { label: string; href: string | null }[];
}

const STAGES: Stage[] = [
  {
    key: 'source-sim',
    icon: Database,
    title: '1. Source-system simulation',
    tagline: 'data-sim/simulate_source_systems.py → *_source schemas',
    explanation:
      'Before any reconciliation can happen, the demo needs upstream systems that disagree with each other on purpose. A serverless notebook job writes deterministic, seeded data into simulated Salesforce, Oracle ERP, Refinitiv FX, Ironclad CLM, and MDM schemas — the same systems a real telco would reconcile against. It reads the read-only cdm_tmforum.tmf_* golden data but never writes to it.',
    links: (cfg) => [
      { label: 'Open simulate_source_systems job', href: jobUrl(cfg, cfg.datasimJobId) },
      { label: 'Browse *_source schemas', href: exploreDataUrl(cfg, cfg.catalog) },
    ],
  },
  {
    key: 'reconciliation',
    icon: Waypoints,
    title: '2. Reconciliation pipeline',
    tagline: 'ra_medallion_pipeline → 7 silver checks + 4 gold materialized views',
    explanation:
      'A Lakeflow Declarative Pipeline runs seven independent silver checks — contract price, unauthorized discount, expired quote, AR collection risk, revenue-recognition timing, and two AI-powered document-intelligence checks that read contract/invoice PDFs with ai_parse_document + ai_extract. All seven union into gold_leakage_summary; the app adds canonical Lakebase workflow state through gold_exception_workflow, alongside gold_reconciliation_scorecard for customer health.',
    links: (cfg) => [
      { label: 'Open ra_medallion_pipeline', href: pipelineUrl(cfg) },
      { label: 'Browse revenue_assurance schema', href: exploreDataUrl(cfg) },
      {
        label: 'Inspect gold_leakage_summary',
        href: exploreDataUrl(cfg, `${cfg.catalog}/${cfg.schema}/gold_leakage_summary`),
      },
    ],
  },
  {
    key: 'ml',
    icon: Sparkles,
    title: '3. ML anomaly detection + forecasting',
    tagline: 'ra_anomaly_ml_pipeline job + ai_forecast → gold_anomaly_scores / gold_revenue_forecast_anomalies',
    explanation:
      'Not every leakage signal is a hard rule. A scheduled job builds features from the exception population, trains a Unity Catalog IsolationForest model with MLflow, and publishes ranked anomaly scores back to gold_anomaly_scores. Separately, ai_forecast projects expected monthly revenue and flags months where actuals fall outside the confidence band — catching variance before the month closes rather than in a post-mortem.',
    links: (cfg) => [
      { label: 'Open ra_anomaly_ml_pipeline job', href: jobUrl(cfg, cfg.mlJobId) },
      { label: 'Open MLflow experiments', href: mlflowExperimentUrl(cfg) },
      {
        label: 'Inspect gold_anomaly_scores',
        href: exploreDataUrl(cfg, `${cfg.catalog}/${cfg.schema}/gold_anomaly_scores`),
      },
    ],
  },
  {
    key: 'serving',
    icon: LayoutDashboard,
    title: '4. Serving: dashboard + Genie',
    tagline: 'AI/BI "Revenue Assurance Command Center" dashboard + RA Genie space',
    explanation:
      'The gold layer serves two audiences directly in the workspace, with the same Unity Catalog grants and PII masking as everywhere else. The AI/BI dashboard gives Dana (VP RA) an executive KPI view — total at-risk, root-cause breakdown, account scorecards, forecast variance. The Genie space lets Marcus (analyst) ask questions in plain English over the same governed tables and get back the generated SQL.',
    links: (cfg) => [
      { label: 'Open Revenue Assurance dashboard', href: dashboardUrl(cfg) },
      { label: 'Open RA Genie space', href: genieUrl(cfg) },
    ],
  },
  {
    key: 'lakebase',
    icon: Boxes,
    title: '5. Case management (Lakebase)',
    tagline: 'ra.cases / ra.case_notes — managed Postgres, written by this app',
    explanation:
      'Detection stays in Delta; the day-to-day work of triaging leakage does not. Every assignment, status change, and investigation note you make in the Exception queue and My cases screens writes to Lakebase Postgres — fully managed, autoscaling OLTP inside the workspace, in the ra schema (ra.cases / ra.case_notes). It is the only writable state in this app; everything else here is read-only analytics over Delta.',
    links: (cfg) => [{ label: 'Open Lakebase in workspace', href: lakebaseUrl(cfg) }],
  },
];

function StageCard({ stage, cfg }: { stage: Stage; cfg: ArchitectureConfig }) {
  const Icon = stage.icon;
  const links = stage.links(cfg);
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4.5 w-4.5" />
          </div>
          <div className="flex flex-col gap-1">
            <CardTitle className="text-sm">{stage.title}</CardTitle>
            <CardDescription className="font-mono text-[11px]">{stage.tagline}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-muted-foreground">{stage.explanation}</p>
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <WorkspaceLinkButton key={link.label} label={link.label} href={link.href} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ArchitecturePage() {
  const [cfg, setCfg] = useState<ArchitectureConfig | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    architectureApi
      .config()
      .then(setCfg)
      .catch(() => setError(true));
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle>How this demo is built</CardTitle>
          <CardDescription>
            Data flows one direction — source simulation feeds reconciliation, reconciliation feeds ML and serving, and
            this console is the only surface that writes anything back (case state, to Lakebase).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!cfg?.workspaceHost && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {error
                ? 'Workspace links unavailable'
                : cfg
                  ? 'No workspace host configured — links will open the workspace list pages once deployed'
                  : 'Loading workspace configuration…'}
            </Badge>
          )}
        </CardContent>
      </Card>

      {cfg == null && !error ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {STAGES.map((stage) => (
            <StageCard key={stage.key} stage={stage} cfg={cfg ?? EMPTY_CONFIG} />
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_CONFIG: ArchitectureConfig = {
  workspaceHost: null,
  workspaceId: null,
  catalog: 'cdm_tmforum',
  schema: 'revenue_assurance',
  pipelineId: null,
  mlJobId: null,
  datasimJobId: null,
  dashboardId: null,
  genieSpaceId: null,
  lakebaseProject: null,
};
