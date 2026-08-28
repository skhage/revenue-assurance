import type { ReactNode } from 'react';

interface ToggleChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** Pill-style filter toggle. Announces its pressed state via aria-pressed. */
export function ToggleChip({ active, onClick, children }: ToggleChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        active ? 'border-transparent bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}
