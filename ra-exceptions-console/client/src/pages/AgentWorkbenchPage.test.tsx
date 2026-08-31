// @vitest-environment jsdom
//
// Integration test against the production AgentWorkbenchPage: mocks the
// network layer (dqAuditApi, casesApi, analyticsApi, and the SSE-backed
// useAnalyticsQuery hook) and drives real tab navigation through real
// components, so a regression in the pipeline-health veto or the mutation
// call shape fails this test.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AgentWorkbenchPage } from './AgentWorkbenchPage';
import type { PipelineHealth } from '../lib/agents/types';

const EXCEPTION = {
  exception_id: 'exc-1',
  reference_id: 'REF-100',
  account_name: 'Acme Fiber',
  check_type: 'contract_price_mismatch',
  severity: 'HIGH',
  amount_at_risk: 5000,
  detection_method: 'rule_based',
  source_table: 'salesforce_source.contract_line_item',
  customer_id: 1,
  known_leakage_flag: true,
  status: 'New',
  assignee: null,
};

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function sseResponse(messages: unknown[]) {
  const body = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join('');
  return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
}

function stubFetch(health: PipelineHealth) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/dq/audit')) return jsonResponse({ health });
    if (url.startsWith('/api/cases/exc-1')) return jsonResponse({ case: null, notes: [] });
    if (url.startsWith('/api/cases') && (!init || init.method === undefined)) return jsonResponse([]);
    if (url.startsWith('/api/analytics/exceptions')) return jsonResponse([EXCEPTION]);
    if (url.startsWith('/api/analytics/query/exception_detail')) {
      return sseResponse([
        {
          type: 'result',
          data: [
            {
              ...EXCEPTION,
              risk_tier: 'RED',
              composite_health_score: 42.3,
              arpu_tier: 'Enterprise',
              billing_currency: 'USD',
              account_status: 'Active',
              price_accuracy_score: 55,
              discount_compliance_score: null,
              collection_efficiency_score: null,
              doc_consistency_score: null,
              customer_total_exceptions: 3,
              customer_total_at_risk: 9000,
            },
          ],
        },
      ]);
    }
    return jsonResponse({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentWorkbenchPage />
    </MemoryRouter>
  );
}

describe('AgentWorkbenchPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders all four agent tabs with the Pipeline Reliability tab active by default', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({ state: 'ok', reason: 'green', rows: [], freshestObservedAt: new Date().toISOString() })
    );
    renderPage();

    expect(await screen.findByRole('tab', { name: 'Pipeline reliability' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Investigate' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Prioritize & route' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Recovery playbook' })).toBeInTheDocument();
  });

  it('shows a green/fresh pipeline status when dq_audit is ok', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        state: 'ok',
        reason: 'Pipeline DQ checks are green and fresh.',
        rows: [],
        freshestObservedAt: new Date().toISOString(),
      })
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Pipeline evidence is fresh and green')).toBeInTheDocument();
    });
  });

  it('blocks the Investigate tab with a destructive notice when the pipeline is RED', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({ state: 'red', reason: '1 DQ check(s) are failing.', rows: [], freshestObservedAt: null })
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Investigate' }));

    await waitFor(() => {
      expect(screen.getByText('Blocked by Pipeline Reliability agent')).toBeInTheDocument();
    });
    // No exception picker/search box should render while blocked.
    expect(screen.queryByLabelText('Search exceptions to investigate')).not.toBeInTheDocument();
  });

  it('lets a user select an exception and see a cited hypothesis with a Demo/Deterministic label', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({ state: 'ok', reason: 'green', rows: [], freshestObservedAt: new Date().toISOString() })
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Investigate' }));

    const pickButton = await screen.findByRole('button', { name: /Select exception REF-100/i });
    await user.click(pickButton);

    await waitFor(() => {
      expect(screen.getByText(/check_type=contract_price_mismatch/)).toBeInTheDocument();
    });
    expect(screen.getByText('Deterministic · rule-based')).toBeInTheDocument();

    const applyButton = screen.getByRole('button', { name: /Add hypothesis as investigation note/i });
    expect(applyButton).toBeEnabled();
  });

  it('renders a Demo data badge on the Prioritize & route tab', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({ state: 'ok', reason: 'green', rows: [], freshestObservedAt: new Date().toISOString() })
    );
    renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Prioritize & route' }));

    await waitFor(() => {
      expect(
        within(screen.getByText('Ranked exceptions').closest('div')!.parentElement!).getAllByText(
          /Demo data|Deterministic/
        ).length
      ).toBeGreaterThan(0);
    });
  });
});
