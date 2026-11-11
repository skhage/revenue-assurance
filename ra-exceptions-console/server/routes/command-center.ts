// Command Center route — proxies analyst Q&A to the Revenue Recovery Command Center
// supervisor agent and its specialist supervisors (Agent Bricks MAS). The command-center
// agent is the master agent that coordinates all RA AI capabilities: triage, recovery,
// compliance, root cause, and executive briefing.
//
// Serving endpoint names are NOT hardcoded (public repo, RA-APP-AGENT-ENDPOINTS-PARAM-1110):
// each is injected as an env var from its serving_endpoint app resource
// (app.yaml valueFrom / databricks.yml config.env value_from) and resolved per request.

import { z } from 'zod';
import type { Application } from 'express';
import { getServingAuth } from '../serving-auth';

interface AppKitWithServer {
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

// Allowlisted Agent Bricks supervisors. Clients pick an `agent` key, never a raw
// endpoint name, so the proxy cannot be pointed at arbitrary serving endpoints.
//   command-center — master Command Center supervisor (default)
//   contract-risk  — detect_expiring_contracts, analyze_sla_compliance,
//                    generate_contract_risk_report (RA-AI-RECOVERY-SUPERVISOR-TOOLS)
//   adjustment-fraud — investigate_adjustment_anomalies, analyze_rep_adjustment_patterns,
//                    detect_exception_recurrence (RA-AI-RECOVERY-SUPERVISOR-TOOLS)
//   order-provisioning — Order-to-Provisioning Integrity supervisor: detect_provisioning_misalignment,
//                    analyze_revenue_waterfall (RA-AI-REMAINING-SUPERVISOR-GAPS)
//   triage-analytics — Triage supervisor: classify_root_cause, analyze_triage_effectiveness
//                    (RA-AI-REMAINING-SUPERVISOR-GAPS)
// SLA tools (assess_sla_penalty_risk, recommend_sla_mitigation, forecast_penalty_exposure) live on
// contract-risk; dispute tools (detect_credit_leakage, analyze_dispute_patterns) on command-center.
// Each key maps to the env var populated from the matching serving_endpoint app resource
// (command-center-agent, contract-risk-agent, adjustment-fraud-agent,
// order-provisioning-agent, triage-analytics-agent).
export const AGENT_ENDPOINT_ENV = {
  'command-center': 'COMMAND_CENTER_ENDPOINT',
  'contract-risk': 'CONTRACT_RISK_ENDPOINT',
  'adjustment-fraud': 'ADJUSTMENT_FRAUD_ENDPOINT',
  'order-provisioning': 'ORDER_PROVISIONING_ENDPOINT',
  'triage-analytics': 'TRIAGE_ANALYTICS_ENDPOINT',
} as const;

export type AgentKey = keyof typeof AGENT_ENDPOINT_ENV;

// Serving endpoint names: letters, digits, '-' and '_' (also keeps the URL path safe).
const ENDPOINT_NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;

// Unfilled databricks.yml variable defaults look like REPLACE_WITH_<NAME>; never call them.
const PLACEHOLDER_PREFIX = 'REPLACE_WITH_';

/**
 * Resolve a serving endpoint name from an env var at request time.
 * Returns null when the variable is unset, blank, a REPLACE_WITH_* placeholder,
 * or not a valid endpoint name — callers answer 503 in that case.
 */
export function resolveEndpointName(
  envVar: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env[envVar]?.trim();
  if (!value || value.startsWith(PLACEHOLDER_PREFIX) || !ENDPOINT_NAME_RE.test(value)) return null;
  return value;
}

/** Resolve the endpoint for an allowlisted supervisor key. */
export function resolveAgentEndpoint(
  agent: AgentKey,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return resolveEndpointName(AGENT_ENDPOINT_ENV[agent], env);
}

/**
 * Extract the final answer text from an Agent Bricks (Responses API) payload.
 * The `output` array interleaves message / function_call / function_call_output
 * items, and sub-agent hand-offs appear as extra `message` items prefixed with a
 * `<name>sub_agent</name>` tag. The supervisor's synthesized answer is the LAST
 * non-empty message, so return that one with any leading name tag stripped.
 * Falls back to OpenAI chat-completion shapes for non-MAS endpoints.
 */
export function extractAgentText(result: unknown): string {
  const r = result as Record<string, any> | null;
  const output = Array.isArray(r?.output) ? (r!.output as any[]) : null;
  if (output) {
    const textOf = (item: any): string =>
      Array.isArray(item?.content)
        ? item.content
            .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('')
        : typeof item?.content === 'string'
          ? item.content
          : '';
    const texts = output
      .filter((o) => o?.type === 'message')
      .map((o) => textOf(o).replace(/^\s*<name>[^<]*<\/name>\s*/, '').trim())
      .filter(Boolean);
    if (texts.length > 0) return texts[texts.length - 1];
  }
  const chat = r?.choices?.[0]?.message?.content ?? r?.content;
  if (typeof chat === 'string') return chat;
  return typeof result === 'string' ? result : JSON.stringify(result);
}

const CommandCenterRequest = z.object({
  agent: z
    .enum(Object.keys(AGENT_ENDPOINT_ENV) as [AgentKey, ...AgentKey[]])
    .optional()
    .default('command-center'),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(8000),
      })
    )
    .min(1)
    .max(50),
  context: z
    .object({
      page: z.string().optional(),
      pageTitle: z.string().optional(),
      activeFilters: z.record(z.string()).optional(),
      selectedExceptionId: z.string().optional(),
      selectedCustomerId: z.number().optional(),
    })
    .optional(),
});

