import type { ReactNode } from 'react';

interface RowActionButtonProps {
  onClick: () => void;
  label: string;
  children: ReactNode;
}

/**
 * A real, keyboard- and screen-reader-correct trigger for opening a table
 * row's detail view. Renders as a genuine <button> — Enter/Space work
 * natively and screen readers announce it as a button with a full
 * descriptive name, instead of faking row semantics with tabIndex/role
 * tricks on a <tr> (which breaks table row navigation for assistive tech).
 */
export function RowActionButton({ onClick, label, children }: RowActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="rounded text-left font-medium text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </button>
  );
}
