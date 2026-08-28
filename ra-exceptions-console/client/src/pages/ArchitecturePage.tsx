import { useEffect, useState } from 'react';
import { Button, Card, CardContent } from '@databricks/appkit-ui/react';
import {
  AppWindow,
  BarChart3,
  Sparkles,
  Bot,
  Network,
  ShieldCheck,
  Workflow,
  Brain,
  Warehouse,
  DatabaseZap,
  Layers,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  MapPin,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceLinkButton } from '../components/WorkspaceLinkButton';
import {
  architectureApi,
  type ArchitectureConfig,
  exploreDataUrl,
  pipelineUrl,
  jobUrl,
  genieUrl,
  mlflowExperimentUrl,
  lakebaseUrl,
} from '../lib/architecture';

/**
 * Architecture tab.
 *
 * Recreates the Databricks Data + AI Platform layered diagram, but every tile is a
 * real component of THIS demo (per demo-artifacts/05-repository-blueprint.md). On top
 * of the layered map sits a guided clickthrough that walks the request path:
 *   App → Genie One → Genie Agent → SDP → MLOps → Unity Catalog → Data.
 * Each tour step carries "Open in workspace" deep links built from real bundle config
 * (see lib/architecture.ts + server/routes/architecture.ts).
 */

type NodeId = 'app' | 'aibi' | 'genie-one' | 'genie-agent' | 'uc' | 'sdp' | 'mlops' | 'lakehouse' | 'lakebase';

interface NodeDef {
  id: NodeId;
  title: string;
  sub: string;
  icon: LucideIcon;
}

interface BandDef {
  key: string;
  label: string;
  tagline: string;
  tint: string; // subtle band background (theme-aware via /N alpha on tokens)
  nodes: NodeDef[];
}

const BANDS: BandDef[] = [
  {
    key: 'apps',
    label: 'Agentic Apps',
    tagline: 'Deploy agents at scale to transform work',
    tint: 'bg-muted/40',
    nodes: [
      { id: 'app', title: 'RA Exceptions Console', sub: 'Custom App · AppKit', icon: AppWindow },
      { id: 'aibi', title: 'RA Command Center', sub: 'AI/BI dashboard', icon: BarChart3 },
    ],
  },
  {
    key: 'work',
    label: 'Agentic Work',
    tagline: 'Data-smart coworkers for every employee',
    tint: 'bg-muted/60',
    nodes: [
      { id: 'genie-one', title: 'Genie One', sub: 'Org-wide AI coworker', icon: Sparkles },
      { id: 'genie-agent', title: 'RA Genie Agent', sub: 'Curated Genie Space', icon: Bot },
    ],
  },
  {
    key: 'gov',
    label: 'Unified Governance',
    tagline: 'Data + AI control and cost management',
    tint: 'bg-muted/40',
    nodes: [{ id: 'uc', title: 'Unity Catalog', sub: 'Metric Views · Domains · Glossary · Access', icon: ShieldCheck }],
  },
  {
    key: 'data',
    label: 'Agentic Data',
    tagline: 'Unified, real-time data foundation',
    tint: 'bg-muted/60',
    nodes: [
      { id: 'sdp', title: 'Reconciliation Pipelines', sub: 'Lakeflow SDP · 7 silver + 4 gold', icon: Workflow },
      { id: 'mlops', title: 'Anomaly & Forecast', sub: 'MLflow model · ai_forecast', icon: Brain },
      { id: 'lakehouse', title: 'Lakehouse', sub: 'cdm_tmforum · TM Forum SID', icon: Warehouse },
      { id: 'lakebase', title: 'Lakebase', sub: 'Serverless Postgres · case store', icon: DatabaseZap },
    ],
  },
];

const INFRA_CHIPS = [
  'Delta Lake',
  'TM Forum SID model',
  'salesforce_source',
  'oracle_erp_source',
  'refinitiv_fx_source',
  'ironclad_clm_source',
  'mdm_source',
];

interface StepLink {
  label: string;
  build: (cfg: ArchitectureConfig) => string | null;
}

interface TourStep {
  node: NodeId;
  kicker: string;
  title: string;
  body: string;
  artifact: string;
  links: StepLink[];
}

