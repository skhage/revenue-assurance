// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { SeverityBadge, StatusChip } from './badges';

describe('SeverityBadge', () => {
  it('renders the title-cased severity label', () => {
    render(<SeverityBadge severity="HIGH" />);
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  // V46 L1: CRITICAL must be visually distinct from HIGH (solid fill vs /10 tint).
  it('renders CRITICAL with a solid fill distinct from HIGH', () => {
    render(
      <>
        <SeverityBadge severity="CRITICAL" />
        <SeverityBadge severity="HIGH" />
      </>
    );
    const critical = screen.getByText('Critical');
    const high = screen.getByText('High');
    expect(critical).toHaveClass('bg-destructive', 'text-destructive-foreground');
    expect(critical).not.toHaveClass('bg-destructive/10');
    expect(high).toHaveClass('bg-destructive/10', 'text-destructive');
    expect(high).not.toHaveClass('text-destructive-foreground');
    expect(critical.className).not.toEqual(high.className);
  });

  it('is case-insensitive for CRITICAL', () => {
    render(<SeverityBadge severity="critical" />);
    expect(screen.getByText('Critical')).toHaveClass('bg-destructive');
  });

  it('falls back to LOW styling for unknown severities', () => {
    render(<SeverityBadge severity="" />);
    expect(screen.getByText('Low')).toBeInTheDocument();
  });
});

describe('StatusChip', () => {
  it('renders the given status', () => {
    render(<StatusChip status="Investigating" />);
    expect(screen.getByText('Investigating')).toBeInTheDocument();
  });

  it('defaults to New when status is missing', () => {
    render(<StatusChip status={null} />);
    expect(screen.getByText('New')).toBeInTheDocument();
  });
});
