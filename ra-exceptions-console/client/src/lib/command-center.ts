// Client API for the Command Center supervisor agent (server/routes/command-center.ts).

import type { ChatMessage } from './types';

/** Allowlisted supervisor keys (mirrors AGENT_ENDPOINT_ENV in server/routes/command-center.ts). */
export type CommandCenterAgent =
  | 'command-center'
  | 'contract-risk'
  | 'adjustment-fraud'
  | 'order-provisioning'
  | 'triage-analytics';

export interface CommandCenterContext {
  page?: string;
  pageTitle?: string;
  activeFilters?: Record<string, string>;
  selectedExceptionId?: string;
  selectedCustomerId?: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const commandCenterApi = {
  /** Send a conversation to the Command Center supervisor and get a response. */
  send: (
    messages: ChatMessage[],
    context?: CommandCenterContext,
    signal?: AbortSignal,
    agent: CommandCenterAgent = 'command-center'
  ) =>
    fetch('/api/command-center', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, context, agent }),
      signal,
    }).then((r) => json<{ content: string; agent?: CommandCenterAgent }>(r)),
};
