// @vitest-environment jsdom
//
// Exercises the failure-atomic mutation ordering directly against
// RecoveryPlaybookPanel: the audit note must always be written before the
// case-lifecycle mutation, a failed mutation step must never leave the
// approved recommendation unaudited, and the server-enforced idempotency
// key (not component-local state) must prevent duplicate notes across
// retries, ambiguous lost-response failures, and full component
// remount/reload.
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

interface RequestBody {
  idempotencyKey?: string;
}

function parseBody(raw: BodyInit | null | undefined): RequestBody | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw as string) as RequestBody;
}

interface TrackedFetchOptions {
  caseStatus?: string;
  /** Simulate the server-side unique-index dedup: a repeated (exceptionId, idempotencyKey) is a no-op, matching the real Postgres unique partial index. */
  enforceNoteIdempotency?: boolean;
  failOn?: (path: string, method: string) => boolean;
}

/** Records every mutating call (method + path) in order, in `calls`; tracks durable note inserts by (exceptionId, idempotencyKey) in `notesByExceptionAndKey`, independent of HTTP call count. */
function makeTrackedFetch(opts: TrackedFetchOptions) {
  const calls: { method: string; path: string; body?: RequestBody }[] = [];
  const notesByExceptionAndKey = new Map<string, Set<string>>();
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = parseBody(init?.body);
    calls.push({ method, path: url, body });

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
      const key = body?.idempotencyKey;
      if (opts.enforceNoteIdempotency && key) {
        const existing = notesByExceptionAndKey.get('exc-1') ?? new Set<string>();
        const deduped = existing.has(key);
        existing.add(key);
        notesByExceptionAndKey.set('exc-1', existing);
        return jsonResponse({ case: null, notes: [], deduped });
      }
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
  return { fetchMock, calls, notesByExceptionAndKey };
}

function distinctNoteInserts(notesByExceptionAndKey: Map<string, Set<string>>, exceptionId: string): number {
  return notesByExceptionAndKey.get(exceptionId)?.size ?? 0;
}

describe('RecoveryPlaybookPanel — failure-atomic mutation ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the audit note before any case mutation on the happy path, with a stable idempotency key', async () => {
    const { fetchMock, calls } = makeTrackedFetch({ caseStatus: 'New', enforceNoteIdempotency: true });
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
    expect(calls[noteIndex].body?.idempotencyKey).toBe('agent:recovery-playbook:exc-1');
  });

  it('never mutates the case if the audit note write fails', async () => {
    const { fetchMock, calls } = makeTrackedFetch({
      caseStatus: 'New',
      enforceNoteIdempotency: true,
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

  it('leaves exactly one durable audit note even when the lifecycle mutation fails after the note succeeds', async () => {
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({
      caseStatus: 'New',
      enforceNoteIdempotency: true,
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
    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('retrying after a partial failure never results in more than one durable note (server-enforced dedup, not client memory)', async () => {
    let assignShouldFail = true;
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({
      caseStatus: 'New',
      enforceNoteIdempotency: true,
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

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('ambiguous note-response failure (server commits, client sees the response as lost) never produces a duplicate note on retry', async () => {
    // The FIRST /notes call commits server-side (lands in
    // notesByExceptionAndKey) but the client is told the request failed —
    // simulating a dropped/timed-out response after a successful commit.
    // The only client recourse is to retry; with server-enforced
    // idempotency that retry must be a safe no-op.
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({ caseStatus: 'New', enforceNoteIdempotency: true });
    let ambiguousFailureDelivered = false;
    const realImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/cases/exc-1/notes' && method === 'POST' && !ambiguousFailureDelivered) {
        ambiguousFailureDelivered = true;
        // Let the real handler run (so the note is durably recorded)...
        void realImpl(url, init);
        // ...but report a network-level failure to the caller regardless.
        return jsonResponse({ error: 'simulated failure' }, 500);
      }
      return realImpl(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Moved to Recovering/i })).toBeInTheDocument();
    });

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('remounting the panel (simulating a reload) after a mutation failure and retrying does not duplicate the note', async () => {
    let assignShouldFail = true;
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({
      caseStatus: 'New',
      enforceNoteIdempotency: true,
      failOn: (path, method) => assignShouldFail && path === '/api/cases/exc-1/assign' && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const { unmount } = render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    // Simulate a reload: destroy the component entirely (all client-local
    // state is gone) and mount a fresh instance for the same exception.
    unmount();
    assignShouldFail = false;
    render(<RecoveryPlaybookPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /Apply: move case to Recovering/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Moved to Recovering/i })).toBeInTheDocument();
    });

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('resets apply state when the selected exception changes', async () => {
    const { fetchMock } = makeTrackedFetch({ caseStatus: 'New', enforceNoteIdempotency: true });
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
