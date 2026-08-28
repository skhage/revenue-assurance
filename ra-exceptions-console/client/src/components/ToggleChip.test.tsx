// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToggleChip } from './ToggleChip';

describe('ToggleChip', () => {
  it('reflects the active state via aria-pressed', () => {
    render(
      <ToggleChip active onClick={() => {}}>
        Active chip
      </ToggleChip>
    );
    expect(screen.getByRole('button', { name: 'Active chip' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reflects the inactive state via aria-pressed', () => {
    render(
      <ToggleChip active={false} onClick={() => {}}>
        Inactive chip
      </ToggleChip>
    );
    expect(screen.getByRole('button', { name: 'Inactive chip' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(
      <ToggleChip active={false} onClick={onClick}>
        Click me
      </ToggleChip>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Click me' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
