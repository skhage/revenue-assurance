// CommandCenterPanel — global floating chat button + slide-out panel.
// Calls the Revenue Recovery Command Center supervisor agent (via /api/command-center)
// with pre-populated context from the analyst's current view.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router';
import {
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Textarea,
} from '@databricks/appkit-ui/react';
import {
  MessageSquareText,
  Send,
  Bot,
  User,
  Loader2,
  X,
  Sparkles,
  RotateCcw,
  FileClock,
  UserSearch,
  PackageSearch,
  ListChecks,
  ReceiptText,
} from 'lucide-react';
import {
  commandCenterApi,
  type CommandCenterAgent,
  type CommandCenterContext,
} from '../lib/command-center';
import type { ChatMessage } from '../lib/types';

/** Map route paths to human-readable page titles for context injection. */
const PAGE_CONTEXT: Record<string, { title: string; description: string }> = {
  '/': { title: 'Overview', description: 'Revenue leakage across all reconciliation checks' },
  '/queue': { title: 'Exception queue', description: 'Triage detected leakage, highest impact first' },
  '/cases': { title: 'My cases', description: 'Cases under investigation and recovery' },
  '/agents': { title: 'Agent Workbench', description: 'Deterministic agents over RA data' },
  '/ask': { title: 'Ask (Genie)', description: 'Natural-language questions over RA data' },
  '/recovery': { title: 'Recovery', description: 'AI-ranked recovery opportunities' },
  '/alerts': { title: 'Risk alerts', description: 'Predictive alerting and emerging leakage signals' },
  '/compliance': { title: 'Compliance', description: 'Contract compliance scan' },
  '/partners': { title: 'Partner settlement', description: 'Inter-carrier settlement reconciliation' },
  '/order-to-bill': { title: 'Order-to-bill', description: 'Order/provisioning/billing misalignment' },
  '/collections': { title: 'Collections intelligence', description: 'Dunning-leakage correlation' },
  '/commission': { title: 'Commission leakage', description: 'Agent fraud and cap violations' },
  '/disputes': { title: 'Billing disputes', description: 'Fraud patterns and stale disputes' },
};

const SUGGESTED_PROMPTS = [
  'What are the biggest leakage risks right now?',
  'Triage the top 5 exceptions by dollar impact.',
  'Generate an executive briefing for today.',
  'Which contracts have compliance mismatches?',
];

/** Display metadata for each allowlisted supervisor. */
const AGENT_META: Record<CommandCenterAgent, { label: string }> = {
  'command-center': { label: 'Command Center' },
  'contract-risk': { label: 'Contract risk agent' },
  'adjustment-fraud': { label: 'Adjustment fraud agent' },
  'order-provisioning': { label: 'Order provisioning agent' },
  'triage-analytics': { label: 'Triage analytics agent' },
};

/**
 * Specialist quick actions (RA-APP-NEW-SUPERVISOR-TOOLS, RA-APP-GAP-TOOLS-QUICK-ACTIONS).
 * Each one starts a new conversation with the supervisor that owns the tool;
 * follow-ups stay with that agent. Below sm the first prompt per group stays
 * visible and the rest sit in a native <details> disclosure (V25 L1, V29 L2).
 */
const QUICK_ACTIONS: {
  agent: CommandCenterAgent;
  heading: string;
  icon: typeof FileClock;
  prompts: string[];
}[] = [
  {
    agent: 'contract-risk',
    heading: 'Contract expiry & SLA',
    icon: FileClock,
    prompts: [
      'Which contracts expire in the next 90 days, and how much revenue is at risk?',
      'Which commitments are under-fulfilled and exposed to SLA penalties?',
      'Forecast SLA penalty exposure by risk tier, and recommend mitigations for the highest tier.',
      'Generate a contract risk report for the top 10 at-risk accounts.',
    ],
  },
  {
    agent: 'order-provisioning',
    heading: 'Orders & revenue waterfall',
    icon: PackageSearch,
    prompts: [
      'Which orders have been stuck in provisioning for more than 30 days, and how much revenue is at risk?',
      'Show the revenue waterfall from contracted to billed to collected, and where it breaks.',
    ],
  },
  {
    agent: 'command-center',
    heading: 'Credits & disputes',
    icon: ReceiptText,
    prompts: [
      'Where is the largest credit leakage at HIGH severity?',
      'Which dispute patterns point to systemic billing errors?',
    ],
  },
  {
    agent: 'triage-analytics',
    heading: 'Triage & root cause',
    icon: ListChecks,
    prompts: [
      'What is triage accuracy by check type, and which types are under-prioritized?',
      'Classify the root causes of exceptions currently labeled OTHER.',
    ],
  },
  {
    agent: 'adjustment-fraud',
    heading: 'Adjustments & rep fraud',
    icon: UserSearch,
    prompts: [
      'Which reps show anomalous bill-adjustment patterns?',
      'Investigate the largest bill-adjustment anomalies this quarter.',
      'Which exception types keep recurring after a case is closed?',
    ],
  },
];

