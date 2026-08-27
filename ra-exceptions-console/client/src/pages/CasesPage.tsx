import {
  Card,
  Button,
  Skeleton,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@databricks/appkit-ui/react';
import { useCallback, useEffect, useState } from 'react';
import { SeverityBadge, StatusChip } from '../components/badges';
import { ExceptionDrawer } from '../components/ExceptionDrawer';
import { usd, checkLabel, accountLabel } from '../lib/format';
import { casesApi, type CaseRow } from '../lib/cases';
import type { ExceptionRow } from '../lib/types';
import { useWorkflowRevision } from '../lib/workflowInvalidation';

// A worked case carries enough to open the drawer; the detail query refills the rest.
function toExceptionRow(c: CaseRow): ExceptionRow {
  return {
    exception_id: c.exception_id,
    reference_id: c.reference_id ?? '',
    account_name: c.account_name ?? '',
    check_type: c.check_type ?? '',
    severity: c.severity ?? 'LOW',
    amount_at_risk: c.amount_at_risk ?? 0,
    detection_method: '',
    source_table: '',
    customer_id: 0,
    known_leakage_flag: false,
    status: c.status,
    assignee: c.assignee,
    case_version: c.version,
  };
}

export function CasesPage() {
  const workflowRevision = useWorkflowRevision();
  const [mine, setMine] = useState(true);
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExceptionRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const refresh = useCallback(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        setRows(await casesApi.list(mine));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load cases');
      } finally {
        setLoading(false);
      }
    })();
  }, [mine]);

  useEffect(() => refresh(), [refresh, workflowRevision]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant={mine ? 'default' : 'outline'} size="sm" onClick={() => setMine(true)}>
          My cases
        </Button>
        <Button variant={!mine ? 'default' : 'outline'} size="sm" onClick={() => setMine(false)}>
          All worked cases
        </Button>
      </div>

      <Card className="overflow-hidden shadow-sm">
        {error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-sm font-medium text-foreground">
              {mine ? 'No cases assigned to you' : 'No cases worked yet'}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Open an exception from the queue and assign or action it to start a case.
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Root cause</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">$ at risk</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.exception_id}
                  className="cursor-pointer"
                  onClick={() => {
                    setSelected(toExceptionRow(c));
                    setDrawerOpen(true);
                  }}
                >
                  <TableCell className="font-mono text-xs">{c.reference_id || '—'}</TableCell>
                  <TableCell className="max-w-48 truncate">{accountLabel(c.account_name)}</TableCell>
                  <TableCell className="text-muted-foreground">{checkLabel(c.check_type)}</TableCell>
                  <TableCell>
                    <SeverityBadge severity={c.severity ?? 'LOW'} />
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold tabular-nums text-destructive">
                    {usd(c.amount_at_risk)}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={c.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.assignee?.split('@')[0] ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <ExceptionDrawer exception={selected} open={drawerOpen} onOpenChange={setDrawerOpen} onCaseChange={refresh} />
    </div>
  );
}
