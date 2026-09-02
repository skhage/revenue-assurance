// @vitest-environment jsdom
//
// Exercises PrioritizationPanel's failure-atomic mutation ordering (audit
// note before assignment, durable server-enforced dedup of the audit note
// across retries/remounts) and the shared-selection wiring (carrying a
// ranked row forward highlights it and calls onSelect with the underlying
// exception; a selected exception absent from the batch, or ranked outside
// the visible top N, is still shown and actionable).
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

/** An exception scored low enough to fall outside the default top-20 view. */
const LOW_RANK_EXCEPTION: ExceptionRow = {
  exception_id: 'exc-low',
  reference_id: 'REF-LOW',
  account_name: 'Tiny Telco',
  check_type: 'unauthorized_discount',
  severity: 'LOW',
  amount_at_risk: 1,
  detection_method: 'ai_extracted',
  source_table: 'salesforce_source.sbqq__quoteline__c',
  customer_id: 999,
  known_leakage_flag: false,
  status: 'New',
  assignee: null,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

interface TrackedFetchOptions {
  batch?: ExceptionRow[];
  /** Simulate the server-side unique-index dedup: a repeated (exceptionId, idempotencyKey) is a no-op. */
  enforceNoteIdempotency?: boolean;
  /** Force the HTTP layer to report failure for a given (path, method) — the client sees this as a network/response error even if a preceding call already reached the "real" handler logic below. */
  failOn?: (path: string, method: string) => boolean;
}

/**
 * Simulates the real server closely enough to test client retry behavior
 * against it: notes are deduped server-side by (exceptionId, idempotencyKey)
 * when `enforceNoteIdempotency` is set, exactly like the real Postgres
 * unique partial index. `notesByExceptionAndKey` lets tests assert on what
 * was actually durably persisted, independent of how many HTTP calls the
 * client made.
 */
interface RequestBody {
  idempotencyKey?: string;
}

function parseBody(raw: BodyInit | null | undefined): RequestBody | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw as string) as RequestBody;
}

function makeTrackedFetch(opts: TrackedFetchOptions = {}) {
  const calls: { method: string; path: string; body?: RequestBody }[] = [];
  const notesByExceptionAndKey = new Map<string, Set<string>>();
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = parseBody(init?.body);
    calls.push({ method, path: url, body });

    if (opts.failOn?.(url, method)) {
      return jsonResponse({ error: 'simulated failure' }, 500);
    }
    if (url.startsWith('/api/analytics/exceptions')) return jsonResponse(opts.batch ?? EXCEPTIONS);
    if (url === '/api/cases' || url === '/api/cases?mine=1') return jsonResponse([]);

    const noteMatch = url.match(/^\/api\/cases\/([^/]+)\/notes$/);
    if (noteMatch && method === 'POST') {
      const exceptionId = noteMatch[1];
      const idempotencyKey: string | undefined = body?.idempotencyKey;
      if (opts.enforceNoteIdempotency && idempotencyKey) {
        const existing = notesByExceptionAndKey.get(exceptionId) ?? new Set<string>();
        const deduped = existing.has(idempotencyKey);
        existing.add(idempotencyKey);
        notesByExceptionAndKey.set(exceptionId, existing);
        return jsonResponse({ case: null, notes: [], deduped });
      }
      return jsonResponse({ case: null, notes: [] });
    }
    if (url.match(/^\/api\/cases\/[^/]+\/assign$/) && method === 'POST') {
      return jsonResponse({ case: { status: 'New', assignee: 'someone@demo' }, notes: [] });
    }
    return jsonResponse({});
  });
  return { fetchMock, calls, notesByExceptionAndKey };
}

function distinctNoteInserts(notesByExceptionAndKey: Map<string, Set<string>>, exceptionId: string): number {
  return notesByExceptionAndKey.get(exceptionId)?.size ?? 0;
}