// The requested clickthrough: App → Genie One → Genie Agent → SDP → MLOps → UC → Data.
// Each step links into the real workspace resource it maps to.
const TOUR: TourStep[] = [
  {
    node: 'app',
    kicker: 'Step 1 · You are here',
    title: 'RA Exceptions Console',
    body: 'The AppKit app an analyst uses to triage leakage and work cases. It reads analytics through the SQL warehouse and writes case state back to Lakebase Postgres.',
    artifact: 'ra-exceptions-console · reads gold_* / silver_*, writes ra.cases · ra.case_notes',
    links: [
      { label: 'Explore RA schema', build: (cfg) => exploreDataUrl(cfg) },
      { label: 'Case store (Lakebase)', build: (cfg) => lakebaseUrl(cfg) },
    ],
  },
  {
    node: 'genie-one',
    kicker: 'Step 2 · Agentic Work',
    title: 'Genie One',
    body: 'The org-wide AI coworker. A business user asks “where are we leaking revenue this quarter?” in plain language; Genie One routes it through the Genie Ontology to the right governed data.',
    artifact: 'Genie One · natural-language entry point across all domains',
    links: [{ label: 'Open Genie', build: (cfg) => genieUrl(cfg) }],
  },
  {
    node: 'genie-agent',
    kicker: 'Step 3 · Agentic Work',
    title: 'RA Genie Agent',
    body: 'A curated Genie Space scoped to revenue assurance. It is grounded on the RA metric views and business glossary, so answers use the same KPI definitions the pipelines compute.',
    artifact: 'Genie Space · grounded on revenue_assurance metric views + glossary',
    links: [{ label: 'Open RA Genie space', build: (cfg) => genieUrl(cfg) }],
  },
  {
    node: 'sdp',
    kicker: 'Step 4 · Agentic Data',
    title: 'Reconciliation Pipelines (SDP)',
    body: 'Lakeflow Spark Declarative Pipelines run the seven silver reconciliation checks (one per check_type) and roll them into four gold views the app and Genie read.',
    artifact: 'silver_reconciliation · gold_leakage_summary · gold_reconciliation_scorecard',
    links: [
      { label: 'Open pipeline', build: (cfg) => pipelineUrl(cfg) },
      { label: 'Explore gold views', build: (cfg) => exploreDataUrl(cfg) },
    ],
  },
  {
    node: 'mlops',
    kicker: 'Step 5 · Agentic Data',
    title: 'Anomaly Detection & Forecast',
    body: 'An MLflow anomaly model scores exceptions and ai_forecast projects expected revenue, surfacing leakage that fixed rules miss. Models are registered and governed in Unity Catalog.',
    artifact: 'gold_anomaly_scores · gold_revenue_forecast_anomalies',
    links: [
      { label: 'ML job', build: (cfg) => jobUrl(cfg, cfg.mlJobId) },
      { label: 'MLflow experiments', build: (cfg) => mlflowExperimentUrl(cfg) },
    ],
  },
  {
    node: 'uc',
    kicker: 'Step 6 · Unified Governance',
    title: 'Unity Catalog',
    body: 'Every table, view, model, and metric is governed here. Metric Views define KPIs with synonyms, the domain tag maps resources to Sales/Ops/Finance, and the glossary reconciles the terms each team uses differently.',
    artifact: 'Metric Views · domain tag matrix · business glossary · access + lineage',
    links: [{ label: 'Open Catalog Explorer', build: (cfg) => exploreDataUrl(cfg) }],
  },
  {
    node: 'lakehouse',
    kicker: 'Step 7 · The data',
    title: 'cdm_tmforum + source systems',
    body: 'The pre-populated TM Forum SID catalog (resource, service, product, customer, business partner) plus the simulated upstream sources. This golden data is what every layer above reconciles against.',
    artifact: 'cdm_tmforum.tmf_* (read-only) · *_source schemas · revenue_assurance',
    links: [
      { label: 'Explore cdm_tmforum', build: (cfg) => exploreDataUrl(cfg, cfg.catalog) },
      { label: 'Data-sim job', build: (cfg) => jobUrl(cfg, cfg.datasimJobId) },
    ],
  },
];

// node → tour index (for the step-number badge shown on the diagram)
const NODE_STEP: Partial<Record<NodeId, number>> = {};
TOUR.forEach((s, i) => {
  if (!(s.node in NODE_STEP)) NODE_STEP[s.node] = i;
});