/** Build a system-level context preamble from the page context. */
function buildContextPreamble(ctx?: z.infer<typeof CommandCenterRequest>['context']): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.pageTitle) parts.push(`The analyst is currently on the "${ctx.pageTitle}" page.`);
  if (ctx.activeFilters && Object.keys(ctx.activeFilters).length > 0) {
    const filters = Object.entries(ctx.activeFilters)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`Active filters: ${filters}.`);
  }
  if (ctx.selectedExceptionId) parts.push(`Selected exception: ${ctx.selectedExceptionId}.`);
  if (ctx.selectedCustomerId) parts.push(`Selected customer ID: ${ctx.selectedCustomerId}.`);
  return parts.length > 0
    ? `[Console context] ${parts.join(' ')}\n\n`
    : '';
}

export function setupCommandCenterRoutes(appkit: AppKitWithServer) {
  appkit.server.extend((app) => {
    // POST /api/command-center — send conversation to the Command Center supervisor agent.
    app.post('/api/command-center', async (req, res) => {
      const parsed = CommandCenterRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
        return;
      }

      const endpoint = resolveAgentEndpoint(parsed.data.agent);
      if (!endpoint) {
        console.error(
          `[command-center] ${AGENT_ENDPOINT_ENV[parsed.data.agent]} is not configured`
        );
        res.status(503).json({ error: 'Command Center agent not configured', agent: parsed.data.agent });
        return;
      }

      // Auth as the app service principal (CAN_QUERY granted via databricks.yml
      // serving_endpoint resources); DATABRICKS_TOKEN is a local-dev fallback only.
      let auth;
      try {
        auth = await getServingAuth();
      } catch (err) {
        console.error('[command-center] Auth error:', err);
        res.status(503).json({ error: 'Databricks credentials not available' });
        return;
      }
      if (!auth) {
        res.status(503).json({ error: 'Databricks credentials not available' });
        return;
      }

      // Prepend page context to the first user message so the agent knows where the analyst is.
      const preamble = buildContextPreamble(parsed.data.context);
      const messages = parsed.data.messages.map((m, i) => {
        if (i === 0 && m.role === 'user' && preamble) {
          return { ...m, content: preamble + m.content };
        }
        return m;
      });

      const url = `${auth.host}/serving-endpoints/${endpoint}/invocations`;

      try {
        const upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...auth.headers,
          },
          // Agent Bricks supervisors reject `messages`; they require the Responses-API `input` field.
          body: JSON.stringify({ input: messages }),
        });

        if (!upstream.ok) {
          const body = await upstream.text().catch(() => '');
          console.error(`[command-center] ${endpoint} returned ${upstream.status}:`, body);
          res.status(502).json({
            error: 'Command Center unavailable',
            status: upstream.status,
          });
          return;
        }

        const result = await upstream.json();
        res.json({ content: extractAgentText(result), agent: parsed.data.agent });
      } catch (err) {
        console.error('[command-center] Proxy error:', err);
        res.status(500).json({ error: 'Failed to reach Command Center' });
      }
    });
  });
}
