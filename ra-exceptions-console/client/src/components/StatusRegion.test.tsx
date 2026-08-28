// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoadingRegion, ErrorRegion } from './StatusRegion';

describe('LoadingRegion', () => {
  it('exposes a status role with aria-live so screen readers announce it', () => {
    render(
      <LoadingRegion label="Loading things">
        <div>skeleton</div>
      </LoadingRegion>
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-label', 'Loading things');
  });
});

describe('ErrorRegion', () => {
  it('exposes an alert role and calls onRetry when the retry button is clicked', async () => {
    const onRetry = vi.fn();
    render(<ErrorRegion message="Something broke" onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');

    const retryButton = screen.getByRole('button', { name: 'Retry' });
    await userEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders without a retry button when onRetry is omitted', () => {
    render(<ErrorRegion message="Something broke" />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
