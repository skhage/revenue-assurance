import { createApp, analytics, lakebase, server } from '@databricks/appkit';
import { setupAnalyticsRoutes } from './routes/analytics';
import { setupCaseRoutes } from './routes/cases';
import { setupArchitectureRoutes } from './routes/architecture';
import { createProjection } from './workflow';

createApp({
  plugins: [analytics(), lakebase(), server()],
  async onPluginsReady(appkit) {
    const projection = createProjection(appkit.analytics, appkit.lakebase);
    await projection.initialize();
    await setupCaseRoutes(appkit, projection.flush);
    setupAnalyticsRoutes(appkit);
    setupArchitectureRoutes(appkit);
    appkit.server.extend((app) => {
      app.get('/api/workflow/health', async (_req, res) => {
        const health = await projection.health();
        res.status(health.ready && health.maxAttempts < 5 ? 200 : 503).json(health);
      });
    });
    await projection.flush();
    const timer = setInterval(() => void projection.flush(), 30_000);
    timer.unref();
  },
}).catch(console.error);
