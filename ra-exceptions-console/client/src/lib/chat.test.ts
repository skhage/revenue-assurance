import { describe, expect, it } from 'vitest';
import { friendlyApiError } from './chat';

// V43 L1: server 503 diagnostics must never reach analysts verbatim.
describe('friendlyApiError', () => {
  it('maps the chat 503 "not configured" error to friendly copy', () => {
    const msg = friendlyApiError(503, 'Recovery orchestrator not configured', 'Service Unavailable', 'recovery assistant');
    expect(msg).toContain("recovery assistant isn't connected");
    expect(msg).not.toContain('not configured');
  });

  it('maps the Command Center 503 "not configured" error', () => {
    const msg = friendlyApiError(503, 'Command Center agent not configured', '', 'Command Center agent');
    expect(msg).toContain("Command Center agent isn't connected");
  });

  it('maps the 503 credentials error', () => {
    const msg = friendlyApiError(503, 'Databricks credentials not available', '', 'recovery assistant');
    expect(msg).toContain("couldn't sign in");
    expect(msg).not.toContain('credentials not available');
  });

  it('uses a generic message for other 503s', () => {
    expect(friendlyApiError(503, undefined, 'Service Unavailable', 'x')).toContain('temporarily unavailable');
  });

  it('keeps non-503 server messages and falls back to statusText', () => {
    expect(friendlyApiError(400, 'Invalid request', 'Bad Request', 'x')).toBe('Invalid request');
    expect(friendlyApiError(500, undefined, 'Internal Server Error', 'x')).toBe('Internal Server Error');
    expect(friendlyApiError(500, undefined, '', 'x')).toContain('request failed');
  });
});
