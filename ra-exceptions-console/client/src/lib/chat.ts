// Thin client for the chat API (server/routes/chat.ts).

import type { ChatMessage } from './types';

/**
 * V43 L1: map server errors to analyst-friendly copy. The server's 503 bodies
 * ("... not configured", "Databricks credentials not available") are operator
 * diagnostics, so they are never shown verbatim. Other statuses keep the server
 * message, which is already user-facing.
 */
export function friendlyApiError(
  status: number,
  serverError: string | undefined,
  statusText: string,
  service: string
): string {
  if (status === 503) {
    const raw = (serverError ?? '').toLowerCase();
    if (raw.includes('not configured')) {
      return `The ${service} isn't connected in this environment yet. Ask your workspace admin to configure its serving endpoint, then try again.`;
    }
    if (raw.includes('credentials')) {
      return `The ${service} couldn't sign in to Databricks just now. Please try again in a moment.`;
    }
    return `The ${service} is temporarily unavailable. Please try again in a moment.`;
  }
  return serverError || statusText || `The ${service} request failed. Please try again.`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(friendlyApiError(res.status, body.error, res.statusText, 'recovery assistant'));
  }
  return res.json() as Promise<T>;
}

export const chatApi = {
  /** Send a conversation to the recovery orchestrator and get a response. */
  send: (messages: ChatMessage[], signal?: AbortSignal) =>
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    }).then((r) => json<{ content: string }>(r)),
};
