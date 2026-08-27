import { z } from 'zod';
import type { Application, Request, Response } from 'express';
import {
  enqueueSnapshot,
  ensureWorkflowSchema,
  hasVersionConflict,
  STATUSES,
  TRANSITIONS,
  withTransaction,
  type LakebaseClient,
  type Status,
} from '../workflow';

interface AppKitWithLakebase {
  lakebase: LakebaseClient;
  server: { extend(fn: (app: Application) => void): void };
}

const ExceptionId = z.string().regex(/^[a-f0-9]{32}$/);
const ExceptionMeta = z.object({
  reference_id: z.string().max(500).nullish(),
  account_name: z.string().max(500).nullish(),
  check_type: z.string().max(200).nullish(),
  severity: z.string().max(50).nullish(),
  amount_at_risk: z.number().finite().nullish(),
});
const MutationBase = z.object({ expectedVersion: z.number().int().min(0), meta: ExceptionMeta.optional() });
const AssignBody = MutationBase.extend({ assignee: z.string().email().max(320) });
const StatusBody = MutationBase.extend({ status: z.enum(STATUSES), note: z.string().trim().max(10_000).optional() });
const NoteBody = MutationBase.extend({ body: z.string().trim().min(1).max(10_000) });

function currentUser(req: Request): string {
  const email = req.header('x-forwarded-email') || req.header('x-forwarded-user');
  return email && email.trim() ? email.trim() : 'analyst@demo';
}

async function loadPayload(
  client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  exceptionId: string
) {
  const { rows: cases } = await client.query(
    `SELECT exception_id, reference_id, account_name, check_type, severity, amount_at_risk,
            status, assignee, version, identity_status, created_at, updated_at
     FROM ra.cases WHERE exception_id = $1`,
    [exceptionId]
  );
  const { rows: notes } = await client.query(
    'SELECT id, author, body, created_at FROM ra.case_notes WHERE exception_id = $1 ORDER BY created_at DESC, id DESC',
    [exceptionId]
  );
  return { case: cases[0] ?? null, notes };
}

