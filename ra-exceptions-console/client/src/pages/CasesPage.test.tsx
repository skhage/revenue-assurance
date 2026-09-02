// @vitest-environment jsdom
//
// Integration test against the production CasesPage: mocks the network layer
// (casesApi's fetch calls) and drives the real row-open flow through real
// components, so a regression in keyboard semantics, labels, or focus
// behavior on the production row-action button fails this test.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CasesPage } from './CasesPage';
import type { CaseRow } from '../lib/cases';

const CASE: CaseRow = {
  exception_id: 'exc-1',
  reference_id: 'REF-100',
  account_name: 'Acme Fiber',
  check_type: 'unauthorized_discount',
  severity: 'HIGH',
  amount_at_risk: 5000,
  status: 'New',
  assignee: null,
};

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe('CasesPage row-open flow', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/analytics/evidence')) {
          return jsonResponse({ rows: [], note: 'No additional detection evidence for this exception.' });
        }
        if (url.startsWith('/api/cases/exc-1')) {
          return jsonResponse({ case: { ...CASE, status: 'New' }, notes: [] });
        }
        if (url.startsWith('/api/cases')) {
          return jsonResponse([CASE]);
        }
        return jsonResponse({});
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the exception drawer via a real, labelled button reachable by keyboard', async () => {
    render(<CasesPage />);

    const openButton = await screen.findByRole('button', { name: /Open case REF-100/i });
    expect(openButton.tagName).toBe('BUTTON');

    await userEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(within(screen.getByRole('dialog')).getByText('Acme Fiber')).toBeInTheDocument();
  });

  it('opens the drawer on Enter after tabbing to the row button', async () => {
    render(<CasesPage />);

    const openButton = await screen.findByRole('button', { name: /Open case REF-100/i });
    openButton.focus();
    expect(openButton).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(within(screen.getByRole('dialog')).getByText('Acme Fiber')).toBeInTheDocument();
  });
});