describe('PrioritizationPanel — failure-atomic mutation ordering', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('writes the audit note before the assignment mutation, with a stable idempotency key', async () => {
    const { fetchMock, calls } = makeTrackedFetch({ enforceNoteIdempotency: true });
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
    expect(calls[noteIndex].body?.idempotencyKey).toMatch(/^agent:smart-prioritization:exc-1:/);
  });

  it('never assigns if the audit note write fails', async () => {
    const { fetchMock, calls } = makeTrackedFetch({
      enforceNoteIdempotency: true,
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

  it('never assigns if the note write is rejected for an idempotency-key/payload mismatch (409)', async () => {
    // A stale/reused idempotency key colliding with a different body is
    // rejected outright by the server (409), not silently deduped — the
    // panel must not proceed to any assignment mutation in that case.
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/analytics/exceptions')) return jsonResponse(EXCEPTIONS);
      if (url === '/api/cases' || url === '/api/cases?mine=1') return jsonResponse([]);
      if (url.match(/^\/api\/cases\/[^/]+\/notes$/) && method === 'POST') {
        return jsonResponse({ error: 'This idempotency key was already used with a different note body.' }, 409);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const applyButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(applyButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/already used with a different note body/i)).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/assign'))).toBe(false);
  });

  it('retrying after a failed assignment never results in more than one durable note (server-enforced dedup, not client memory)', async () => {
    let assignShouldFail = true;
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({
      enforceNoteIdempotency: true,
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

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('ambiguous note-response failure (server commits, client sees the response as lost) never produces a duplicate note on retry', async () => {
    // The FIRST /notes call succeeds server-side (it lands in
    // notesByExceptionAndKey) but the client is told the response failed —
    // simulating a dropped/timed-out response after a successful commit.
    // The client's only recourse is to retry; with server-enforced
    // idempotency, that retry must be a safe no-op, not a duplicate.
    let firstNoteAttemptDone = false;
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({
      enforceNoteIdempotency: true,
      failOn: (path, method) => {
        if (path.endsWith('/notes') && method === 'POST' && !firstNoteAttemptDone) {
          firstNoteAttemptDone = true;
          return true; // client sees a failure even though we're about to let the "real" handler commit below
        }
        return false;
      },
    });
    // Patch the mock so the ambiguous first call still commits the note
    // server-side (via notesByExceptionAndKey) before reporting failure to
    // the client — this is the "response lost after commit" scenario.
    const originalImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const noteMatch = typeof url === 'string' ? url.match(/^\/api\/cases\/([^/]+)\/notes$/) : null;
      if (noteMatch && method === 'POST' && !notesByExceptionAndKey.has(noteMatch[1])) {
        const body = parseBody(init?.body);
        const key = body?.idempotencyKey;
        if (key) notesByExceptionAndKey.set(noteMatch[1], new Set([key]));
      }
      return originalImpl(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const applyButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(applyButtons[0]);
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    // Retry — the note "failure" was ambiguous (already committed server-side).
    const retryButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(retryButtons[0]);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Assigned/i }).length).toBeGreaterThan(0);
    });

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('remounting the panel (simulating a reload) after a mutation failure and retrying does not duplicate the note', async () => {
    let assignShouldFail = true;
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({
      enforceNoteIdempotency: true,
      failOn: (path, method) => assignShouldFail && path.endsWith('/assign') && method === 'POST',
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const { unmount } = render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const applyButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(applyButtons[0]);
    await waitFor(() => {
      expect(screen.getByText(/simulated failure/i)).toBeInTheDocument();
    });

    // Simulate a reload: destroy the component entirely (all client-local
    // state, including any in-memory "already noted" tracking, is gone)
    // and mount a fresh instance.
    unmount();
    assignShouldFail = false;
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);

    const freshButtons = await screen.findAllByRole('button', { name: /Apply: assign/i });
    await user.click(freshButtons[0]);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Assigned/i }).length).toBeGreaterThan(0);
    });

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(1);
  });

  it('a new approved run after a completed run creates a second distinct durable note', async () => {
    const { fetchMock, notesByExceptionAndKey } = makeTrackedFetch({ enforceNoteIdempotency: true });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const first = render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);
    await user.click((await screen.findAllByRole('button', { name: /Apply: assign/i }))[0]);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Assigned/i }).length).toBeGreaterThan(0);
    });

    first.unmount();
    render(<PrioritizationPanel health={OK_HEALTH} selected={null} onSelect={() => {}} />);
    await user.click((await screen.findAllByRole('button', { name: /Apply: assign/i }))[0]);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Assigned/i }).length).toBeGreaterThan(0);
    });

    expect(distinctNoteInserts(notesByExceptionAndKey, 'exc-1')).toBe(2);
  });
});