async function ensureCase(
  client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  exceptionId: string,
  meta?: z.infer<typeof ExceptionMeta>
) {
  await client.query(
    `INSERT INTO ra.cases (exception_id, reference_id, account_name, check_type, severity, amount_at_risk)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (exception_id) DO NOTHING`,
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

function conflict(res: Response, current: Record<string, unknown> | null | undefined) {
  res.status(409).json({
    error: 'This case changed in another tab or session. Refresh and retry your action.',
    code: 'VERSION_CONFLICT',
    currentVersion: Number(current?.version ?? 0),
    current,
  });
}

export async function setupCaseRoutes(appkit: AppKitWithLakebase, onMutation: () => Promise<void>) {
  await ensureWorkflowSchema(appkit.lakebase);
  appkit.server.extend((app) => {
    app.get('/api/whoami', (req, res) => res.json({ user: currentUser(req) }));
    app.get('/api/cases/stats', async (_req, res) => {
      try {
        const { rows } = await appkit.lakebase.query('SELECT status, COUNT(*)::int n FROM ra.cases GROUP BY status');
        const stats = Object.fromEntries(STATUSES.map((status) => [status, 0]));
        for (const row of rows) stats[String(row.status)] = Number(row.n);
        res.json(stats);
      } catch (error) {
        console.error('[cases] stats failed:', error);
        res.status(500).json({ error: 'Failed to load case stats' });
      }
    });
    app.get('/api/cases', async (req, res) => {
      try {
        const mine = req.query.mine === '1';
        const { rows } = await appkit.lakebase.query(
          `SELECT exception_id, reference_id, account_name, check_type, severity, amount_at_risk, status, assignee, version, identity_status, updated_at
           FROM ra.cases ${mine ? 'WHERE assignee = $1' : ''} ORDER BY updated_at DESC LIMIT 200`,
          mine ? [currentUser(req)] : []
        );
        res.json(rows);
      } catch (error) {
        console.error('[cases] list failed:', error);
        res.status(500).json({ error: 'Failed to load cases' });
      }
    });
    app.get('/api/cases/:exceptionId', async (req, res) => {
      if (!ExceptionId.safeParse(req.params.exceptionId).success)
        return void res.status(400).json({ error: 'Invalid exception id' });
      try {
        res.json(await loadPayload(appkit.lakebase, req.params.exceptionId));
      } catch (error) {
        console.error('[cases] get failed:', error);
        res.status(500).json({ error: 'Failed to load case' });
      }
    });

    app.post('/api/cases/:exceptionId/assign', async (req, res) => {
      const id = ExceptionId.safeParse(req.params.exceptionId);
      const body = AssignBody.safeParse(req.body);
      if (!id.success || !body.success)
        return void res.status(400).json({ error: 'Valid exception id, assignee, and expectedVersion are required' });
      if (body.data.assignee !== currentUser(req))
        return void res.status(403).json({ error: 'You may only assign a case to your signed-in identity' });
      try {
        const result = await withTransaction(appkit.lakebase, async (client) => {
          await ensureCase(client, id.data, body.data.meta);
          const updated = await client.query(
            'UPDATE ra.cases SET assignee=$2, version=version+1, updated_at=NOW() WHERE exception_id=$1 AND version=$3 RETURNING *',
            [id.data, body.data.assignee, body.data.expectedVersion]
          );
          if (!updated.rows[0]) return { conflict: (await loadPayload(client, id.data)).case };
          await enqueueSnapshot(client, id.data);
          return { payload: await loadPayload(client, id.data) };
        });
        if ('conflict' in result) return void conflict(res, result.conflict);
        res.json(result.payload);
        void onMutation();
      } catch (error) {
        console.error('[cases] assign failed:', error);
        res.status(500).json({ error: 'Failed to assign case' });
      }
    });

    app.post('/api/cases/:exceptionId/status', async (req, res) => {
      const id = ExceptionId.safeParse(req.params.exceptionId);
      const body = StatusBody.safeParse(req.body);
      if (!id.success || !body.success)
        return void res.status(400).json({ error: 'Valid status and expectedVersion are required' });
      try {
        const result = await withTransaction(appkit.lakebase, async (client) => {
          await ensureCase(client, id.data, body.data.meta);
          const current = (await loadPayload(client, id.data)).case;
          if (!current) throw new Error('Case creation failed');
          if (hasVersionConflict(body.data.expectedVersion, current.version)) return { conflict: current };
          const from = String(current.status) as Status;
          if (from !== body.data.status && !TRANSITIONS[from].includes(body.data.status))
            return { validation: `Cannot move a case from ${from} to ${body.data.status}.` };
          if (body.data.status === 'Investigating' && !current.assignee)
            return { validation: 'Assign the case before investigating.' };
          if (body.data.status === 'WrittenOff' && !body.data.note)
            return { validation: 'Add a reason before writing off.' };
          const updated = await client.query(
            'UPDATE ra.cases SET status=$2, version=version+1, updated_at=NOW() WHERE exception_id=$1 AND version=$3 RETURNING *',
            [id.data, body.data.status, body.data.expectedVersion]
          );
          if (!updated.rows[0]) return { conflict: (await loadPayload(client, id.data)).case };
          if (body.data.note)
            await client.query('INSERT INTO ra.case_notes(exception_id,author,body) VALUES($1,$2,$3)', [
              id.data,
              currentUser(req),
              body.data.note,
            ]);
          await enqueueSnapshot(client, id.data);
          return { payload: await loadPayload(client, id.data) };
        });
        if ('conflict' in result) return void conflict(res, result.conflict);
        if ('validation' in result)
          return void res.status(409).json({ error: result.validation, code: 'INVALID_TRANSITION' });
        res.json(result.payload);
        void onMutation();
      } catch (error) {
        console.error('[cases] status failed:', error);
        res.status(500).json({ error: 'Failed to change status; no changes were committed' });
      }
    });

    app.post('/api/cases/:exceptionId/notes', async (req, res) => {
      const id = ExceptionId.safeParse(req.params.exceptionId);
      const body = NoteBody.safeParse(req.body);
      if (!id.success || !body.success)
        return void res.status(400).json({ error: 'Valid note and expectedVersion are required' });
      try {
        const result = await withTransaction(appkit.lakebase, async (client) => {
          await ensureCase(client, id.data, body.data.meta);
          const updated = await client.query(
            'UPDATE ra.cases SET version=version+1, updated_at=NOW() WHERE exception_id=$1 AND version=$2 RETURNING *',
            [id.data, body.data.expectedVersion]
          );
          if (!updated.rows[0]) return { conflict: (await loadPayload(client, id.data)).case };
          await client.query('INSERT INTO ra.case_notes(exception_id,author,body) VALUES($1,$2,$3)', [
            id.data,
            currentUser(req),
            body.data.body,
          ]);
          await enqueueSnapshot(client, id.data);
          return { payload: await loadPayload(client, id.data) };
        });
        if ('conflict' in result) return void conflict(res, result.conflict);
        res.json(result.payload);
        void onMutation();
      } catch (error) {
        console.error('[cases] note failed:', error);
        res.status(500).json({ error: 'Failed to add note; no changes were committed' });
      }
    });
  });
}
