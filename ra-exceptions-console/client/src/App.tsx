import { createBrowserRouter, RouterProvider, NavLink, Outlet, useLocation } from 'react-router';
import { useState } from 'react';
import { Button, Sheet, SheetContent } from '@databricks/appkit-ui/react';
import {
  LayoutGrid,
  ListChecks,
  Briefcase,
  Menu,
  Moon,
  Sun,
  SearchCheck,
  Zap,
  Waypoints,
  Lightbulb,
  Bot,
  type LucideIcon,
} from 'lucide-react';
import { OverviewPage } from './pages/OverviewPage';
import { QueuePage } from './pages/QueuePage';
import { CasesPage } from './pages/CasesPage';
import { ArchitecturePage } from './pages/ArchitecturePage';
import { WhyItMattersPage } from './pages/WhyItMattersPage';
import { AgentWorkbenchPage } from './pages/AgentWorkbenchPage';
import { LakelinkMark } from './components/LakelinkMark';
import { DatabricksLogo } from './components/DatabricksLogo';
import { useTheme } from './lib/useTheme';
import { WhoAmIProvider, useWhoAmI } from './lib/whoami';
import { initials } from './lib/format';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/queue', label: 'Exception queue', icon: ListChecks, end: false },
  { to: '/cases', label: 'My cases', icon: Briefcase, end: false },
  { to: '/agents', label: 'Agent Workbench', icon: Bot, end: false },
];

const SECONDARY_NAV = [
  { to: '/why', label: 'Why RA matters', icon: Lightbulb, end: false },
  { to: '/architecture', label: 'Architecture', icon: Waypoints, end: false },
];

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Overview', sub: 'Revenue leakage across all reconciliation checks' },
  '/queue': { title: 'Exception queue', sub: 'Triage detected leakage, highest impact first' },
  '/cases': { title: 'My cases', sub: 'Cases you are investigating and recovering' },
  '/why': { title: 'Why RA matters', sub: 'The business case, the challenges, and why Databricks — before the demo' },
  '/agents': { title: 'Agent Workbench', sub: 'Deterministic agents over existing RA data — human-approved, no LLM' },
  '/why': { title: 'Why RA matters', sub: 'The business case, the challenges, and why Databricks — before the demo' },
  '/architecture': { title: 'Architecture', sub: 'The demo mapped onto the Databricks Data + AI Platform' },
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">
      {children}
    </div>
  );
}

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `relative flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-sm transition-colors ${
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-brand transition-opacity ${
              isActive ? 'opacity-100' : 'opacity-0'
            }`}
          />
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </>
      )}
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const me = useWhoAmI();
  return (
    <div className="flex h-full flex-col gap-6">
      {/* Product lockup */}
      <div className="flex items-center gap-2.5 px-1">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm">
          <LakelinkMark className="h-5 w-5" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-sidebar-foreground">Lakelink Fiber</div>
          <div className="text-[11px] text-sidebar-foreground/60">Revenue Assurance</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5">
        <SectionLabel>Workflow</SectionLabel>
        {NAV.map(({ to, label, icon, end }) => (
          <NavItem key={to} to={to} label={label} icon={icon} end={end} onNavigate={onNavigate} />
        ))}
      </nav>

      <nav className="flex flex-col gap-0.5">
        <SectionLabel>Detection</SectionLabel>
        <div className="flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-sm text-sidebar-foreground/40">
          <SearchCheck className="h-4 w-4 shrink-0" /> Reconciliation rules
        </div>
        <div className="flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-sm text-sidebar-foreground/40">
          <Zap className="h-4 w-4 shrink-0" /> Anomaly models
        </div>
      </nav>

      <nav className="flex flex-col gap-0.5">
        <SectionLabel>Learn</SectionLabel>
        {SECONDARY_NAV.map(({ to, label, icon, end }) => (
          <NavItem key={to} to={to} label={label} icon={icon} end={end} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <div className="flex items-center gap-2.5 border-t border-sidebar-border pt-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-foreground">
            {initials(me)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-sidebar-foreground">{me.split('@')[0]}</div>
            <div className="text-[11px] text-sidebar-foreground/60">RA Analyst · B2B Broadband</div>
          </div>
        </div>
        <div className="border-t border-sidebar-border pt-3">
          <DatabricksLogo label="Built on" />
        </div>
      </div>
    </div>
  );
}

function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const meta = TITLES[location.pathname] ?? { title: 'Revenue Assurance', sub: '' };

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 md:flex">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-4">
          <SidebarContent onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-base font-semibold text-foreground">{meta.title}</h1>
              {meta.sub && <p className="text-xs text-muted-foreground">{meta.sub}</p>}
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
        </header>

        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/queue', element: <QueuePage /> },
      { path: '/cases', element: <CasesPage /> },
      { path: '/why', element: <WhyItMattersPage /> },
      { path: '/agents', element: <AgentWorkbenchPage /> },
      { path: '/why', element: <WhyItMattersPage /> },
      { path: '/architecture', element: <ArchitecturePage /> },
    ],
  },
]);

export default function App() {
  return (
    <WhoAmIProvider>
      <RouterProvider router={router} />
    </WhoAmIProvider>
  );
}
