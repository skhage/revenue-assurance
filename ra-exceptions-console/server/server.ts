import { createApp, analytics, lakebase, server } from '@databricks/appkit';
import { setupCaseRoutes } from './routes/cases';

createApp({
  plugins: [analytics(), lakebase(), server()],
  async onPluginsReady(appkit) {
    await setupCaseRoutes(appkit);
  },
}).catch(console.error);
