// Exercises the /api/cases/:exceptionId/notes route directly against a
// fake Lakebase connection that faithfully reproduces the one behavior this
// route depends on for durable idempotency: a unique constraint violation
// on (exception_id, idempotency_key) is swallowed by `ON CONFLICT ... DO
// NOTHING`, so a repeated insert with the same key returns zero rows
// instead of throwing or inserting twice. This is what makes note creation
// safe to retry after a lost response, a client remount, or a full reload
// — the guarantee lives in the database, not in any client-side flag.
import { describe, it, expect } from 'vitest';
import express, { type Application } from 'express';
import { setupCaseRoutes } from './cases';

interface FakeReq {
  params: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
  header: (name: string) => string | undefined;
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(body: unknown): void;
}

function fakeReq(params: Record<string, string>, body: unknown = {}): FakeReq {
  return { params, body, query: {}, header: () => undefined };
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

interface CaseRow {
  [key: string]: unknown;
  exception_id: string;
  reference_id: string | null;
  account_name: string | null;
  check_type: string | null;
  severity: string | null;
  amount_at_risk: number | null;
  status: string;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

interface NoteRow {
  [key: string]: unknown;
  id: number;
  exception_id: string;
  author: string | null;
  body: string;
  idempotency_key: string | null;
  created_at: string;
}

/**
 * An in-memory stand-in for Lakebase Postgres, faithful only to the SQL
 * shapes `server/routes/cases.ts` actually issues — enough to test the
 * route's control flow (including the ON CONFLICT dedup path) without a
 * real database.
 */
function createFakeLakebase() {
  const cases = new Map<string, CaseRow>();
  const notes: NoteRow[] = [];
  let nextNoteId = 1;

  // No real I/O happens in queryInternal, so it stays synchronous; `query`
  // (below) wraps its result in a resolved promise to satisfy the async
  // `AppKitWithLakebase.lakebase.query` interface without an `async`
  // function that never actually awaits anything.
  function queryInternal(text: string, params: unknown[] = []): { rows: Record<string, unknown>[] } {
    // Multi-line template-string SQL is normalized to single-line before
    // matching — the real queries in cases.ts wrap across lines, and a
    // literal `.` in a regex doesn't match `\n` by default.
    const sql = text.replace(/\s+/g, ' ').trim();

    if (
      /^CREATE SCHEMA/i.test(sql) ||
      /^CREATE TABLE/i.test(sql) ||
      /^ALTER TABLE/i.test(sql) ||
      /^CREATE UNIQUE INDEX/i.test(sql)
    ) {
      return { rows: [] };
    }

    if (/^INSERT INTO ra\.cases/i.test(sql)) {
      const [exceptionId, referenceId, accountName, checkType, severity, amountAtRisk] = params as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
      ];
      if (!cases.has(exceptionId)) {
        const now = new Date().toISOString();
        cases.set(exceptionId, {
          exception_id: exceptionId,
          reference_id: referenceId,
          account_name: accountName,
          check_type: checkType,
          severity,
          amount_at_risk: amountAtRisk,
          status: 'New',
          assignee: null,
          created_at: now,
          updated_at: now,
        });
      }
      return { rows: [] };
    }

    if (/^SELECT .* FROM ra\.cases WHERE exception_id = \$1$/i.test(sql)) {
      const [exceptionId] = params as [string];
      const row = cases.get(exceptionId);
      return { rows: row ? [row] : [] };
    }

    if (/^UPDATE ra\.cases SET assignee/i.test(sql)) {
      const [exceptionId, assignee] = params as [string, string];
      const row = cases.get(exceptionId);
      if (row) {
        row.assignee = assignee;
        row.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }

    if (/^UPDATE ra\.cases SET status/i.test(sql)) {
      const [exceptionId, status] = params as [string, string];
      const row = cases.get(exceptionId);
      if (row) {
        row.status = status;
        row.updated_at = new Date().toISOString();
      }
      return { rows: [] };
    }

    if (/^UPDATE ra\.cases SET updated_at/i.test(sql)) {
      const [exceptionId] = params as [string];
      const row = cases.get(exceptionId);
      if (row) row.updated_at = new Date().toISOString();
      return { rows: [] };
    }

    if (/^INSERT INTO ra\.case_notes \(exception_id, author, body, idempotency_key\)/i.test(sql)) {
      const [exceptionId, author, body, idempotencyKey] = params as [string, string | null, string, string];
      const conflict = notes.some((n) => n.exception_id === exceptionId && n.idempotency_key === idempotencyKey);
      if (conflict) {
        return { rows: [] }; // ON CONFLICT ... DO NOTHING — the real unique-index behavior.
      }
      const row: NoteRow = {
        id: nextNoteId++,
        exception_id: exceptionId,
        author,
        body,
        idempotency_key: idempotencyKey,
        created_at: new Date().toISOString(),
      };
      notes.push(row);
      return { rows: [{ id: row.id }] };
    }

    if (/^INSERT INTO ra\.case_notes \(exception_id, author, body\) VALUES/i.test(sql)) {
      const [exceptionId, author, body] = params as [string, string | null, string];
      const row: NoteRow = {
        id: nextNoteId++,
        exception_id: exceptionId,
        author,
        body,
        idempotency_key: null,
        created_at: new Date().toISOString(),
      };
      notes.push(row);
      return { rows: [{ id: row.id }] };
    }

    if (/^SELECT id, author, body, created_at FROM ra\.case_notes/i.test(sql)) {
      const [exceptionId] = params as [string];
      return { rows: notes.filter((n) => n.exception_id === exceptionId) };
    }

    if (/^SELECT body FROM ra\.case_notes WHERE exception_id = \$1 AND idempotency_key = \$2/i.test(sql)) {
      const [exceptionId, idempotencyKey] = params as [string, string];
      const match = notes.find((n) => n.exception_id === exceptionId && n.idempotency_key === idempotencyKey);
      return { rows: match ? [{ body: match.body }] : [] };
    }

    throw new Error(`createFakeLakebase: unhandled query: ${sql}`);
  }

  function query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    return Promise.resolve(queryInternal(text, params));
  }

  return { query, cases, notes: () => notes };
}

interface RouteHandler {
  (req: FakeReq, res: FakeRes): void | Promise<void>;
}

async function setupCaseRoutesWithFakeApp() {
  const routes = new Map<string, RouteHandler>();
  const lakebase = createFakeLakebase();
  const fakeApp = express();
  Object.defineProperties(fakeApp, {
    get: {
      value(path: string, handler: RouteHandler) {
        routes.set(`GET ${path}`, handler);
      },
    },
    post: {
      value(path: string, handler: RouteHandler) {
        routes.set(`POST ${path}`, handler);
      },
    },
  });
  // `setupCaseRoutes` only ever calls `app.get`/`app.post` with two
  // arguments and never touches any other Express `Application` member, so
  // this minimal fake is behaviorally complete for what's under test; the
  // cast is a deliberate, narrow escape from the full `Application` shape
  // rather than an attempt to reimplement it.
  await setupCaseRoutes({
    lakebase,
    server: {
      extend(fn: (app: Application) => void) {
        fn(fakeApp);
      },
    },
  });
  return { routes, lakebase };
}

async function callNotesRoute(routes: Map<string, RouteHandler>, exceptionId: string, body: unknown) {
  const handler = routes.get('POST /api/cases/:exceptionId/notes')!;
  const req = fakeReq({ exceptionId }, body);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('POST /api/cases/:exceptionId/notes — server-enforced idempotency', () => {
  it('inserts a note when no idempotencyKey is supplied (manual notes are never deduped)', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    const res1 = await callNotesRoute(routes, 'exc-1', { body: 'manual note' });
    const res2 = await callNotesRoute(routes, 'exc-1', { body: 'manual note' });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(lakebase.notes().filter((n) => n.exception_id === 'exc-1')).toHaveLength(2);
  });

  it('inserts exactly one note across two identical calls with the same idempotencyKey', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    const body = { body: 'note text', idempotencyKey: 'agent:recovery-playbook:exc-1' };
    const res1 = await callNotesRoute(routes, 'exc-1', body);
    const res2 = await callNotesRoute(routes, 'exc-1', body);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect((res1.body as { deduped?: boolean }).deduped).toBe(false);
    expect((res2.body as { deduped?: boolean }).deduped).toBe(true);
    expect(
      lakebase.notes().filter((n) => n.exception_id === 'exc-1' && n.idempotency_key === body.idempotencyKey)
    ).toHaveLength(1);
  });

  it('a retried call after an ambiguous failure (server already committed) still returns the durable note set with no duplicate', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    const key = 'agent:smart-prioritization:exc-1';
    await callNotesRoute(routes, 'exc-1', { body: 'first attempt', idempotencyKey: key });
    // Simulate the client never having seen the first response and retrying
    // with the identical key and body — exactly what a real retry sends.
    const retryRes = await callNotesRoute(routes, 'exc-1', { body: 'first attempt', idempotencyKey: key });

    expect((retryRes.body as { deduped?: boolean }).deduped).toBe(true);
    expect(lakebase.notes().filter((n) => n.exception_id === 'exc-1')).toHaveLength(1);
  });

  it('different idempotencyKeys for the same exception both insert (different agents/runs are independent)', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    await callNotesRoute(routes, 'exc-1', {
      body: 'investigation note',
      idempotencyKey: 'agent:exception-investigation:exc-1',
    });
    await callNotesRoute(routes, 'exc-1', { body: 'recovery note', idempotencyKey: 'agent:recovery-playbook:exc-1' });

    expect(lakebase.notes().filter((n) => n.exception_id === 'exc-1')).toHaveLength(2);
  });

  it('the same idempotencyKey for different exceptions does not collide', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    const key = 'agent:recovery-playbook:shared-suffix';
    await callNotesRoute(routes, 'exc-1', { body: 'note for exc-1', idempotencyKey: key });
    await callNotesRoute(routes, 'exc-2', { body: 'note for exc-2', idempotencyKey: key });

    expect(lakebase.notes().filter((n) => n.idempotency_key === key)).toHaveLength(2);
  });

  it('rejects a request with no body', async () => {
    const { routes } = await setupCaseRoutesWithFakeApp();
    const res = await callNotesRoute(routes, 'exc-1', {});
    expect(res.statusCode).toBe(400);
  });

  it('rejects reuse of an idempotency key with a different note body, rather than silently treating it as the same note', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    const key = 'agent:recovery-playbook:exc-1:11111111-1111-1111-1111-111111111111';
    const first = await callNotesRoute(routes, 'exc-1', { body: 'first output', idempotencyKey: key });
    expect(first.statusCode).toBe(200);

    // Same key, but the body has changed — e.g. a stale/reused key from an
    // unrelated run, not a retry of the same approved action.
    const second = await callNotesRoute(routes, 'exc-1', { body: 'a totally different output', idempotencyKey: key });

    expect(second.statusCode).toBe(409);
    // The original note is untouched — no corruption, no second insert.
    expect(lakebase.notes().filter((n) => n.exception_id === 'exc-1' && n.idempotency_key === key)).toHaveLength(1);
    expect(lakebase.notes().find((n) => n.idempotency_key === key)?.body).toBe('first output');
  });

  it('an exact retry (same key, same body) still dedupes as a safe no-op after the payload-mismatch check', async () => {
    const { routes, lakebase } = await setupCaseRoutesWithFakeApp();
    const key = 'agent:smart-prioritization:exc-1:22222222-2222-2222-2222-222222222222';
    const body = { body: 'identical output', idempotencyKey: key };
    const first = await callNotesRoute(routes, 'exc-1', body);
    const retry = await callNotesRoute(routes, 'exc-1', body);

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect((retry.body as { deduped?: boolean }).deduped).toBe(true);
    expect(lakebase.notes().filter((n) => n.exception_id === 'exc-1' && n.idempotency_key === key)).toHaveLength(1);
  });
});
