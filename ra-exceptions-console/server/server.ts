import { createApp, analytics, lakebase, server } from '@databricks/appkit';
import { setupAnalyticsRoutes } from './routes/analytics';
import { setupCaseRoutes } from './routes/cases';
import { setupArchitectureRoutes } from './routes/architecture';

createApp({
  plugins: [analytics(), lakebase(), server()],
  async onPluginsReady(appkit) {
    await setupCaseRoutes(appkit);
    setupAnalyticsRoutes(appkit);
    setupArchitectureRoutes(appkit);
  },
}).catch(console.error);
