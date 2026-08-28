// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { SeverityBadge, StatusChip } from './badges';

describe('SeverityBadge', () => {
  it('renders the title-cased severity label', () => {
    render(<SeverityBadge severity="HIGH" />);
    expect(screen.getByText('High')).toBeInTheDocument();
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