function NodeTile({
  node,
  active,
  dimmed,
  onClick,
}: {
  node: NodeDef;
  active: boolean;
  dimmed: boolean;
  onClick: () => void;
}) {
  const Icon = node.icon;
  const step = NODE_STEP[node.id];
  const interactive = step !== undefined; // only tour nodes are clickable
  const className = `group relative flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-all ${
    active ? 'border-brand shadow-[0_0_0_1px_var(--brand)]' : 'border-border'
  } ${interactive && !active ? 'hover:border-foreground/20 hover:shadow-sm' : ''} ${
    dimmed ? 'opacity-40' : 'opacity-100'
  }`;

  const inner = (
    <>
      {step !== undefined && (
        <span
          className={`absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
            active ? 'bg-brand text-brand-foreground' : 'bg-muted-foreground text-background'
          }`}
        >
          {step + 1}
        </span>
      )}
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand/10">
        <Icon className="h-5 w-5 text-brand" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-foreground">{node.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{node.sub}</span>
      </span>
    </>
  );

  // Non-tour tiles (e.g. AI/BI, Lakebase) are context only — render them static
  // so they don't present a clickable affordance that does nothing.
  if (!interactive) {
    return <div className={className}>{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
    >
      {inner}
    </button>
  );
}

export function ArchitecturePage() {
  // -1 = tour not started (show full map, no dimming)
  const [step, setStep] = useState(-1);
  const [cfg, setCfg] = useState<ArchitectureConfig | null>(null);

  // Workspace config powers the "Open in workspace" deep links. Optional — if it
  // fails to load, WorkspaceLinkButton renders disabled with a tooltip.
  useEffect(() => {
    let alive = true;
    architectureApi
      .config()
      .then((c) => {
        if (alive) setCfg(c);
      })
      .catch(() => {
        /* leave cfg null → links disabled */
      });
    return () => {
      alive = false;
    };
  }, []);

  const touring = step >= 0;
  const current = touring ? TOUR[step] : null;
  const activeNode = current?.node ?? null;

  const start = () => setStep(0);
  const prev = () => setStep((s) => Math.max(0, s - 1));
  const next = () => setStep((s) => Math.min(TOUR.length - 1, s + 1));
  const reset = () => setStep(-1);

  const jumpToNode = (id: NodeId) => {
    const idx = TOUR.findIndex((t) => t.node === id);
    if (idx >= 0) setStep(idx);
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      {/* Tour controls (page title/subtitle come from the layout header in App.tsx) */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          {touring ? (
            <>
              <Button variant="outline" size="sm" onClick={prev} disabled={step === 0}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Prev
              </Button>
              <span className="min-w-[3.5rem] text-center text-xs font-medium tabular-nums text-muted-foreground">
                {step + 1} / {TOUR.length}
              </span>
              <Button size="sm" onClick={next} disabled={step === TOUR.length - 1}>
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" onClick={reset} aria-label="Reset tour">
                <RotateCcw className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={start} className="bg-brand text-brand-foreground hover:bg-brand/90">
              <MapPin className="mr-1 h-4 w-4" /> Start guided tour
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Layered platform diagram */}
        <Card className="shadow-sm lg:col-span-2">
          <CardContent className="flex flex-col gap-3 p-4">
            {BANDS.map((band) => (
              <div key={band.key} className={`rounded-xl ${band.tint} p-3`}>
                <div className="mb-2 px-1">
                  <div className="text-sm font-semibold text-foreground">{band.label}</div>
                  <div className="text-xs text-muted-foreground">{band.tagline}</div>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {band.nodes.map((n) => (
                    <NodeTile
                      key={n.id}
                      node={n}
                      active={activeNode === n.id}
                      dimmed={touring && activeNode !== n.id}
                      onClick={() => jumpToNode(n.id)}
                    />
                  ))}
                </div>
                {band.key === 'work' && (
                  <div className="mt-2 flex items-center justify-center gap-2 rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground">
                    <Network className="h-3.5 w-3.5 text-brand" /> Genie Ontology — shared semantic layer
                  </div>
                )}
              </div>
            ))}

            {/* Open infrastructure strip */}
            <div className="rounded-xl border border-border p-3">
              <div className="mb-2 flex items-center gap-2 px-1">
                <Layers className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">Open Infrastructure</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {INFRA_CHIPS.map((c) => (
                  <span
                    key={c}
                    className="rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Detail / narration panel */}
        <Card className="shadow-sm">
          <CardContent className="flex h-full flex-col gap-4 p-5">
            {current ? (
              <>
                <div className="inline-flex w-fit items-center rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand-foreground">
                  {current.kicker}
                </div>
                <h3 className="text-xl font-semibold text-foreground">{current.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{current.body}</p>
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    In this demo
                  </div>
                  <code className="block break-words text-xs text-foreground">{current.artifact}</code>
                </div>

                {current.links.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {current.links.map((l) => (
                      <WorkspaceLinkButton key={l.label} label={l.label} href={cfg ? l.build(cfg) : null} />
                    ))}
                  </div>
                )}

                {/* Flow breadcrumb */}
                <div className="mt-auto flex flex-wrap items-center gap-1 pt-2">
                  {TOUR.map((t, i) => (
                    <button
                      key={t.node}
                      type="button"
                      onClick={() => setStep(i)}
                      className="flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      aria-label={`Go to step ${i + 1}: ${t.title}`}
                      aria-current={i === step ? 'step' : undefined}
                    >
                      <span
                        className={`h-2 w-2 rounded-full transition-all ${i === step ? 'w-5 bg-brand' : 'bg-border'}`}
                      />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/10">
                  <MapPin className="h-6 w-6 text-brand" />
                </span>
                <div className="text-sm font-medium text-foreground">Follow the request path</div>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Start the guided tour to trace a business question from this app down through Genie, the pipelines,
                  and Unity Catalog to the underlying data — each step links into the live workspace. Or click any
                  numbered tile.
                </p>
                <Button size="sm" variant="outline" onClick={start}>
                  Start guided tour
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
