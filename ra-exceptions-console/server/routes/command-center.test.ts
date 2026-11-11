import { describe, expect, it } from 'vitest';
import {
  AGENT_ENDPOINT_ENV,
  extractAgentText,
  resolveAgentEndpoint,
  resolveEndpointName,
} from './command-center';

const msg = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});

describe('extractAgentText', () => {
  it('returns the last supervisor message from an Agent Bricks Responses payload', () => {
    // Shape captured from the adjustment-fraud supervisor on 2026-10-26.
    const payload = {
      object: 'response',
      output: [
        msg("I'll query the recurrence analysis."),
        { type: 'function_call', name: 'detect_exception_recurrence', arguments: '{}' },
        { type: 'function_call_output', output: '[...]' },
        { type: 'function_call', name: 'ra_analytics', arguments: '{}' },
        msg('<name>ra_analytics</name>'),
        msg('Error: Failed to query Genie space'),
        msg('<name>RA Investigation Assistant</name>\n\nTop 3: rev_rec_timing_mismatch, ...'),
      ],
    };
    expect(extractAgentText(payload)).toBe('Top 3: rev_rec_timing_mismatch, ...');
  });

  it('falls back to OpenAI chat-completion format', () => {
    expect(extractAgentText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });

  it('stringifies unknown shapes instead of throwing', () => {
    expect(extractAgentText({ foo: 1 })).toBe('{"foo":1}');
    expect(extractAgentText({ output: [] })).toBe('{"output":[]}');
  });
});

describe('AGENT_ENDPOINT_ENV', () => {
  it('only allowlists the five RA supervisors', () => {
    expect(Object.keys(AGENT_ENDPOINT_ENV).sort()).toEqual([
      'adjustment-fraud',
      'command-center',
      'contract-risk',
      'order-provisioning',
      'triage-analytics',
    ]);
  });

  it('maps every key to an env var name, not a hardcoded endpoint', () => {
    expect(AGENT_ENDPOINT_ENV).toEqual({
      'command-center': 'COMMAND_CENTER_ENDPOINT',
      'contract-risk': 'CONTRACT_RISK_ENDPOINT',
      'adjustment-fraud': 'ADJUSTMENT_FRAUD_ENDPOINT',
      'order-provisioning': 'ORDER_PROVISIONING_ENDPOINT',
      'triage-analytics': 'TRIAGE_ANALYTICS_ENDPOINT',
    });
  });
});

describe('resolveEndpointName / resolveAgentEndpoint', () => {
  it('reads and trims the endpoint name from the env var', () => {
    expect(resolveAgentEndpoint('command-center', { COMMAND_CENTER_ENDPOINT: 'cc-example-endpoint' })).toBe(
      'cc-example-endpoint'
    );
    expect(resolveAgentEndpoint('triage-analytics', { TRIAGE_ANALYTICS_ENDPOINT: '  triage_example  ' })).toBe(
      'triage_example'
    );
    expect(resolveEndpointName('RECOVERY_ORCHESTRATOR_ENDPOINT', { RECOVERY_ORCHESTRATOR_ENDPOINT: 'orch-example' })).toBe(
      'orch-example'
    );
  });

  it('returns null when unset, blank, or an unfilled placeholder', () => {
    expect(resolveAgentEndpoint('contract-risk', {})).toBeNull();
    expect(resolveAgentEndpoint('contract-risk', { CONTRACT_RISK_ENDPOINT: '   ' })).toBeNull();
    expect(
      resolveAgentEndpoint('contract-risk', { CONTRACT_RISK_ENDPOINT: 'REPLACE_WITH_CONTRACT_RISK_ENDPOINT' })
    ).toBeNull();
  });

  it('rejects names that are not valid serving endpoint names', () => {
    expect(resolveAgentEndpoint('adjustment-fraud', { ADJUSTMENT_FRAUD_ENDPOINT: '../jobs/run' })).toBeNull();
    expect(resolveAgentEndpoint('adjustment-fraud', { ADJUSTMENT_FRAUD_ENDPOINT: 'a'.repeat(64) })).toBeNull();
  });

  it('does not read another agent\'s env var', () => {
    expect(resolveAgentEndpoint('order-provisioning', { COMMAND_CENTER_ENDPOINT: 'cc-example-endpoint' })).toBeNull();
  });
});
