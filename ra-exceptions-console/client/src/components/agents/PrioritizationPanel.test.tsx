// @vitest-environment jsdom
//
// Exercises PrioritizationPanel's failure-atomic mutation ordering (audit
// note before assignment, no duplicate note on retry) and the shared-
// selection wiring (carrying a ranked row forward highlights it and calls
// onSelect with the underlying exception).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrioritizationPanel } from './PrioritizationPanel';
import type { ExceptionRow } from '../../lib/types';
import type { PipelineHealth } from '../../lib/agents/types';

const OK_HEALTH: PipelineHealth = {
  state: 'ok',
  reason: 'green',
  rows: [],
  freshestObservedAt: new Date().toISOString(),
};

const EXCEPTIONS: ExceptionRow[] = [
  {
    exception_id: 'exc-1',
    reference_id: 'REF-100',
    account_name: 'Acme Fiber',
    check_type: 'ar_collection_risk',
    severity: 'HIGH',
    amount_at_risk: 50000,
    detection_method: 'rule_based',
    source_table: 'oracle_erp_source.ar_payment_schedules_all',
    customer_id: 1,
    known_leakage_flag: true,
    status: 'New',
    assignee: null,
  },
  {
    exception_id: 'exc-2',
    reference_id: 'REF-200',
    account_name: 'GlobeTel',
    check_type: 'unauthorized_discount',
    severity: 'LOW',
    amount_at_risk: 100,
    detection_method: 'ai_extracted',
    source_table: 'salesforce_source.sbqq__quoteline__c',
    customer_id: 2,
    known_leakage_flag: false,
    status: 'New',
    assignee: null,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function makeTrackedFetch(opts: { failOn?: (path: string, method: string) => boolean } = {}) {
  const calls: { method: string; path: string }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url });

    if (opts.failOn?.(url, method)) {
      return jsonResponse({ error: 'simulated failure' }, 500);
    }
    if (url.startsWith('/api/analytics/exceptions')) return jsonResponse(EXCEPTIONS);
    if (url === '/api/cases' || url === '/api/cases?mine=1') return jsonResponse([]);
    if (url.match(/^\/api\/cases\/exc-\d+\/notes$/) && method === 'POST')
      return jsonResponse({ case: null, notes: [] });
    if (url.match(/^\/api\/cases\/exc-\d+\/assign$/) && method === 'POST') {
      return jsonResponse({ case: { status: 'New', assignee: 'someone@demo' }, notes: [] });
    }
    return jsonResponse({});
  });
  return { fetchMock, calls };
}

describe('PrioritizationPanel — failure-atomic mutation ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the audit note before the assignment mutation', async () => {
    const { fetchMock, calls } = makeTrackedFetch();
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const applyButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(applyButtons[0]);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Assigned/i }).length).toBeGreaterThan(0);
    });

    const noteIndex = calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/notes'));
    const assignIndex = calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/assign'));
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(assignIndex).toBeGreaterThan(noteIndex);
  });

  it('never assigns if the audit note write fails', async () => {
    const { fetchMock, calls } = makeTrackedFetch({
      failOn: (path, method) => path.endsWith('/notes') && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const applyButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(applyButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });
    expect(calls.some((c) => c.path.endsWith('/assign'))).toBe(false);
  });

  it('retrying after a failed assignment does not re-write the audit note', async () => {
    let assignShouldFail = true;
    const { fetchMock, calls } = makeTrackedFetch({
      failOn: (path, method) => assignShouldFail && path.endsWith('/assign') && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const applyButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(applyButtons[0]);
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    assignShouldFail = false;
    const retryButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(retryButtons[0]);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Assigned/i }).length).toBeGreaterThan(0);
    });

    const noteWrites = calls.filter((c) => c.method === 'POST' && c.path === '/api/cases/exc-1/notes');
    expect(noteWrites).toHaveLength(1);
  });
});

describe('PrioritizationPanel — shared selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carrying a ranked row forward calls onSelect with the underlying exception and highlights the row', async () => {
    const { fetchMock } = makeTrackedFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();

    const user = userEvent.setup();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={onSelect} />);

    const carryButtons = await screen.findAllByRole('button', { name: /Carry forward/i });
    await user.click(carryButtons[0]);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ exception_id: 'exc-1' }));
  });

  it('renders the currently-shared selection as visibly selected in the ranked table', async () => {
    const { fetchMock } = makeTrackedFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<PrioritizationPanel health={OK_HEALTH} selected={EXCEPTIONS[0]} onSelect={() => {}} />);

    const row = (await screen.findByText('Acme Fiber')).closest('tr');
    expect(row).toHaveAttribute('data-state', 'selected');
    expect(within(row!).getByRole('button', { name: /Selected/i })).toBeInTheDocument();
  });
});
