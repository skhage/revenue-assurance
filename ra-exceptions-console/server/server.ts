import { createApp, analytics, lakebase, server, genie } from '@databricks/appkit';
import { setupAnalyticsRoutes } from './routes/analytics';
import { setupEvidenceRoutes } from './routes/evidence';
import { setupDocumentRoutes } from './routes/documents';
import { setupCaseRoutes } from './routes/cases';
import { setupArchitectureRoutes } from './routes/architecture';

createApp({
  plugins: [analytics(), lakebase(), server(), genie()],
  async onPluginsReady(appkit) {
    await setupCaseRoutes(appkit);
    setupAnalyticsRoutes(appkit);
    setupEvidenceRoutes(appkit);
    setupDocumentRoutes(appkit);
    setupArchitectureRoutes(appkit);
  },
}).catch(console.error);
