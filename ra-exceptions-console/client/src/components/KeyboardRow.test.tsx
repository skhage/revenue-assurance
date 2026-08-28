// @vitest-environment jsdom
//
// Tests the keyboard-operable table row interaction contract used in
// QueuePage.tsx and CasesPage.tsx (tabIndex + onKeyDown for Enter/Space),
// without pulling in either page's data layer.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

function KeyboardRowFixture({ onOpen }: { onOpen: () => void }) {
  return (
    <table>
      <tbody>
        <tr
          tabIndex={0}
          role="row"
          aria-label="Open exception REF-1"
          className="cursor-pointer"
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpen();
            }
          }}
        >
          <td>REF-1</td>
        </tr>
      </tbody>
    </table>
  );
}

describe('keyboard-operable table row', () => {
  it('is reachable by Tab and opens on Enter', async () => {
    const onOpen = vi.fn();
    render(<KeyboardRowFixture onOpen={onOpen} />);

    await userEvent.tab();
    expect(screen.getByLabelText('Open exception REF-1')).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens on Space', async () => {
    const onOpen = vi.fn();
    render(<KeyboardRowFixture onOpen={onOpen} />);

    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('still opens on click', async () => {
    const onOpen = vi.fn();
    render(<KeyboardRowFixture onOpen={onOpen} />);

    await userEvent.click(screen.getByLabelText('Open exception REF-1'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