/** Specialist supervisors run several UC-function tools; answers take about 40-110 seconds (smoke-tested 2026-10-28). */
const SLOW_HINT_AFTER_S = 10;

const PROMPT_BUTTON_CLASS =
  'rounded-lg border border-border bg-background px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * V29 L2 (WCAG 1.4.10 content parity): the first `visibleCount` prompts always show.
 * At sm and up the rest render inline. Below sm they go inside a native <details>,
 * so no shortcut is lost at 375px. Only one copy is ever displayed (display:none
 * hides the other), and no JS state is used.
 */
function PromptButtons({
  prompts,
  visibleCount,
  moreLabel,
  onPick,
}: {
  prompts: string[];
  visibleCount: number;
  moreLabel: string;
  onPick: (q: string) => void;
}) {
  const head = prompts.slice(0, visibleCount);
  const rest = prompts.slice(visibleCount);
  const renderButton = (q: string, extra = '') => (
    <button key={q} type="button" onClick={() => onPick(q)} className={`${extra}${PROMPT_BUTTON_CLASS}`}>
      {q}
    </button>
  );
  return (
    <div className="flex flex-col gap-2">
      {head.map((q) => renderButton(q))}
      {rest.map((q) => renderButton(q, 'hidden sm:block '))}
      {rest.length > 0 && (
        <details className="sm:hidden">
          <summary className="cursor-pointer rounded text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {moreLabel} ({rest.length})
          </summary>
          <div className="mt-2 flex flex-col gap-2">{rest.map((q) => renderButton(q))}</div>
        </details>
      )}
    </div>
  );
}

