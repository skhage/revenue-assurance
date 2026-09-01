// Case-management routes backed by Lakebase (Postgres).
//
// The read side (the exception register, KPIs, scorecard) lives in Delta and is
// served by the analytics plugin. Mutable *case* state — who owns an exception,
// where it is in the recovery lifecycle, and the investigation notes — lives here
// in Lakebase, keyed by the synthesized exception_id from exceptions_list.sql.
//
// Cases are created lazily: an exception has no Postgres row until an analyst
// first acts on it, at which point the client sends the exception's metadata
// (from the queue row) so we can persist a self-contained case.

import { z } from 'zod';
import type { Application, Request } from 'express';

interface AppKitWithLakebase {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

// ---------------------------------------------------------------------------
// Case lifecycle — mirrors demo-artifacts/07-ui-specs.md §5
// ---------------------------------------------------------------------------
const STATUSES = ['New', 'Investigating', 'Recovering', 'Recovered', 'WrittenOff'] as const;
type Status = (typeof STATUSES)[number];

const TRANSITIONS: Record<Status, Status[]> = {
  New: ['Investigating', 'WrittenOff'],
  Investigating: ['Recovering', 'WrittenOff'],
  Recovering: ['Recovered', 'WrittenOff'],
  Recovered: [],
  WrittenOff: [],
};

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------
const CREATE_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ra`;

const CREATE_CASES_SQL = `
  CREATE TABLE IF NOT EXISTS ra.cases (
    exception_id    TEXT PRIMARY KEY,
    reference_id    TEXT,
    account_name    TEXT,
    check_type      TEXT,
    severity        TEXT,
    amount_at_risk  DOUBLE PRECISION,
    status          TEXT NOT NULL DEFAULT 'New',
    assignee        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const CREATE_NOTES_SQL = `
  CREATE TABLE IF NOT EXISTS ra.case_notes (
    id            SERIAL PRIMARY KEY,
    exception_id  TEXT NOT NULL REFERENCES ra.cases(exception_id) ON DELETE CASCADE,
    author        TEXT,
    body          TEXT NOT NULL,
    idempotency_key TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

// Idempotent for tables created before idempotency_key existed.
const ADD_IDEMPOTENCY_KEY_COLUMN_SQL = `
  ALTER TABLE ra.case_notes ADD COLUMN IF NOT EXISTS idempotency_key TEXT
`;

// A caller-supplied key (e.g. "<agent>:<exception_id>") makes note creation
// durably idempotent: the same key can never insert twice for the same
// exception, no matter how many times the request is retried — across a
// lost response, a component remount, or a full page reload. NULL keys
// (manual, human-authored notes) are exempt via the partial index, since
// two identical manual notes are not a bug.
const CREATE_NOTES_IDEMPOTENCY_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS case_notes_idempotency_key_uidx
    ON ra.case_notes (exception_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
`;

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------
const ExceptionMeta = z.object({
  reference_id: z.string().nullish(),
  account_name: z.string().nullish(),
  check_type: z.string().nullish(),
  severity: z.string().nullish(),
  amount_at_risk: z.number().nullish(),
});

const AssignBody = z.object({
  assignee: z.string().min(1),
  meta: ExceptionMeta.optional(),
});

const StatusBody = z.object({
  status: z.enum(STATUSES),
  note: z.string().optional(),
  meta: ExceptionMeta.optional(),
});

const NoteBody = z.object({
  body: z.string().min(1),
  meta: ExceptionMeta.optional(),
  // Caller-supplied idempotency key (e.g. "agent:exception_investigation" or
  // "agent:smart_prioritization"). When present, the server guarantees at
  // most one note with this key is ever inserted for this exception_id — a
  // retried request (lost response, component remount, page reload) can
  // safely resend the same key and will never create a duplicate. Absent
  // for manual, human-authored notes, which are intentionally not deduped.
  idempotencyKey: z.string().min(1).optional(),
});

function currentUser(req: Request): string {
  const email = req.header('x-forwarded-email') || req.header('x-forwarded-user');
  return email && email.trim().length > 0 ? email : 'analyst@demo';
}

export async function setupCaseRoutes(appkit: AppKitWithLakebase) {
  try {
    await appkit.lakebase.query(CREATE_SCHEMA_SQL);
    await appkit.lakebase.query(CREATE_CASES_SQL);
    await appkit.lakebase.query(CREATE_NOTES_SQL);
    await appkit.lakebase.query(ADD_IDEMPOTENCY_KEY_COLUMN_SQL);
    await appkit.lakebase.query(CREATE_NOTES_IDEMPOTENCY_INDEX_SQL);
    console.log('[cases] schema ra ready (ra.cases, ra.case_notes)');
  } catch (err) {
    console.warn('[cases] schema setup failed:', (err as Error).message);
    console.warn('[cases] routes registered but may error until the app is deployed (SP owns schema ra)');
  }

  // Ensure a case row exists; create it from client-supplied exception metadata.
  async function ensureCase(exceptionId: string, meta?: z.infer<typeof ExceptionMeta>) {
    await appkit.lakebase.query(
      `INSERT INTO ra.cases (exception_id, reference_id, account_name, check_type, severity, amount_at_risk)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (exception_id) DO NOTHING`,
      [
        exceptionId,
        meta?.reference_id ?? null,
        meta?.account_name ?? null,
        meta?.check_type ?? null,
        meta?.severity ?? null,
        meta?.amount_at_risk ?? null,
      ]
    );
  }

  async function loadCase(exceptionId: string) {
    const { rows } = await appkit.lakebase.query(
      `SELECT exception_id, reference_id, account_name, check_type, severity, amount_at_risk,
              status, assignee, created_at, updated_at
       FROM ra.cases WHERE exception_id = $1`,
      [exceptionId]
    );
    return rows[0] ?? null;
  }

  async function loadNotes(exceptionId: string) {
    const { rows } = await appkit.lakebase.query(
      `SELECT id, author, body, created_at FROM ra.case_notes
       WHERE exception_id = $1 ORDER BY created_at DESC`,
      [exceptionId]
    );
    return rows;
  }

  appkit.server.extend((app) => {
    // Signed-in identity (real headers on Databricks Apps; fallback locally).
    app.get('/api/whoami', (req, res) => {
      res.json({ user: currentUser(req) });
    });

    // Case counts by lifecycle status — for the Overview "case progress" strip.
    app.get('/api/cases/stats', async (_req, res) => {
      try {
        const { rows } = await appkit.lakebase.query(`SELECT status, COUNT(*)::int AS n FROM ra.cases GROUP BY status`);
        const stats: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        for (const r of rows) stats[r.status as string] = r.n as number;
        res.json(stats);
      } catch (err) {
        console.error('[cases] stats failed:', err);
        res.status(500).json({ error: 'Failed to load case stats' });
      }
    });

    // Worked cases, newest first. ?mine=1 restricts to the signed-in analyst.
    app.get('/api/cases', async (req, res) => {
      try {
        const mine = req.query.mine === '1';
        const params: unknown[] = [];
        let where = '';
        if (mine) {
          where = 'WHERE assignee = $1';
          params.push(currentUser(req));
        }
        const { rows } = await appkit.lakebase.query(
          `SELECT exception_id, reference_id, account_name, check_type, severity, amount_at_risk,
                  status, assignee, updated_at
           FROM ra.cases ${where}
           ORDER BY updated_at DESC
           LIMIT 200`,
          params
        );
        res.json(rows);
      } catch (err) {
        console.error('[cases] list failed:', err);
        res.status(500).json({ error: 'Failed to load cases' });
      }
    });

    // One case + its notes. Returns { case: null } if never worked.
    app.get('/api/cases/:exceptionId', async (req, res) => {
      try {
        const row = await loadCase(req.params.exceptionId);
        if (!row) {
          res.json({ case: null, notes: [] });
          return;
        }
        res.json({ case: row, notes: await loadNotes(req.params.exceptionId) });
      } catch (err) {
        console.error('[cases] get failed:', err);
        res.status(500).json({ error: 'Failed to load case' });
      }
    });

    // Assign the exception to the signed-in analyst (or a named assignee).
    app.post('/api/cases/:exceptionId/assign', async (req, res) => {
      try {
        const parsed = AssignBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'assignee is required' });
          return;
        }
        const { exceptionId } = req.params;
        await ensureCase(exceptionId, parsed.data.meta);
        await appkit.lakebase.query(`UPDATE ra.cases SET assignee = $2, updated_at = NOW() WHERE exception_id = $1`, [
          exceptionId,
          parsed.data.assignee,
        ]);
        res.json({ case: await loadCase(exceptionId), notes: await loadNotes(exceptionId) });
      } catch (err) {
        console.error('[cases] assign failed:', err);
        res.status(500).json({ error: 'Failed to assign case' });
      }
    });

    // Change lifecycle status, guarded by the allowed-transition table.
    app.post('/api/cases/:exceptionId/status', async (req, res) => {
      try {
        const parsed = StatusBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'valid status is required' });
          return;
        }
        const { exceptionId } = req.params;
        const { status: next, note, meta } = parsed.data;

        await ensureCase(exceptionId, meta);
        const existing = await loadCase(exceptionId);
        const from = (existing?.status as Status) ?? 'New';

        if (from !== next && !TRANSITIONS[from].includes(next)) {
          res.status(409).json({
            error: `Cannot move a case from ${from} to ${next}.`,
            allowed: TRANSITIONS[from],
          });
          return;
        }
        if (next === 'Investigating' && !existing?.assignee) {
          res.status(409).json({ error: 'Assign the case before investigating.' });
          return;
        }
        if (next === 'WrittenOff' && !note?.trim()) {
          res.status(409).json({ error: 'Add a reason before writing off.' });
          return;
        }

        await appkit.lakebase.query(`UPDATE ra.cases SET status = $2, updated_at = NOW() WHERE exception_id = $1`, [
          exceptionId,
          next,
        ]);
        if (note?.trim()) {
          await appkit.lakebase.query(`INSERT INTO ra.case_notes (exception_id, author, body) VALUES ($1, $2, $3)`, [
            exceptionId,
            currentUser(req),
            note.trim(),
          ]);
        }
        res.json({ case: await loadCase(exceptionId), notes: await loadNotes(exceptionId) });
      } catch (err) {
        console.error('[cases] status failed:', err);
        res.status(500).json({ error: 'Failed to change status' });
      }
    });

    // Append an investigation note. When idempotencyKey is supplied, the
    // insert is a no-op if a note with that (exception_id, idempotencyKey)
    // pair already exists AND carries the same body — safe to retry after a
    // lost response, a component remount, or a page reload without ever
    // double-writing. If the key already exists with a DIFFERENT body, this
    // is a genuine collision (e.g. a stale/reused key from an unrelated run)
    // rather than a retry, and is rejected outright — silently treating it
    // as "the same note" would associate the wrong output with that key and
    // corrupt the audit trail. Rejecting here also blocks any mutation the
    // caller intended to make dependent on this note, preserving
    // audit-before-mutation ordering.
    app.post('/api/cases/:exceptionId/notes', async (req, res) => {
      try {
        const parsed = NoteBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'note body is required' });
          return;
        }
        const { exceptionId } = req.params;
        const { idempotencyKey } = parsed.data;
        const trimmedBody = parsed.data.body.trim();
        await ensureCase(exceptionId, parsed.data.meta);

        const { rows: insertResult } = await appkit.lakebase.query(
          idempotencyKey
            ? `INSERT INTO ra.case_notes (exception_id, author, body, idempotency_key) VALUES ($1, $2, $3, $4)
               ON CONFLICT (exception_id, idempotency_key) WHERE idempotency_key IS NOT NULL
               DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
               WHERE ra.case_notes.body = EXCLUDED.body
               RETURNING id, (xmax = 0) AS inserted`
            : `INSERT INTO ra.case_notes (exception_id, author, body) VALUES ($1, $2, $3) RETURNING id`,
          idempotencyKey
            ? [exceptionId, currentUser(req), trimmedBody, idempotencyKey]
            : [exceptionId, currentUser(req), trimmedBody]
        );

        // The conditional ON CONFLICT update is one atomic database decision:
        // an exact retry locks the existing row and returns it, while a
        // different body fails the WHERE clause and returns no row. Unlike a
        // SELECT followed by INSERT, two simultaneous mismatched requests
        // cannot both observe "missing" and pass.
        if (idempotencyKey && insertResult.length === 0) {
          res.status(409).json({
            error: 'This idempotency key was already used with a different note body.',
          });
          return;
        }

        const inserted = idempotencyKey ? insertResult[0]?.inserted === true : insertResult.length > 0;
        // Only bump updated_at when a note was actually inserted — a
        // deduped retry should be a true no-op, not a fresh "touch".
        if (inserted) {
          await appkit.lakebase.query(`UPDATE ra.cases SET updated_at = NOW() WHERE exception_id = $1`, [exceptionId]);
        }
        res.json({
          case: await loadCase(exceptionId),
          notes: await loadNotes(exceptionId),
          deduped: !inserted,
        });
      } catch (err) {
        console.error('[cases] note failed:', err);
        res.status(500).json({ error: 'Failed to add note' });
      }
    });
  });
}
