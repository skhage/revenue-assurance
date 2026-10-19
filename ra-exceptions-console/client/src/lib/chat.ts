// Thin client for the chat API (server/routes/chat.ts).

import type { ChatMessage } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
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
