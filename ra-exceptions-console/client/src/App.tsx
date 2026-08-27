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
  Activity,
  SearchCheck,
  Zap,
  Waypoints,
} from 'lucide-react';
import { OverviewPage } from './pages/OverviewPage';
import { QueuePage } from './pages/QueuePage';
import { CasesPage } from './pages/CasesPage';
import { ArchitecturePage } from './pages/ArchitecturePage';
import { useTheme } from './lib/useTheme';
import { WhoAmIProvider, useWhoAmI } from './lib/whoami';
import { initials } from './lib/format';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/queue', label: 'Exception queue', icon: ListChecks, end: false },
  { to: '/cases', label: 'My cases', icon: Briefcase, end: false },
];

const SECONDARY_NAV = [{ to: '/architecture', label: 'Architecture', icon: Waypoints, end: false }];

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Overview', sub: 'Revenue leakage across all reconciliation checks' },
  '/queue': { title: 'Exception queue', sub: 'Triage detected leakage, highest impact first' },
  '/cases': { title: 'My cases', sub: 'Cases you are investigating and recovering' },
  '/architecture': {
    title: 'Architecture',
    sub: 'How source simulation, reconciliation, ML, and serving fit together',
  },
};

function navItemClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
    isActive
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
  }`;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const me = useWhoAmI();
  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex items-center gap-2 px-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Activity className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold text-sidebar-foreground">Ledger RA</span>
      </div>

      <nav className="flex flex-col gap-0.5">
        <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Workflow
        </div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navItemClass} onClick={onNavigate}>
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      <nav className="flex flex-col gap-0.5">
        <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Detection
        </div>
        <div className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground/60">
          <SearchCheck className="h-4 w-4 shrink-0" /> Reconciliation rules
        </div>
        <div className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground/60">
          <Zap className="h-4 w-4 shrink-0" /> Anomaly models
        </div>
      </nav>

      <nav className="flex flex-col gap-0.5">
        <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Learn</div>
        {SECONDARY_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={navItemClass} onClick={onNavigate}>
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 border-t border-sidebar-border pt-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {initials(me)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-sidebar-foreground">{me.split('@')[0]}</div>
          <div className="text-[11px] text-muted-foreground">RA Analyst · B2B Broadband</div>
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
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
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
