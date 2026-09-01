import { Tabs, TabsList, TabsTrigger, TabsContent } from '@databricks/appkit-ui/react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PipelineReliabilityPanel, usePipelineHealth } from '../components/agents/PipelineReliabilityPanel';
import { InvestigationPanel } from '../components/agents/InvestigationPanel';
import { PrioritizationPanel } from '../components/agents/PrioritizationPanel';
import { RecoveryPlaybookPanel } from '../components/agents/RecoveryPlaybookPanel';
import { analyticsApi } from '../lib/analytics';
import type { ExceptionRow } from '../lib/types';

const FALLBACK_HEALTH = {
  state: 'unavailable' as const,
  reason: 'Pipeline health has not loaded yet.',
  rows: [],
  freshestObservedAt: null,
};

/**
 * Single entry point for the four demo agents. Tell (pipeline health) → show
 * (evidence/ranking) → tell (recommendation + citation), one tab per agent.
 * Selection of "the current exception" is shared across Investigate,
 * Prioritize & route, and Recovery playbook so a single exception can flow
 * through the whole loop — pick it in Investigate (or "Carry forward" it
 * from a ranked row in Prioritize & route), and Recovery playbook opens
 * already showing it.
 */
export function AgentWorkbenchPage() {
  const [searchParams] = useSearchParams();
  const pipelineHealthResult = usePipelineHealth();
  const [selected, setSelected] = useState<ExceptionRow | null>(null);

  useEffect(() => {
    const exceptionId = searchParams.get('exception_id');
    if (!exceptionId || selected) return;
    const controller = new AbortController();
    analyticsApi
      .exceptions({ check_type: 'ALL', severity: 'ALL', search: '', row_limit: 100, row_offset: 0 }, controller.signal)
      .then((rows) => {
        const match = rows.find((r) => r.exception_id === exceptionId);
        if (match) setSelected(match);
      })
      .catch(() => {
        /* deep-link is a convenience; failing silently keeps the picker usable */
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const health = pipelineHealthResult.health ?? FALLBACK_HEALTH;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      <Tabs defaultValue="reliability">
        <TabsList>
          <TabsTrigger value="reliability">Pipeline reliability</TabsTrigger>
          <TabsTrigger value="investigate">Investigate</TabsTrigger>
          <TabsTrigger value="prioritize">Prioritize &amp; route</TabsTrigger>
          <TabsTrigger value="recovery">Recovery playbook</TabsTrigger>
        </TabsList>

        <TabsContent value="reliability">
          <PipelineReliabilityPanel result={pipelineHealthResult} />
        </TabsContent>

        <TabsContent value="investigate">
          <InvestigationPanel health={health} selected={selected} onSelect={setSelected} />
        </TabsContent>

        <TabsContent value="prioritize">
          <PrioritizationPanel health={health} selected={selected} onSelect={setSelected} />
        </TabsContent>

        <TabsContent value="recovery">
          <RecoveryPlaybookPanel health={health} selected={selected} onSelect={setSelected} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
