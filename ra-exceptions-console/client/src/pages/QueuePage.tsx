import {
  useAnalyticsQuery,
  Card,
  Input,
  Button,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { SeverityBadge, StatusChip } from '../components/badges';
import { ExceptionDrawer } from '../components/ExceptionDrawer';
import { ToggleChip } from '../components/ToggleChip';
import { RowActionButton } from '../components/RowActionButton';
import { LoadingRegion, ErrorRegion } from '../components/StatusRegion';
import { analyticsApi } from '../lib/analytics';
import { usd, numCompact, checkLabel, accountLabel } from '../lib/format';
import type { ExceptionRow } from '../lib/types';

const PAGE_SIZE = 25;

export function QueuePage() {
  const [checkType, setCheckType] = useState('ALL');
  const [severity, setSeverity] = useState('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [selected, setSelected] = useState<ExceptionRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Debounce the free-text search.
  // Skip the initial mount — the first fetch is already triggered by the
  // filters memo. Without this guard the 300ms timer can fire *after* the
  // initial fetch resolves, setting loading=true with no filter change to
  // trigger a re-fetch, which strands the table in a permanent loading state.
  const searchMounted = useRef(false);
  useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return;
    }
    const t = setTimeout(() => {
      setLoading(true);
      setError(null);
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const chips = useAnalyticsQuery('rootcause_breakdown', { severity: sql.string('ALL') });

  // Filter setters that also reset paging (avoids a setState-in-effect).
  const pickCheck = (v: string) => {
    setLoading(true);
    setError(null);
    setCheckType((prev) => (prev === v ? 'ALL' : v));
    setOffset(0);
  };
  const pickSeverity = (v: string) => {
    setLoading(true);
    setError(null);
    setSeverity(v);
    setOffset(0);
  };

  const filters = useMemo(
    () => ({
      check_type: checkType,
      severity,
      search,
      row_limit: PAGE_SIZE,
      row_offset: offset,
    }),
    [checkType, severity, search, offset]
  );

  useEffect(() => {
    const controller = new AbortController();
    analyticsApi
      .exceptions(filters, controller.signal)
      .then((nextRows) => {
        setRows(nextRows);
        setError(null);
      })
      .catch((err) => {
        if (err instanceof Error && err.name !== 'AbortError') setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filters, refreshKey]);

  function openRow(row: ExceptionRow) {
    setSelected(row);
    setDrawerOpen(true);
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleChip active={checkType === 'ALL'} onClick={() => pickCheck('ALL')}>
          All checks
        </ToggleChip>
        {(chips.data ?? []).map((c) => (
          <ToggleChip key={c.check_type} active={checkType === c.check_type} onClick={() => pickCheck(c.check_type)}>
            {checkLabel(c.check_type)} <span className="text-muted-foreground">{numCompact(c.exception_count)}</span>
          </ToggleChip>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <Select value={severity} onValueChange={pickSeverity}>
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All severity</SelectItem>
              <SelectItem value="HIGH">High</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search account or reference…"
              className="h-9 w-56 pl-8"
              aria-label="Search exceptions"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <Card className="overflow-hidden shadow-sm">
        {error ? (
          <ErrorRegion
            message="Couldn't load the exception queue right now."
            onRetry={() => {
              setLoading(true);
              setError(null);
              setRefreshKey((key) => key + 1);
            }}
          />
        ) : loading ? (
          <LoadingRegion label="Loading exceptions">
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <div className="text-sm font-medium text-foreground">No matching exceptions</div>
            <div className="mt-1 text-sm text-muted-foreground">
              No detected leakage matches these filters. Try clearing them.
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Root cause</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead className="text-right">$ at risk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.exception_id}
                    data-state={selected?.exception_id === row.exception_id ? 'selected' : undefined}
                  >
                    <TableCell className="font-mono text-xs">
                      <RowActionButton
                        onClick={() => openRow(row)}
                        label={`Open exception ${row.reference_id || row.exception_id}`}
                      >
                        {row.reference_id || '—'}
                      </RowActionButton>
                    </TableCell>
                    <TableCell className="max-w-48 truncate">{accountLabel(row.account_name)}</TableCell>
                    <TableCell className="text-muted-foreground">{checkLabel(row.check_type)}</TableCell>
                    <TableCell>
                      <SeverityBadge severity={row.severity} />
                    </TableCell>
                    <TableCell>
                      <StatusChip status={row.status} />
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-muted-foreground">
                      {row.assignee?.split('@')[0] ?? 'Unassigned'}
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums text-destructive">
                      {usd(row.amount_at_risk)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>Sorted by $ at risk, high → low · page {page}</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => {
              setLoading(true);
              setError(null);
              setOffset((o) => Math.max(0, o - PAGE_SIZE));
            }}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || rows.length < PAGE_SIZE}
            onClick={() => {
              setLoading(true);
              setError(null);
              setOffset((o) => o + PAGE_SIZE);
            }}
          >
            Next
          </Button>
        </div>
      </div>

      <ExceptionDrawer
        exception={selected}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onCaseChange={() => {
          setLoading(true);
          setError(null);
          setRefreshKey((key) => key + 1);
        }}
      />
    </div>
  );
}
