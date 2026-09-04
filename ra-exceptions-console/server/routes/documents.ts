import type { Application, Request, Response } from 'express';
import { WorkspaceClient } from '@databricks/sdk-experimental';

/**
 * Streams a source PDF (Ironclad contract / invoice) from its Unity Catalog
 * Volume so the exception drawer can embed it in-app. Runs as the app service
 * principal (granted READ VOLUME on the CLM volumes) via the Databricks Files
 * API. Paths are validated against an allowlist prefix so this can only ever
 * serve the CLM document volumes — never an arbitrary workspace file.
 */

interface AppKitServer {
  server: { extend(fn: (app: Application) => void): void };
}

// The CLM document volume root. Must match the pipeline's `ra.clm_volume_root`
// (silver_doc_intelligence.sql reads `${ra.clm_volume_root}/{contract,invoice}_pdfs/`),
// otherwise every real file_name is rejected and "View PDF" 400s. Configurable
// via RA_CLM_VOLUME_ROOT so a workspace whose volume differs isn't hardcoded
// out; defaults to the demo's volume.
const ALLOWED_PREFIX =
  (process.env.RA_CLM_VOLUME_ROOT || '/Volumes/cdm_tmforum/ironclad_clm_source').replace(/\/+$/, '') + '/';

let client: WorkspaceClient | null = null;
function workspace(): WorkspaceClient {
  // Auto-authenticates as the app service principal from the injected env.
  if (!client) client = new WorkspaceClient({});
  return client;
}

function isSafePath(path: string): boolean {
  return path.startsWith(ALLOWED_PREFIX) && path.toLowerCase().endsWith('.pdf') && !path.includes('..');
}

export function setupDocumentRoutes(appkit: AppKitServer) {
  appkit.server.extend((app) => {
    app.get('/api/documents', async (req: Request, res: Response) => {
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      if (!isSafePath(path)) {
        res.status(400).json({ error: 'Invalid document path' });
        return;
      }
      try {
        const resp = await workspace().files.download({ file_path: path });
        const contents = resp.contents;
        if (!contents) {
          res.status(404).json({ error: 'Document not found' });
          return;
        }
        // Buffer the file (CLM PDFs are tens of KB) then send with a PDF type.
        const reader = contents.getReader();
        const chunks: Buffer[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(Buffer.from(value));
        }
        const body = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${path.split('/').pop() ?? 'document.pdf'}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(body);
      } catch (err) {
        console.error('[documents] download failed for', path, err);
        res.status(502).json({ error: 'Failed to load document' });
      }
    });
  });
}
