import { Button } from '@databricks/appkit-ui/react';
import { ExternalLink } from 'lucide-react';

interface Props {
  label: string;
  href: string | null;
  variant?: 'outline' | 'ghost' | 'default';
}

/**
 * Opens a workspace URL in a new tab. Disabled (not hidden) when the URL
 * can't be built — e.g. local dev has no DATABRICKS_HOST — so the layout
 * stays stable and the reason ("no workspace host configured") is visible
 * via the title tooltip rather than a silently missing button.
 *
 * Uses an explicit window.open() click handler instead of relying on
 * <a target="_blank"> — the latter is silently blocked when the app runs
 * inside the Apps V2 cross-origin iframe.
 */
export function WorkspaceLinkButton({ label, href, variant = 'outline' }: Props) {
  if (!href) {
    return (
      <Button variant={variant} size="sm" disabled title="No workspace host configured">
        <ExternalLink className="h-3.5 w-3.5" />
        {label}
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
      title={href}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}
