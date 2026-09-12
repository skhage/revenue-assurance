// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

vi.mock('./pages/OverviewPage', () => ({ OverviewPage: () => <div>Overview page</div> }));
vi.mock('./pages/QueuePage', () => ({ QueuePage: () => <div>Queue page</div> }));
vi.mock('./pages/CasesPage', () => ({ CasesPage: () => <div>Cases page</div> }));
vi.mock('./pages/ArchitecturePage', () => ({ ArchitecturePage: () => <div>Architecture page</div> }));
vi.mock('./pages/WhyItMattersPage', () => ({ WhyItMattersPage: () => <div>Why page content</div> }));
vi.mock('./pages/AgentWorkbenchPage', () => ({ AgentWorkbenchPage: () => <div>Workbench page content</div> }));
vi.mock('./components/LakelinkMark', () => ({ LakelinkMark: () => <span>Lakelink mark</span> }));
vi.mock('./components/DatabricksLogo', () => ({ DatabricksLogo: () => <span>Databricks logo</span> }));
vi.mock('./lib/useTheme', () => ({ useTheme: () => ({ theme: 'light', toggle: vi.fn() }) }));
vi.mock('./lib/whoami', () => ({
  WhoAmIProvider: ({ children }: { children: React.ReactNode }) => children,
  useWhoAmI: () => 'analyst@demo',
}));

describe('App route integration', () => {
  it('keeps both Agent Workbench and Why RA matters navigable', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: 'Agent Workbench' }));
    expect(await screen.findByText('Workbench page content')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Why RA matters' }));
    expect(await screen.findByText('Why page content')).toBeInTheDocument();
  });
});
