import { createApp, analytics, lakebase, server } from '@databricks/appkit';
import { setupAnalyticsRoutes } from './routes/analytics';
import { setupEvidenceRoutes } from './routes/evidence';
import { setupCaseRoutes } from './routes/cases';
import { setupArchitectureRoutes } from './routes/architecture';
import { setupDqAuditRoutes } from './routes/dqAudit';

createApp({
  plugins: [analytics(), lakebase(), server()],
  async onPluginsReady(appkit) {
    await setupCaseRoutes(appkit);
    setupAnalyticsRoutes(appkit);
    setupEvidenceRoutes(appkit);
    setupArchitectureRoutes(appkit);
    setupDqAuditRoutes(appkit);
  },
}).catch(console.error);
