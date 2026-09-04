import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, CardContent } from '@databricks/appkit-ui/react';
import {
  Banknote,
  Unplug,
  Boxes,
  Users,
  ShieldCheck,
  PlayCircle,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  FileWarning,
  BadgePercent,
  CalendarClock,
  Hourglass,
  FileSearch,
  Fingerprint,
  Network,
  Workflow,
  Brain,
  DatabaseZap,
  PackageCheck,
  Languages,
  ClipboardList,
  Layers3,
  ListChecks,
  FileCheck2,
  HandCoins,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

/**
 * "Why RA matters" tab — the story a presenter tells BEFORE the live demo.
 *
 * A single-tab, chaptered clickthrough (rail on the left, narrative stage on the
 * right; ← / → keys or the progress dots also navigate). It walks:
 *   The stakes → Why it happens → The technical challenge → The people challenge
 *   → Why Databricks → Into the demo.
 * Content is sourced from demo-artifacts/00-problem-overview.md and the customer
 * roleplay deck. Industry figures are labelled as estimates; the ~$601.5M / ~48,108
 * figure is the seeded demo output, never presented as a customer measurement.
 */

type Tone = 'brand' | 'destructive' | 'warning' | 'success' | 'muted';

const TONE: Record<Tone, { chip: string; bar: string; num: string }> = {
  brand: { chip: 'bg-brand/10 text-brand', bar: 'border-brand', num: 'text-brand' },
  destructive: { chip: 'bg-destructive/10 text-destructive', bar: 'border-destructive', num: 'text-destructive' },
  warning: { chip: 'bg-warning/10 text-warning', bar: 'border-warning', num: 'text-warning' },
  success: { chip: 'bg-success/10 text-success', bar: 'border-success', num: 'text-success' },
  muted: { chip: 'bg-muted text-muted-foreground', bar: 'border-border', num: 'text-foreground' },
};

interface Stat {
  value: string;
  label: string;
  tone?: Tone;
}

interface StoryCard {
  icon: LucideIcon;
  title: string;
  body: string;
  tone?: Tone;
}

interface Chapter {
  id: string;
  nav: string;
  icon: LucideIcon;
  kicker: string;
  title: string;
  lead: string;
  stats?: Stat[];
  cardsTitle?: string;
  cards?: StoryCard[];
  callout?: { label: string; text: string };
  cta?: boolean;
}

const CHAPTERS: Chapter[] = [
  {
    id: 'stakes',
    nav: 'The stakes',
    icon: Banknote,
    kicker: 'The business case',
    title: 'Revenue you already earned is quietly leaking away.',
    lead: 'Revenue leakage is service a carrier has delivered but never fully bills, collects, or recognises. It rarely shows up as one broken system — it is value escaping in the gaps between many systems that are each, locally, working correctly. Left alone it compounds: quarter after quarter, a few points of revenue never arrive.',
    stats: [
      { value: '1–5%', label: 'of telecom revenue lost to leakage (PwC industry estimate)', tone: 'destructive' },
      { value: '~$601.5M', label: 'amount at risk surfaced in this demo dataset (seeded, illustrative)', tone: 'warning' },
      { value: '50–70%', label: 'of identified leakage typically recoverable (industry estimate)', tone: 'success' },
    ],
    callout: {
      label: 'Why it reaches the boardroom',
      text: 'A few percentage points of a multi-billion-dollar revenue base is a board-level number — and unlike growth, it needs no new customers to recover. It is margin already earned, waiting to be reclaimed.',
    },
  },
  {
    id: 'root-cause',
    nav: 'Why it happens',
    icon: Unplug,
    kicker: 'Root cause',
    title: "Every team defines “revenue” differently — and the handoffs fall through the gaps.",
    lead: 'Sales sees bookings. Operations sees provisioned service. Billing sees invoices. Finance sees recognised revenue. Each view can be perfectly correct while the handoff between them is wrong — and that is exactly where the money escapes.',
    cardsTitle: 'Where the handoff breaks',
    cards: [
      { icon: BadgePercent, title: 'Price drift', body: 'The contracted price and the billed price quietly diverge.', tone: 'destructive' },
      { icon: FileWarning, title: 'Unauthorised discounts', body: 'Discounts applied outside the approval path erode margin.', tone: 'destructive' },
      { icon: CalendarClock, title: 'Rev-rec timing', body: 'Revenue is recognised on a schedule that drifts from policy.', tone: 'warning' },
      { icon: Hourglass, title: 'Collections found late', body: 'Collection risk surfaces only after a claim has aged.', tone: 'warning' },
      { icon: FileSearch, title: 'Docs vs. records', body: 'Contract PDFs and structured records disagree with each other.', tone: 'warning' },
      { icon: Fingerprint, title: 'Broken identity', body: 'The same customer maps differently across CRM, billing, service, and finance.', tone: 'destructive' },
    ],
  },
  {
    id: 'technical',
    nav: 'Technical challenge',
    icon: Boxes,
    kicker: 'The technical challenge',
    title: 'The leakage lives in the gaps between systems — so no single system can see it.',
    lead: 'Revenue assurance is fundamentally an integration problem. The evidence is scattered across CRM, ERP, FX, contract, network, and MDM systems that were never designed to reconcile against one another. Traditional audits chase it quarterly, by hand, after the fact.',
    cardsTitle: 'What makes it hard to solve',
    cards: [
      { icon: Network, title: 'Fragmented sources', body: 'Salesforce, Oracle ERP, Refinitiv FX, Ironclad CLM, MDM and the network inventory each hold one piece of the truth.', tone: 'destructive' },
      { icon: Fingerprint, title: 'Identity resolution', body: 'Matching one customer and service across all of those systems is a hard, error-prone join.', tone: 'destructive' },
      { icon: FileSearch, title: 'No governed foundation', body: 'Without shared definitions and lineage, no figure can be traced back to its source or trusted by audit.', tone: 'warning' },
      { icon: ClipboardList, title: 'Spreadsheet audits', body: 'One-off quarterly reconciliations are neither repeatable nor auditable — and always run too late.', tone: 'warning' },
      { icon: Brain, title: 'Leakage mutates', body: 'Rules catch the leakage you already know about; rate engines, promotions, and partners invent new leaks constantly.', tone: 'warning' },
    ],
  },
  {
    id: 'people',
    nav: 'People challenge',
    icon: Users,
    kicker: 'The human challenge',
    title: 'Four teams, four dialects, one quarterly spreadsheet hunt.',
    lead: 'Even with the data, revenue assurance stalls on people and process. The teams who could fix leakage disagree on what the numbers even mean, and the work that would catch it is manual, unowned, and perpetually behind.',
    cardsTitle: 'Where the organisation gets stuck',
    cards: [
      { icon: Languages, title: 'Different languages', body: 'Finance, Sales, Network Ops, and Collections each count subscribers and revenue their own way.', tone: 'destructive' },
      { icon: CalendarClock, title: 'Quarterly, by hand', body: 'Reconciliation happens in spreadsheets once a quarter — slow, fragile, and impossible to repeat.', tone: 'warning' },
      { icon: ListChecks, title: 'Analysts drowning', body: 'Tens of thousands of unranked exceptions with no way to know which dollar to chase first.', tone: 'warning' },
      { icon: Hourglass, title: 'Disputes age out', body: 'By the time a mismatch is found, the claim may be disputed, aged, or simply unrecoverable.', tone: 'destructive' },
      { icon: ShieldAlert, title: 'No shared truth', body: 'No single source of record means no clear owner, no audit trail, and no accountability for recovery.', tone: 'destructive' },
    ],
  },
  {
    id: 'databricks',
    nav: 'Why Databricks',
    icon: ShieldCheck,
    kicker: 'The answer',
    title: 'Bring the controls to the governed data — instead of building another silo.',
    lead: 'The leakage already spans the customer’s governed data estate. So rather than stand up yet another isolated system to reconcile, we bring reconciliation, AI, analytics, lineage, and the operational workflow to the shared data on one platform.',
    cardsTitle: 'Why the Databricks Data + AI Platform fits',
    cards: [
      { icon: Layers3, title: 'One lakehouse foundation', body: 'The TM Forum SID model unifies resource, service, product, and customer — the shared ground truth every check reconciles against.', tone: 'brand' },
      { icon: ShieldCheck, title: 'Unity Catalog governance', body: 'One boundary for access, lineage, metric definitions, and a business glossary that settles the cross-team term disputes.', tone: 'brand' },
      { icon: Workflow, title: 'Transparent SQL controls', body: 'Reconciliation runs as versioned, declarative SQL — legible to finance and audit, repeatable on every pipeline run.', tone: 'success' },
      { icon: Brain, title: 'AI where it earns its place', body: 'Anomaly scoring and ai_forecast catch mutating leakage; document intelligence reconciles contract PDFs — without weakening provenance.', tone: 'success' },
      { icon: DatabaseZap, title: 'Closes the recovery loop', body: 'An operational app on Lakebase turns detection into owned, tracked cases — from “leak found” to “revenue recovered.”', tone: 'success' },
      { icon: PackageCheck, title: 'Deploys incrementally', body: 'One Asset Bundle, reusing the existing estate — start with two controls and prove the economics before scaling.', tone: 'brand' },
    ],
    callout: {
      label: 'The shift',
      text: 'Leakage stops being a quarterly opinion argued in spreadsheets and becomes a governed, prioritised, provable operational control that runs every day.',
    },
  },
  {
    id: 'demo',
    nav: 'Into the demo',
    icon: PlayCircle,
    kicker: 'What you’ll see next',
    title: 'Quantify → Prioritize → Prove → Recover → Prevent.',
    lead: 'That is the arc of the live demo. Each stage is a real surface in this console and its supporting platform — starting with the executive view of total exposure on the Overview.',
    cardsTitle: 'The value arc',
    cards: [
      { icon: Banknote, title: '1 · Quantify', body: 'A governed leakage register replaces competing spreadsheets.', tone: 'brand' },
      { icon: ListChecks, title: '2 · Prioritize', body: 'Risk, amount, cause, and customer concentrate recovery effort.', tone: 'brand' },
      { icon: FileCheck2, title: '3 · Prove', body: 'Source evidence, detection method, and lineage accelerate trust.', tone: 'brand' },
      { icon: HandCoins, title: '4 · Recover', body: 'Ownership, notes, and lifecycle convert exposure into action.', tone: 'success' },
      { icon: ShieldCheck, title: '5 · Prevent', body: 'Repeatable controls catch recurrence before quarter close.', tone: 'success' },
    ],
    cta: true,
  },
];

function StatTile({ stat }: { stat: Stat }) {
  const tone = TONE[stat.tone ?? 'muted'];
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-5 lg:p-6">
      <span className={`text-4xl font-semibold tabular-nums lg:text-5xl ${tone.num}`}>{stat.value}</span>
      <span className="text-sm leading-snug text-muted-foreground lg:text-base">{stat.label}</span>
    </div>
  );
}

