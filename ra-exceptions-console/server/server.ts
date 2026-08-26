import { createApp, analytics, lakebase, server } from '@databricks/appkit';
import { setupAnalyticsRoutes } from './routes/analytics';
import { setupCaseRoutes } from './routes/cases';

createApp({
  plugins: [analytics(), lakebase(), server()],
  async onPluginsReady(appkit) {
    await setupCaseRoutes(appkit);
    setupAnalyticsRoutes(appkit);
  },
}).catch(console.error);
