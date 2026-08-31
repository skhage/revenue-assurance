// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { DemoBadge } from './DemoBadge';

describe('DemoBadge', () => {
  it('renders the deterministic label', () => {
    render(<DemoBadge kind="deterministic" />);
    expect(screen.getByText('Deterministic · rule-based')).toBeInTheDocument();
  });

  it('renders the demo-data label', () => {
    render(<DemoBadge kind="demo-data" />);
    expect(screen.getByText('Demo data')).toBeInTheDocument();
  });
});
