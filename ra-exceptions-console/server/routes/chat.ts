// Chat route — proxies analyst Q&A to the recovery orchestrator serving endpoint.
//
// The endpoint is a Databricks Agent (supervisor v2) that can answer questions
// about recovery strategy, exception patterns, and leakage root causes.
// Its name is injected as RECOVERY_ORCHESTRATOR_ENDPOINT from the
// `recovery-orchestrator-agent` serving_endpoint app resource (RA-APP-AGENT-ENDPOINTS-PARAM-1110).

import { z } from 'zod';
import type { Application } from 'express';
import { getServingAuth } from '../serving-auth';
import { resolveEndpointName } from './command-center';

interface AppKitWithServer {
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

/** Env var populated from the `recovery-orchestrator-agent` serving_endpoint app resource. */
export const RECOVERY_ORCHESTRATOR_ENDPOINT_ENV = 'RECOVERY_ORCHESTRATOR_ENDPOINT';

const ChatRequest = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(4000),
    })
  ).min(1).max(50),
});

export function setupChatRoutes(appkit: AppKitWithServer) {
  appkit.server.extend((app) => {
    // POST /api/chat — send conversation to the recovery orchestrator.
    app.post('/api/chat', async (req, res) => {
      const parsed = ChatRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid chat request', details: parsed.error.issues });
        return;
      }

      const endpoint = resolveEndpointName(RECOVERY_ORCHESTRATOR_ENDPOINT_ENV);
      if (!endpoint) {
        console.error(`[chat] ${RECOVERY_ORCHESTRATOR_ENDPOINT_ENV} is not configured`);
        res.status(503).json({ error: 'Recovery orchestrator not configured' });
        return;
      }

      // Auth as the app service principal (CAN_QUERY via databricks.yml);
      // DATABRICKS_TOKEN is a local-dev fallback only.
      let auth;
      try {
        auth = await getServingAuth();
      } catch (err) {
        console.error('[chat] Auth error:', err);
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
          headers: {
            'Content-Type': 'application/json',
            ...auth.headers,
          },
          body: JSON.stringify({ messages: parsed.data.messages }),
        });

        if (!upstream.ok) {
          const body = await upstream.text().catch(() => '');
          console.error(`[chat] Serving endpoint returned ${upstream.status}:`, body);
          res.status(502).json({ error: 'Recovery orchestrator unavailable', status: upstream.status });
          return;
        }

        const result = await upstream.json();

        // The response follows OpenAI chat-completion format.
        const content =
          result?.choices?.[0]?.message?.content ??
          result?.output?.content ??
          result?.content ??
          (typeof result === 'string' ? result : JSON.stringify(result));

        res.json({ content });
      } catch (err) {
        console.error('[chat] Proxy error:', err);
        res.status(500).json({ error: 'Failed to reach recovery orchestrator' });
      }
    });
  });
}
