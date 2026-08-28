import { Button } from '@databricks/appkit-ui/react';
import type { ReactNode } from 'react';

/** Wraps loading skeletons so screen readers announce the busy state. */
export function LoadingRegion({ children, label = 'Loading' }: { children: ReactNode; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label}>
      {children}
    </div>
  );
}

interface ErrorRegionProps {
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/** Announced error state with an actionable retry path, instead of an inert dead end. */
export function ErrorRegion({ message, onRetry, retryLabel = 'Retry', className }: ErrorRegionProps) {
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center justify-between gap-3 p-6 text-sm text-destructive ${className ?? ''}`}
    >
      <span>{message}</span>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
