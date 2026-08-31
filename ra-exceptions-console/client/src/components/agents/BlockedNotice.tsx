import { Alert, AlertTitle, AlertDescription } from '@databricks/appkit-ui/react';
import type { PipelineHealth } from '../../lib/agents/types';

/**
 * Renders in place of an agent panel's recommendation when the Pipeline
 * Reliability agent has vetoed downstream output (state === 'unavailable' |
 * 'red'). No recommendation is computed in this state — this is the veto
 * made visible, not just a generic error.
 */
export function BlockedNotice({ health }: { health: PipelineHealth }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Blocked by Pipeline Reliability agent</AlertTitle>
      <AlertDescription>
        {health.reason} This agent will not recommend an action against evidence that may be wrong. See the Pipeline
        Reliability tab for details.
      </AlertDescription>
    </Alert>
  );
}
