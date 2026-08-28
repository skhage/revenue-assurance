// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowActionButton } from './RowActionButton';

describe('RowActionButton', () => {
  it('renders as a real button with an accessible name', () => {
    render(
      <RowActionButton onClick={() => {}} label="Open exception REF-1">
        REF-1
      </RowActionButton>
    );
    const button = screen.getByRole('button', { name: 'Open exception REF-1' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveTextContent('REF-1');
  });

  it('is reachable by Tab and activates on Enter, using native button semantics', async () => {
    const onClick = vi.fn();
    render(
      <RowActionButton onClick={onClick} label="Open exception REF-1">
        REF-1
      </RowActionButton>
    );

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Open exception REF-1' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates on Space', async () => {
    const onClick = vi.fn();
    render(
      <RowActionButton onClick={onClick} label="Open exception REF-1">
        REF-1
      </RowActionButton>
    );

    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates on click', async () => {
    const onClick = vi.fn();
    render(
      <RowActionButton onClick={onClick} label="Open exception REF-1">
        REF-1
      </RowActionButton>
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open exception REF-1' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows a visible focus ring class so keyboard focus is never invisible', () => {
    render(
      <RowActionButton onClick={() => {}} label="Open exception REF-1">
        REF-1
      </RowActionButton>
    );
    expect(screen.getByRole('button', { name: 'Open exception REF-1' }).className).toMatch(/focus-visible:ring/);
  });
});