describe('PrioritizationPanel — shared selection', () => {
  afterEach(() => {
    localStorage.clear();
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

  it('a selected exception absent from the default batch is still shown, scored, and actionable', async () => {
    // The batch returned by the server does NOT include the exception the
    // user is investigating — e.g. it fell on a different page or doesn't
    // match the current sort. The panel must still surface it.
    const ABSENT: ExceptionRow = {
      exception_id: 'exc-absent',
      reference_id: 'REF-ABSENT',
      account_name: 'Ghost Corp',
      check_type: 'rev_rec_timing_mismatch',
      severity: 'HIGH',
      amount_at_risk: 75000,
      detection_method: 'rule_based',
      source_table: 'oracle_erp_source.revenue_recognition_schedule',
      customer_id: 42,
      known_leakage_flag: true,
      status: 'New',
      assignee: null,
    };
    const { fetchMock } = makeTrackedFetch({ batch: EXCEPTIONS }); // batch does not contain ABSENT
    vi.stubGlobal('fetch', fetchMock);

    render(<PrioritizationPanel health={OK_HEALTH} selected={ABSENT} onSelect={() => {}} />);

    const row = (await screen.findByText('Ghost Corp')).closest('tr');
    expect(row).toHaveAttribute('data-state', 'selected');
    expect(within(row!).getByRole('button', { name: /Apply: assign/i })).toBeEnabled();
  });

  it('a selected exception ranked outside the visible top 20 is still shown, labeled, and actionable', async () => {
    // 25 high-scoring exceptions push LOW_RANK_EXCEPTION well outside the
    // default top-20 view.
    const HIGH_SCORERS: ExceptionRow[] = Array.from({ length: 25 }, (_, i) => ({
      exception_id: `exc-high-${i}`,
      reference_id: `REF-HIGH-${i}`,
      account_name: `HighCo ${i}`,
      check_type: 'ar_collection_risk',
      severity: 'HIGH',
      amount_at_risk: 1_000_000 + i,
      detection_method: 'rule_based',
      source_table: 'oracle_erp_source.ar_payment_schedules_all',
      customer_id: 100 + i,
      known_leakage_flag: true,
      status: 'New',
      assignee: null,
    }));
    const { fetchMock } = makeTrackedFetch({ batch: [...HIGH_SCORERS, LOW_RANK_EXCEPTION] });
    vi.stubGlobal('fetch', fetchMock);

    render(<PrioritizationPanel health={OK_HEALTH} selected={LOW_RANK_EXCEPTION} onSelect={() => {}} />);

    const row = (await screen.findByText('Tiny Telco')).closest('tr');
    expect(row).toHaveAttribute('data-state', 'selected');
    expect(within(row!).getByRole('button', { name: /Apply: assign/i })).toBeEnabled();
    expect(screen.getByText(/outside top 20/i)).toBeInTheDocument();

    // The top-20 ordering itself is unaffected — 20 high scorers are still
    // shown ahead of the pinned selection, not displaced by it.
    const highScorerRows = screen.getAllByText(/^HighCo /);
    expect(highScorerRows.length).toBe(20);
  });
});