function StoryTile({ card }: { card: StoryCard }) {
  const Icon = card.icon;
  const tone = TONE[card.tone ?? 'brand'];
  return (
    <div className={`flex flex-col gap-2.5 rounded-lg border border-l-2 border-border bg-card p-4 lg:p-5 ${tone.bar}`}>
      <span className={`flex h-10 w-10 items-center justify-center rounded-md ${tone.chip}`}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="text-base font-semibold text-foreground lg:text-lg">{card.title}</span>
      <span className="text-sm leading-relaxed text-muted-foreground lg:text-base">{card.body}</span>
    </div>
  );
}

function RailItem({
  chapter,
  index,
  active,
  onClick,
}: {
  chapter: Chapter;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = chapter.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'step' : undefined}
      className={`relative flex items-center gap-3 rounded-md py-2.5 pl-4 pr-3 text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
      }`}
    >
      <span
        className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-opacity ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
          active ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground'
        }`}
      >
        {index + 1}
      </span>
      <Icon className="h-5 w-5 shrink-0" />
      <span className="min-w-0 truncate">{chapter.nav}</span>
    </button>
  );
}

export function WhyItMattersPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const total = CHAPTERS.length;
  const current = CHAPTERS[step];

  const prev = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  const next = useCallback(() => setStep((s) => Math.min(total - 1, s + 1)), [total]);

  // ← / → navigate chapters (ignore while focus is in a form control).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);

  const cardCols = (current.cards?.length ?? 0) >= 5 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2';

  return (
    <div className="flex h-full w-full flex-col gap-4">
      {/* Controls (page title/subtitle come from the layout header in App.tsx) */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={prev} disabled={step === 0}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Prev
        </Button>
        <span className="min-w-[3.5rem] text-center text-sm font-medium tabular-nums text-muted-foreground">
          {step + 1} / {total}
        </span>
        <Button onClick={next} disabled={step === total - 1}>
          Next <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setStep(0)} aria-label="Restart from the beginning">
          <RotateCcw className="h-5 w-5" />
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        {/* Chapter rail */}
        <Card className="h-fit shadow-sm">
          <CardContent className="flex flex-col gap-1 p-2.5">
            {CHAPTERS.map((c, i) => (
              <RailItem key={c.id} chapter={c} index={i} active={i === step} onClick={() => setStep(i)} />
            ))}
          </CardContent>
        </Card>

        {/* Narrative stage */}
        <Card className="flex flex-col shadow-sm">
          <CardContent className="flex flex-1 flex-col gap-6 p-8 lg:p-10">
            <div className="flex items-center gap-3.5">
              <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand/10">
                <current.icon className="h-6 w-6 text-brand" />
              </span>
              <div className="inline-flex w-fit items-center rounded-full bg-brand px-3 py-1 text-sm font-semibold uppercase tracking-wide text-brand-foreground">
                {current.kicker}
              </div>
            </div>

            <h2 className="text-3xl font-semibold leading-tight text-foreground lg:text-4xl">{current.title}</h2>
            <p className="max-w-4xl text-lg leading-relaxed text-muted-foreground lg:text-xl">{current.lead}</p>

            {current.stats && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {current.stats.map((s) => (
                  <StatTile key={s.label} stat={s} />
                ))}
              </div>
            )}

            {current.cards && (
              <div className="flex flex-col gap-3.5">
                {current.cardsTitle && (
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground lg:text-sm">
                    {current.cardsTitle}
                  </div>
                )}
                <div className={`grid grid-cols-1 gap-4 ${cardCols}`}>
                  {current.cards.map((c) => (
                    <StoryTile key={c.title} card={c} />
                  ))}
                </div>
              </div>
            )}

            {current.callout && (
              <div className="rounded-lg border-l-2 border-brand bg-brand/5 py-4 pl-5 pr-5">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-brand lg:text-sm">
                  {current.callout.label}
                </div>
                <p className="text-base leading-relaxed text-foreground lg:text-lg">{current.callout.text}</p>
              </div>
            )}

            {current.cta && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 p-5">
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold text-foreground lg:text-lg">Ready to see it?</div>
                  <div className="text-sm text-muted-foreground lg:text-base">
                    The Overview opens on total exposure — the executive view of everything at risk.
                  </div>
                </div>
                <Button size="lg" onClick={() => navigate('/')} className="bg-brand text-brand-foreground hover:bg-brand/90">
                  <PlayCircle className="mr-1.5 h-5 w-5" /> Start the demo
                </Button>
              </div>
            )}

            {/* Progress dots */}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
              {CHAPTERS.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setStep(i)}
                  className="flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label={`Go to chapter ${i + 1}: ${c.nav}`}
                  aria-current={i === step ? 'step' : undefined}
                >
                  <span className={`h-2.5 rounded-full transition-all ${i === step ? 'w-6 bg-brand' : 'w-2.5 bg-border'}`} />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
