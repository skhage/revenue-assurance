// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvestigationPanel } from './InvestigationPanel';
import type { ExceptionDetailRow } from '../../lib/agents/hypothesis';
import type { PipelineHealth } from '../../lib/agents/types';
import type { ExceptionRow } from '../../lib/types';

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

function detail(overrides: Partial<ExceptionDetailRow> = {}): ExceptionDetailRow {
  return {
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
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function sseResponse(data: unknown) {
  return Promise.resolve(
    new Response(`data: ${JSON.stringify({ type: 'result', data: [data] })}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  );
}

interface NoteRequest {
  body: string;
  idempotencyKey?: string;
}

interface TrackedFetchOptions {
  getDetail: () => ExceptionDetailRow;
  loseFirstNoteResponse?: boolean;
}

function makeTrackedFetch(options: TrackedFetchOptions) {
  const noteCalls: NoteRequest[] = [];
  const durableNotes = new Map<string, string>();
  let loseNextNoteResponse = options.loseFirstNoteResponse ?? false;

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/analytics/query/exception_detail')) return sseResponse(options.getDetail());
    if (url.startsWith('/api/analytics/exceptions')) return jsonResponse([EXCEPTION]);

    if (url === '/api/cases/exc-1/notes' && method === 'POST') {
      const request = JSON.parse(init?.body as string) as NoteRequest;
      noteCalls.push(request);
      if (!request.idempotencyKey) return jsonResponse({ error: 'missing idempotency key' }, 400);

      const existingBody = durableNotes.get(request.idempotencyKey);
      if (existingBody !== undefined && existingBody !== request.body) {
        return jsonResponse({ error: 'This idempotency key was already used with a different note body.' }, 409);
      }
      durableNotes.set(request.idempotencyKey, request.body);

      if (loseNextNoteResponse) {
        loseNextNoteResponse = false;
        return Promise.reject(new Error('response lost after commit'));
      }
      return jsonResponse({ case: null, notes: [], deduped: existingBody !== undefined });
    }

    return jsonResponse({});
  });

  return { fetchMock, noteCalls, durableNotes };
}

function renderPanel() {
  return render(<InvestigationPanel health={OK_HEALTH} selected={EXCEPTION} onSelect={() => {}} />);
}

async function applyInvestigationNote(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Add hypothesis as investigation note/i }));
}

describe('InvestigationPanel approved-run note application', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('writes a successful investigation note with a per-approved-run idempotency key and retires it', async () => {
    const currentDetail = detail();
    const { fetchMock, noteCalls, durableNotes } = makeTrackedFetch({ getDetail: () => currentDetail });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderPanel();
    await applyInvestigationNote(user);

    await screen.findByRole('button', { name: 'Added to case notes' });
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].idempotencyKey).toMatch(/^agent:exception-investigation:exc-1:[0-9a-f-]{36}$/);
    expect(noteCalls[0].body).toContain('[Agent: Exception Investigation]');
    expect(durableNotes.size).toBe(1);
    expect(localStorage.getItem('ra:pending-agent-run:exception-investigation:exc-1')).toBeNull();
  });

  it('reuses the same key after a lost response so retry creates only one durable note', async () => {
    const currentDetail = detail();
    const { fetchMock, noteCalls, durableNotes } = makeTrackedFetch({
      getDetail: () => currentDetail,
      loseFirstNoteResponse: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderPanel();
    await applyInvestigationNote(user);
    await user.click(await screen.findByRole('button', { name: /Retry/i }));

    await screen.findByRole('button', { name: 'Added to case notes' });
    expect(noteCalls).toHaveLength(2);
    expect(noteCalls[1]).toEqual(noteCalls[0]);
    expect(durableNotes.size).toBe(1);
  });

  it('survives a full panel remount and resumes the same pending approved run', async () => {
    const currentDetail = detail();
    const { fetchMock, noteCalls, durableNotes } = makeTrackedFetch({
      getDetail: () => currentDetail,
      loseFirstNoteResponse: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const firstRender = renderPanel();
    await applyInvestigationNote(user);
    await screen.findByText('response lost after commit');
    const firstKey = noteCalls[0].idempotencyKey;

    firstRender.unmount();
    renderPanel();
    await applyInvestigationNote(user);

    await screen.findByRole('button', { name: 'Added to case notes' });
    expect(noteCalls).toHaveLength(2);
    expect(noteCalls[1].idempotencyKey).toBe(firstKey);
    expect(noteCalls[1].body).toBe(noteCalls[0].body);
    expect(durableNotes.size).toBe(1);
  });

  it('mints a fresh key for a later independent approval after success', async () => {
    const currentDetail = detail();
    const { fetchMock, noteCalls, durableNotes } = makeTrackedFetch({ getDetail: () => currentDetail });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const firstRender = renderPanel();
    await applyInvestigationNote(user);
    await screen.findByRole('button', { name: 'Added to case notes' });

    firstRender.unmount();
    renderPanel();
    await applyInvestigationNote(user);

    await screen.findByRole('button', { name: 'Added to case notes' });
    await waitFor(() => expect(noteCalls).toHaveLength(2));
    expect(noteCalls[1].idempotencyKey).not.toBe(noteCalls[0].idempotencyKey);
    expect(durableNotes.size).toBe(2);
  });

  it('replaces a pending run when the approved hypothesis payload changes instead of wedging on a mismatch', async () => {
    let currentDetail = detail({ price_accuracy_score: 55 });
    const { fetchMock, noteCalls, durableNotes } = makeTrackedFetch({
      getDetail: () => currentDetail,
      loseFirstNoteResponse: true,
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const firstRender = renderPanel();
    await applyInvestigationNote(user);
    await screen.findByText('response lost after commit');

    currentDetail = detail({ price_accuracy_score: 12 });
    firstRender.unmount();
    renderPanel();
    await applyInvestigationNote(user);

    await screen.findByRole('button', { name: 'Added to case notes' });
    expect(noteCalls).toHaveLength(2);
    expect(noteCalls[1].idempotencyKey).not.toBe(noteCalls[0].idempotencyKey);
    expect(noteCalls[0].body).toContain('price_accuracy_score=55');
    expect(noteCalls[1].body).toContain('price_accuracy_score=12');
    expect(durableNotes.size).toBe(2);
  });
});
