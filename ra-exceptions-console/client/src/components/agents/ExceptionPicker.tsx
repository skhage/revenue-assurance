import { Input, Skeleton } from '@databricks/appkit-ui/react';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RowActionButton } from '../RowActionButton';
import { LoadingRegion, ErrorRegion } from '../StatusRegion';
import { SeverityBadge } from '../badges';
import { analyticsApi } from '../../lib/analytics';
import { usd, checkLabel, accountLabel } from '../../lib/format';
import type { ExceptionRow } from '../../lib/types';

interface Props {
  selected: ExceptionRow | null;
  onSelect: (row: ExceptionRow) => void;
  label?: string;
}

/**
 * Search/select over the exception queue, shared by the Investigation and
 * Recovery Playbook panels so both agents operate on the same selection
 * pattern the Queue/Cases pages already use.
 */
export function ExceptionPicker({ selected, onSelect, label = 'Pick an exception to investigate' }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      setError(null);
      analyticsApi
        .exceptions(
          { check_type: 'ALL', severity: 'ALL', search: query.trim(), row_limit: 8, row_offset: 0 },
          controller.signal
        )
        .then(setRows)
        .catch((e) => {
          if (e instanceof Error && e.name !== 'AbortError') setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [query, refreshKey]);

  return (
    <div className="flex flex-col gap-2">
      <label
        className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        htmlFor="exception-picker-search"
      >
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          id="exception-picker-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search account or reference…"
          className="h-9 pl-8"
          aria-label="Search exceptions to investigate"
        />
      </div>

      {error ? (
        <ErrorRegion
          message="Couldn't search exceptions."
          onRetry={() => setRefreshKey((k) => k + 1)}
          className="p-2"
        />
      ) : loading ? (
        <LoadingRegion label="Searching exceptions">
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </LoadingRegion>
      ) : rows.length === 0 ? (
        <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">No matching exceptions.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.exception_id}
              className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                selected?.exception_id === row.exception_id ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <RowActionButton
                onClick={() => onSelect(row)}
                label={`Select exception ${row.reference_id || row.exception_id}`}
              >
                <span className="flex flex-col">
                  <span className="text-sm">{accountLabel(row.account_name)}</span>
                  <span className="text-xs text-muted-foreground">{checkLabel(row.check_type)}</span>
                </span>
              </RowActionButton>
              <div className="flex items-center gap-2">
                <SeverityBadge severity={row.severity} />
                <span className="font-mono text-xs tabular-nums text-destructive">{usd(row.amount_at_risk)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
