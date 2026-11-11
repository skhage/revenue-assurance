import { ChevronDown, ChevronRight } from 'lucide-react';

// V23 M1 / V24: a real disclosure button for expandable table rows. The <tr>
// keeps native table semantics (no role/tabIndex/aria-label), so screen readers
// still read every cell and support row/column navigation. Mouse users can keep
// clicking the row; the button stops propagation to avoid a double toggle.
export function ExpandToggle({
  isExpanded,
  controlsId,
  name,
  onToggle,
}: {
  isExpanded: boolean;
  controlsId: string;
  name: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      aria-controls={controlsId}
      onClick={(e) => {
        e.stopPropagation(); // row onClick also toggles; avoid double toggle
        onToggle();
      }}
      className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {isExpanded ? (
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      ) : (
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      )}
      <span className="sr-only">{`${isExpanded ? 'Hide' : 'Show'} details for ${name}`}</span>
    </button>
  );
}

/** Make an arbitrary key safe for use as a DOM id (aria-controls target). */
export const domId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-');
