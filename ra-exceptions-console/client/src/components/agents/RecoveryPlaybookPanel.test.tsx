// @vitest-environment jsdom
//
// Exercises the failure-atomic mutation ordering directly against
// RecoveryPlaybookPanel: the audit note must always be written before the
// case-lifecycle mutation, a failed mutation step must never leave the
// approved recommendation unaudited, and retrying after a partial failure
// must resume at the mutation step without re-writing the note.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecoveryPlaybookPanel } from './RecoveryPlaybookPanel';
import type { ExceptionRow } from '../../lib/types';
import type { PipelineHealth } from '../../lib/agents/types';

const EXCEPTION: ExceptionRow = {
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

const OK_HEALTH: PipelineHealth = {
  state: 'ok',
  reason: 'green',
  rows: [],
  freshestObservedAt: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

/** Records every mutating call (method + path) in order, in `calls`. */
function makeTrackedFetch(opts: { caseStatus?: string; failOn?: (path: string, method: string) => boolean }) {
  const calls: { method: string; path: string }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url });

    if (opts.failOn?.(url, method)) {
      return jsonResponse({ error: 'simulated failure' }, 500);
    }

    if (url === '/api/cases/exc-1' && method === 'GET') {
      return jsonResponse({
        case: opts.caseStatus ? { exception_id: 'exc-1', status: opts.caseStatus, assignee: 'someone@demo' } : null,
        notes: [],
      });
    }
    if (url === '/api/cases/exc-1/notes' && method === 'POST') {
      return jsonResponse({ case: null, notes: [] });
    }
    if (url === '/api/cases/exc-1/assign' && method === 'POST') {
      return jsonResponse({ case: { exception_id: 'exc-1', status: 'New', assignee: 'analyst@demo' }, notes: [] });
    }
    if (url === '/api/cases/exc-1/status' && method === 'POST') {
      return jsonResponse({
        case: { exception_id: 'exc-1', status: 'Recovering', assignee: 'analyst@demo' },
        notes: [],
      });
    }
    if (url === '/api/whoami') return jsonResponse({ user: 'analyst@demo' });
    return jsonResponse({});
  });
  return { fetchMock, calls };
}

describe('RecoveryPlaybookPanel — failure-atomic mutation ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the audit note before any case mutation on the happy path', async () => {
    const { fetchMock, calls } = makeTrackedFetch({ caseStatus: 'New' });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Moved to Recovering/i })).toBeInTheDocument();
    });

    const noteIndex = calls.findIndex((c) => c.path === '/api/cases/exc-1/notes');
    const assignIndex = calls.findIndex((c) => c.path === '/api/cases/exc-1/assign');
    const statusIndex = calls.findIndex((c) => c.path === '/api/cases/exc-1/status');
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(assignIndex).toBeGreaterThan(noteIndex);
    expect(statusIndex).toBeGreaterThan(assignIndex);
  });

  it('never mutates the case if the audit note write fails', async () => {
    const { fetchMock, calls } = makeTrackedFetch({
      caseStatus: 'New',
      failOn: (path, method) => path === '/api/cases/exc-1/notes' && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    expect(calls.some((c) => c.path === '/api/cases/exc-1/assign')).toBe(false);
    expect(calls.some((c) => c.path === '/api/cases/exc-1/status')).toBe(false);
  });

  it('leaves an audit note even when the lifecycle mutation fails after the note succeeds', async () => {
    const { fetchMock, calls } = makeTrackedFetch({
      caseStatus: 'New',
      failOn: (path, method) => path === '/api/cases/exc-1/assign' && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    // The note landed before the failing mutation step — the human-approved
    // recommendation is never lost even though the transition didn't finish.
    expect(calls.filter((c) => c.path === '/api/cases/exc-1/notes' && c.method === 'POST')).toHaveLength(1);
  });

  it('retrying after a partial failure resumes at the mutation without re-writing the note', async () => {
    let assignShouldFail = true;
    const { fetchMock, calls } = makeTrackedFetch({
      caseStatus: 'New',
      failOn: (path, method) => assignShouldFail && path === '/api/cases/exc-1/assign' && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    // Second attempt succeeds.
    assignShouldFail = false;
    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Moved to Recovering/i })).toBeInTheDocument();
    });

    // Exactly one note was ever written across both attempts.
    expect(calls.filter((c) => c.path === '/api/cases/exc-1/notes' && c.method === 'POST')).toHaveLength(1);
  });

  it('resets apply state when the selected exception changes', async () => {
    const { fetchMock } = makeTrackedFetch({ caseStatus: 'New' });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const { rerender } = render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Moved to Recovering/i })).toBeInTheDocument();
    });

    const OTHER: ExceptionRow = { ...EXCEPTION, exception_id: 'exc-2', reference_id: 'REF-200' };
    rerender(<RecoveryPlaybookPanel health={OK_HEALTH} selected={OTHER} onSelect={() => {}} />);

    expect(await screen.findByRole('button', { name: /Apply: move case to Recovering/i })).toBeEnabled();
  });
});

describe('RecoveryPlaybookPanel — demo-data disclosure', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a Demo data badge and caveat next to expected recovery/owner/deadline, and drops the "no invented facts" claim', async () => {
    const { fetchMock } = makeTrackedFetch({});
    vi.stubGlobal('fetch', fetchMock);

    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('Demo data')).toBeInTheDocument();
    });
    expect(screen.getByText(/fixed template assumptions/i)).toBeInTheDocument();
    expect(screen.getByText(/not a forecast/i)).toBeInTheDocument();
    expect(screen.queryByText(/no invented facts/i)).not.toBeInTheDocument();
  });
});
