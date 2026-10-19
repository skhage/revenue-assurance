import { createApp, analytics, lakebase, server, genie } from '@databricks/appkit';
import { setupAnalyticsRoutes } from './routes/analytics';
import { setupEvidenceRoutes } from './routes/evidence';
import { setupDocumentRoutes } from './routes/documents';
import { setupCaseRoutes } from './routes/cases';
import { setupArchitectureRoutes } from './routes/architecture';
import { setupDqAuditRoutes } from './routes/dqAudit';
import { setupTriageRoutes } from './routes/triage';
import { setupRecoveryRoutes } from './routes/recovery';
import { setupAlertRoutes } from './routes/alerts';
import { setupComplianceRoutes } from './routes/compliance';
import { setupChatRoutes } from './routes/chat';
import { setupPartnerSettlementRoutes } from './routes/partner-settlement';
import { setupOrderToBillRoutes } from './routes/order-to-bill';
import { setupCollectionsRoutes } from './routes/collections';
import { setupCommissionRoutes } from './routes/commission';
import { setupDisputeRoutes } from './routes/disputes';

createApp({
  plugins: [analytics(), lakebase(), server(), genie()],
  async onPluginsReady(appkit) {
    await setupCaseRoutes(appkit);
    setupAnalyticsRoutes(appkit);
    setupEvidenceRoutes(appkit);
    setupDocumentRoutes(appkit);
    setupArchitectureRoutes(appkit);
    setupDqAuditRoutes(appkit);
    setupTriageRoutes(appkit);
    setupRecoveryRoutes(appkit);
    setupAlertRoutes(appkit);
    setupComplianceRoutes(appkit);
    setupChatRoutes(appkit);
    setupPartnerSettlementRoutes(appkit);
    setupOrderToBillRoutes(appkit);
    setupCollectionsRoutes(appkit);
    setupCommissionRoutes(appkit);
    setupDisputeRoutes(appkit);
  },
}).catch(console.error);
