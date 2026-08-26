import { Card, CardContent, Skeleton } from '@databricks/appkit-ui/react';
import type { ReactNode } from 'react';

interface KpiTileProps {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  loading?: boolean;
  error?: boolean;
}

/**
 * Composed KPI tile (AppKit ships no prebuilt KPI card). Big tabular figure,
 * a label, and a source/period sublabel so every number carries provenance.
 */
export function KpiTile({ label, value, sublabel, loading, error }: KpiTileProps) {
  return (
    <Card className="shadow-sm">
      <CardContent className="flex flex-col gap-1.5 p-4 md:p-5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : error ? (
          <span className="text-sm text-destructive">Unavailable</span>
        ) : (
          <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">{value}</span>
        )}
        {sublabel && <span className="text-xs text-muted-foreground">{sublabel}</span>}
      </CardContent>
    </Card>
  );
}
