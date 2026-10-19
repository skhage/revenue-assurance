// Chat route — proxies analyst Q&A to the ra-recovery-orchestrator-v2 serving endpoint.
//
// The endpoint is a Databricks Agent (supervisor v2) that can answer questions
// about recovery strategy, exception patterns, and leakage root causes.

import { z } from 'zod';
import type { Application } from 'express';

interface AppKitWithServer {
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const ENDPOINT_NAME = 'ra-recovery-orchestrator-v2';

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

      const host = process.env.DATABRICKS_HOST;
      const token = process.env.DATABRICKS_TOKEN;
      if (!host || !token) {
        res.status(503).json({ error: 'Databricks credentials not available' });
        return;
      }

      const url = `${host.replace(/\/$/, '')}/serving-endpoints/${ENDPOINT_NAME}/invocations`;

      try {
        const upstream = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
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
