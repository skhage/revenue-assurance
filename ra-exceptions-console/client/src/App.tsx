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
  Sparkles,
  ArrowUpRight,
  Bell,
  FileCheck,
  Handshake,
  ShoppingCart,
  Banknote,
  UserX,
  Gavel,
  type LucideIcon,
} from 'lucide-react';
import { OverviewPage } from './pages/OverviewPage';
import { QueuePage } from './pages/QueuePage';
import { CasesPage } from './pages/CasesPage';
import { ArchitecturePage } from './pages/ArchitecturePage';
import { WhyItMattersPage } from './pages/WhyItMattersPage';
import { AgentWorkbenchPage } from './pages/AgentWorkbenchPage';
import { GeniePage } from './pages/GeniePage';
import { RecoveryPage } from './pages/RecoveryPage';
import { AlertsPage } from './pages/AlertsPage';
import { CompliancePage } from './pages/CompliancePage';
import { PartnerSettlementPage } from './pages/PartnerSettlementPage';
import { OrderToBillPage } from './pages/OrderToBillPage';
import { CollectionsPage } from './pages/CollectionsPage';
import { CommissionPage } from './pages/CommissionPage';
import { DisputesPage } from './pages/DisputesPage';
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
  { to: '/ask', label: 'Ask (Genie)', icon: Sparkles, end: false },
];

const AI_NAV = [
  { to: '/recovery', label: 'Recovery', icon: ArrowUpRight, end: false },
  { to: '/alerts', label: 'Risk alerts', icon: Bell, end: false },
  { to: '/compliance', label: 'Compliance', icon: FileCheck, end: false },
  { to: '/partners', label: 'Partner settlement', icon: Handshake, end: false },
  { to: '/order-to-bill', label: 'Order-to-bill', icon: ShoppingCart, end: false },
  { to: '/collections', label: 'Collections intel', icon: Banknote, end: false },
  { to: '/commission', label: 'Commission leakage', icon: UserX, end: false },
  { to: '/disputes', label: 'Billing disputes', icon: Gavel, end: false },
];

const SECONDARY_NAV = [
  { to: '/why', label: 'Why RA matters', icon: Lightbulb, end: false },
  { to: '/architecture', label: 'Architecture', icon: Waypoints, end: false },
];

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Overview', sub: 'Revenue leakage across all reconciliation checks' },
  '/queue': { title: 'Exception queue', sub: 'Triage detected leakage, highest impact first' },
  '/cases': { title: 'My cases', sub: 'Cases you are investigating and recovering' },
  '/agents': { title: 'Agent Workbench', sub: 'Deterministic agents over existing RA data — human-approved, no LLM' },
  '/ask': { title: 'Ask (Genie)', sub: 'Natural-language questions over the governed RA data' },
  '/why': { title: 'Why RA matters', sub: 'The business case, the challenges, and why Databricks — before the demo' },
  '/recovery': { title: 'Recovery', sub: 'AI-ranked recovery opportunities with action plans' },
  '/alerts': { title: 'Risk alerts', sub: 'Predictive alerting — emerging leakage signals and structured alerts' },
  '/compliance': { title: 'Compliance', sub: 'Contract compliance scan — document fields vs billing records' },
  '/partners': { title: 'Partner settlement', sub: 'Inter-carrier and wholesale settlement reconciliation' },
  '/order-to-bill': { title: 'Order-to-bill', sub: 'Order, provisioning, and billing state misalignment — check type #13' },
  '/collections': { title: 'Collections intelligence', sub: 'Dunning-leakage correlation — stop collecting wrong amounts' },
  '/commission': { title: 'Commission leakage', sub: 'Agent fraud, clawback failures, and cap violations — 6 sub-check types' },
  '/disputes': { title: 'Billing disputes', sub: 'Fraud patterns, SLA breaches, stale disputes, and regulatory escalation — 7 check types' },
  '/architecture': { title: 'Architecture', sub: 'The demo mapped onto the Databricks Data + AI Platform' },
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/70">
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
          <div className="text-[11px] text-sidebar-foreground/70">Revenue Assurance</div>
        </div>
      </div>

      <nav aria-label="Workflow" className="flex flex-col gap-0.5">
        <SectionLabel>Workflow</SectionLabel>
        {NAV.map(({ to, label, icon, end }) => (
          <NavItem key={to} to={to} label={label} icon={icon} end={end} onNavigate={onNavigate} />
        ))}
      </nav>

      <nav aria-label="AI Agents" className="flex flex-col gap-0.5">
        <SectionLabel>AI Agents</SectionLabel>
        {AI_NAV.map(({ to, label, icon, end }) => (
          <NavItem key={to} to={to} label={label} icon={icon} end={end} onNavigate={onNavigate} />
        ))}
      </nav>

      <nav aria-label="Detection" className="flex flex-col gap-0.5">
        <SectionLabel>Detection</SectionLabel>
        <div className="flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-sm text-sidebar-foreground/40">
          <SearchCheck className="h-4 w-4 shrink-0" />
          <span>Reconciliation rules</span>
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wide">(coming soon)</span>
        </div>
        <div className="flex items-center gap-2.5 rounded-md py-2 pl-3.5 pr-2.5 text-sm text-sidebar-foreground/40">
          <Zap className="h-4 w-4 shrink-0" />
          <span>Anomaly models</span>
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wide">(coming soon)</span>
        </div>
      </nav>

      <nav aria-label="Learn" className="flex flex-col gap-0.5">
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
            <div className="text-[11px] text-sidebar-foreground/70">RA Analyst · B2B Broadband</div>
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
      {/* Skip-to-content link — WCAG 2.4.1 bypass block */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 md:flex">
        <SidebarContent />
      </aside>

      {/* Mobile sidebar */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-4" aria-label="Main navigation">
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

        <main id="main-content" className="flex-1 p-4 md:p-6">
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
      { path: '/agents', element: <AgentWorkbenchPage /> },
      { path: '/ask', element: <GeniePage /> },
      { path: '/recovery', element: <RecoveryPage /> },
      { path: '/alerts', element: <AlertsPage /> },
      { path: '/compliance', element: <CompliancePage /> },
      { path: '/partners', element: <PartnerSettlementPage /> },
      { path: '/order-to-bill', element: <OrderToBillPage /> },
      { path: '/collections', element: <CollectionsPage /> },
      { path: '/commission', element: <CommissionPage /> },
      { path: '/disputes', element: <DisputesPage /> },
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