export function CommandCenterPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<CommandCenterAgent>('command-center');
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();

  /** Build context from current route. */
  const getContext = useCallback((): CommandCenterContext => {
    const page = location.pathname;
    const meta = PAGE_CONTEXT[page];
    return {
      page,
      pageTitle: meta?.title ?? 'Unknown',
    };
  }, [location.pathname]);

  /** Scroll chat to bottom. */
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() =>
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    );
  }, []);

  /** Send a message. */
  const send = useCallback(
    async (text?: string, target?: CommandCenterAgent) => {
      const content = (text ?? input).trim();
      if (!content || loading) return;

      // A quick action for a different agent starts a fresh conversation with it.
      const switching = target !== undefined && target !== agent;
      const activeAgent = target ?? agent;
      if (switching) setAgent(activeAgent);

      const userMsg: ChatMessage = { role: 'user', content };
      const next = [...(switching ? [] : messages), userMsg];
      setMessages(next);
      setInput('');
      setError(null);
      setLoading(true);
      // V26 N2: a prompt/quick-action button unmounts once messages exist; keep focus in the input.
      if (text !== undefined) inputRef.current?.focus();
      scrollToBottom();

      try {
        const { content: reply } = await commandCenterApi.send(
          next,
          getContext(),
          undefined,
          activeAgent
        );
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to reach the Command Center.'
        );
      } finally {
        setLoading(false);
        scrollToBottom();
      }
    },
    [input, loading, messages, agent, getContext, scrollToBottom]
  );

  /** Tick an elapsed-seconds counter while a request is in flight. */
  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    return () => window.clearInterval(id);
  }, [loading]);

  /** Handle Enter key. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send]
  );

  /** Reset conversation. */
  const reset = useCallback(() => {
    setMessages([]);
    setInput('');
    setError(null);
    setAgent('command-center');
  }, []);

  /** Focus input when panel opens. */
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [open]);

  const pageMeta = PAGE_CONTEXT[location.pathname];

  return (
    <>
      {/* Floating action button — bottom-right, visible on all pages */}
      <Button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label="Open Command Center"
        title="Revenue Recovery Command Center"
      >
        <MessageSquareText className="h-6 w-6" />
      </Button>

      {/* Slide-out panel */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col sm:w-[28rem] md:w-[32rem]"
          aria-label="Command Center"
        >
          {/* Header */}
          <SheetHeader className="flex-none border-b border-border pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10">
                  <Sparkles className="h-4 w-4 text-brand" />
                </div>
                <div>
                  <SheetTitle className="text-sm">Command Center</SheetTitle>
                  <SheetDescription className="text-xs">
                    {agent === 'command-center'
                      ? 'Revenue Recovery AI — 8 tools, 5 agents'
                      : `Talking to the ${AGENT_META[agent].label}`}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {(messages.length > 0 || agent !== 'command-center') && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={reset}
                    aria-label="New conversation"
                    title="New conversation"
                    className="h-8 w-8"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setOpen(false)}
                  aria-label="Close Command Center"
                  className="h-8 w-8"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {/* Context chip — shows which page the analyst is on */}
            {pageMeta && (
              <div className="mt-2 flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{pageMeta.title}</span>
                <span className="hidden sm:inline">· {pageMeta.description}</span>
              </div>
            )}
          </SheetHeader>

          {/* Chat message list */}
          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-3 overflow-y-auto px-1 py-3"
            role="log"
            aria-label="Command Center messages"
            aria-busy={loading}
          >
            {messages.length === 0 && !loading && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
                  <Bot className="h-6 w-6 text-brand" />
                </div>
                <div className="text-center">
                  <div className="text-sm font-medium text-foreground">Revenue Recovery Command Center</div>
                  {/* V25 L1: intro hidden below sm so a specialist quick action stays above the fold at 375px. */}
                  <div className="mt-1 hidden max-w-xs text-xs text-muted-foreground sm:block">
                    Ask about leakage analysis, recovery strategy, contract compliance, root
                    causes, or get an executive briefing. Context from your current view is
                    automatically included.
                  </div>
                </div>
                <div className="w-full px-4">
                  <PromptButtons
                    prompts={SUGGESTED_PROMPTS}
                    visibleCount={2}
                    moreLabel="More suggested prompts"
                    onPick={(q) => send(q)}
                  />
                </div>
                {QUICK_ACTIONS.map((group) => {
                  const Icon = group.icon;
                  const headingId = `cc-quick-${group.agent}`;
                  return (
                    <section key={group.agent} aria-labelledby={headingId} className="w-full px-4">
                      <h3
                        id={headingId}
                        className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                        {group.heading}
                        <span className="font-normal">· {AGENT_META[group.agent].label}</span>
                      </h3>
                      {/* V29 L3: the duration applies only to specialist supervisors (smoke-tested 41-107s, 2026-10-28/29). */}
                      {group.agent !== 'command-center' && (
                        <p className="-mt-1 mb-1.5 text-xs text-muted-foreground">Usually 1–2 min</p>
                      )}
                      <PromptButtons
                        prompts={group.prompts}
                        visibleCount={1}
                        moreLabel={`More ${group.heading} prompts`}
                        onPick={(q) => send(q, group.agent)}
                      />
                    </section>
                  );
                })}
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {m.role === 'assistant' && (
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10">
                    <Bot className="h-3.5 w-3.5 text-brand" />
                  </div>
                )}
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-brand text-brand-foreground'
                      : 'bg-muted/50 text-foreground border border-border'
                  }`}
                >
                  <div className="whitespace-pre-wrap">
                    {/* V25 L2: speaker name for screen readers (aria-label on a generic div is prohibited). */}
                    <span className="sr-only">
                      {m.role === 'user' ? 'You' : AGENT_META[agent].label} said:{' '}
                    </span>
                    {m.content}
                  </div>
                </div>
                {m.role === 'user' && (
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* V25 M1: always-mounted live region; only its text changes so NVDA/VoiceOver announce it.
              The 10s hint lives inside the region so it is announced once when it appears.
              V26 N1: status + alert sit OUTSIDE the aria-busy role=log so AT does not suppress them. */}
          <div
              id="cc-status"
              role="status"
              aria-live="polite"
              className={loading ? 'flex flex-col gap-0.5 text-xs text-muted-foreground' : 'sr-only'}
            >
              {loading && (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>
                    {agent === 'command-center'
                      ? 'Command Center is thinking…'
                      : `${AGENT_META[agent].label} is running its tools…`}
                  </span>
                  {/* Ticking counter is visual only so screen readers are not re-announced every second. */}
                  <span aria-hidden="true" className="tabular-nums">{elapsed}s</span>
                </div>
              )}
              {loading && elapsed >= SLOW_HINT_AFTER_S && (
                <div className="pl-5">
                  {agent === 'command-center'
                    ? 'Complex questions can take a few minutes. You can keep the panel open.'
                    : 'Multi-tool analyses usually take 1–2 minutes. You can keep the panel open.'}
                </div>
              )}
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

          {/* Input bar */}
          <div className="flex-none border-t border-border px-1 pt-3 pb-1">
            <div className="flex gap-2">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Ask the ${AGENT_META[agent].label}…`}
                className="min-h-[2.5rem] resize-none"
                rows={1}
                // V25 M2: readOnly (not disabled) keeps keyboard focus in the textarea during a ~40-60s run.
                readOnly={loading}
                // V26 L1: aria-busy is not meaningful on a form control; point at the status region instead.
                aria-describedby="cc-status"
                aria-label={`${AGENT_META[agent].label} message input`}
              />
              <Button
                size="icon"
                onClick={() => send()}
                disabled={!input.trim() || loading}
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
