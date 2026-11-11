// Playbook guidance route — asks the RA Investigation Playbook Knowledge Assistant
// (Agent Bricks KA) for investigation steps and resolution patterns for one check type
// (RA-APP-PLAYBOOK-KA-INTEGRATION).
//
// The serving endpoint name is NOT hardcoded (public repo, RA-APP-PLAYBOOK-ENDPOINT-PARAM-1109):
// it is injected as PLAYBOOK_KA_ENDPOINT from the `playbook-ka-agent` serving_endpoint app
// resource (app.yaml valueFrom / databricks.yml config.env value_from).
//
// The client sends only structured fields (check_type, optional severity); the prompt is
// built server-side so the proxy can't be used as a free-form chat channel to the KA.

import { z } from 'zod';
import type { Application } from 'express';
import { getServingAuth } from '../serving-auth';
import { extractAgentText } from './command-center';

interface AppKitWithServer {
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

/** Env var populated from the `playbook-ka-agent` serving_endpoint app resource. */
export const PLAYBOOK_KA_ENDPOINT_ENV = 'PLAYBOOK_KA_ENDPOINT';

/** Fallback when the resource binding is missing; the route refuses to call it. */
export const PLAYBOOK_KA_ENDPOINT_PLACEHOLDER = 'REPLACE_WITH_PLAYBOOK_KA_ENDPOINT';

// Serving endpoint names: letters, digits, '-' and '_' (also keeps the URL path safe).
const ENDPOINT_NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;

/**
 * Resolve the Playbook KA endpoint name from the environment at request time.
 * Returns the placeholder when the variable is unset, blank, or not a valid endpoint name.
 */
export function resolvePlaybookEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[PLAYBOOK_KA_ENDPOINT_ENV]?.trim();
  return value && ENDPOINT_NAME_RE.test(value) ? value : PLAYBOOK_KA_ENDPOINT_PLACEHOLDER;
}

export const PlaybookGuidanceRequest = z.object({
  // check_type values are snake_case identifiers (e.g. contract_price_mismatch).
  check_type: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  // Client lowercases severity and omits it when outside this set.
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

/** Build the fixed KA prompt for a validated check type. */
export function buildPlaybookPrompt(req: z.infer<typeof PlaybookGuidanceRequest>): string {
  const sev = req.severity ? ` The exception severity is ${req.severity}.` : '';
  return (
    `An RA analyst is investigating a "${req.check_type}" revenue assurance exception.${sev} ` +
    'Using the RA Investigation Playbook, give: (1) a one-sentence definition of this check type, ' +
    '(2) the numbered investigation steps, (3) common resolution patterns, and ' +
    '(4) any data model gotchas. Be concise and use short bullet points.'
  );
}

export function setupPlaybookGuidanceRoutes(appkit: AppKitWithServer) {
  appkit.server.extend((app) => {
    // POST /api/playbook-guidance — KA guidance for one check type.
    app.post('/api/playbook-guidance', async (req, res) => {
      const parsed = PlaybookGuidanceRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
        return;
      }

      const endpoint = resolvePlaybookEndpoint();
      if (endpoint === PLAYBOOK_KA_ENDPOINT_PLACEHOLDER) {
        console.error(`[playbook-guidance] ${PLAYBOOK_KA_ENDPOINT_ENV} is not configured`);
        res.status(503).json({ error: 'Playbook assistant not configured' });
        return;
      }

      // App SP auth (CAN_QUERY via the playbook-ka-agent serving_endpoint resource).
      let auth;
      try {
        auth = await getServingAuth();
      } catch (err) {
        console.error('[playbook-guidance] Auth error:', err);
        res.status(503).json({ error: 'Databricks credentials not available' });
        return;
      }
      if (!auth) {
        res.status(503).json({ error: 'Databricks credentials not available' });
        return;
      }

      const url = `${auth.host}/serving-endpoints/${endpoint}/invocations`;
      try {
        const upstream = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth.headers },
          // Agent Bricks KA endpoints use the Responses-API `input` field (task agent/v1/responses).
          body: JSON.stringify({ input: [{ role: 'user', content: buildPlaybookPrompt(parsed.data) }] }),
        });
        if (!upstream.ok) {
          const body = await upstream.text().catch(() => '');
          console.error(`[playbook-guidance] ${endpoint} returned ${upstream.status}:`, body);
          res.status(502).json({ error: 'Playbook assistant unavailable', status: upstream.status });
          return;
        }
        const result = await upstream.json();
        res.json({ content: extractAgentText(result), check_type: parsed.data.check_type });
      } catch (err) {
        console.error('[playbook-guidance] Proxy error:', err);
        res.status(500).json({ error: 'Failed to reach playbook assistant' });
      }
    });
  });
}
