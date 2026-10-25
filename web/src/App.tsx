import clsx from 'clsx';
import {
  Activity,
  FlaskConical,
  Gauge,
  Inbox,
  Menu,
  Moon,
  Settings,
  Skull,
  Sun,
  Webhook,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useConnection } from './api/connection';
import { Badge } from './components/ui';
import { useRoute, type Route } from './lib/route';
import { DeadPage } from './pages/Dead';
import { EventDetailPage } from './pages/EventDetail';
import { EventsPage } from './pages/Events';
import { HealthPage } from './pages/Health';
import { Overview } from './pages/Overview';
import { PlaygroundPage } from './pages/Playground';
import { SettingsPage } from './pages/Settings';

const NAV: { href: string; label: string; icon: ReactNode; match: Route['name'][] }[] = [
  { href: '#/', label: 'Overview', icon: <Gauge className="size-4" />, match: ['overview'] },
  {
    href: '#/events',
    label: 'Events',
    icon: <Inbox className="size-4" />,
    match: ['events', 'event'],
  },
  {
    href: '#/dead',
    label: 'Dead Letter Queue',
    icon: <Skull className="size-4" />,
    match: ['dead'],
  },
  {
    href: '#/playground',
    label: 'Playground',
    icon: <FlaskConical className="size-4" />,
    match: ['playground'],
  },
  {
    href: '#/health',
    label: 'System Health',
    icon: <Activity className="size-4" />,
    match: ['health'],
  },
  {
    href: '#/settings',
    label: 'Connection',
    icon: <Settings className="size-4" />,
    match: ['settings'],
  },
];

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem('hookrelay.theme');
      if (stored !== null) return stored === 'dark';
    } catch {
      // Theme preference is optional.
    }
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    );
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('hookrelay.theme', dark ? 'dark' : 'light');
    } catch {
      // Ignored: storage can be unavailable.
    }
  }, [dark]);
  return [
    dark,
    () => {
      setDark((d) => !d);
    },
  ];
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <Overview />;
    case 'events':
      return <EventsPage />;
    case 'event':
      return <EventDetailPage id={route.id} />;
    case 'dead':
      return <DeadPage />;
    case 'playground':
      return <PlaygroundPage />;
    case 'health':
      return <HealthPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

export function App() {
  const route = useRoute();
  const { hasApiKey } = useConnection();
  const [dark, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [route]);

  const nav = (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 p-2">
      {NAV.map((item) => {
        const active = item.match.includes(route.name);
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebarfg hover:bg-sidebaractive',
              active && 'bg-sidebaractive font-medium text-white',
            )}
          >
            {item.icon}
            {item.label}
          </a>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 flex-col bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-4 py-4 text-white">
          <Webhook className="size-5 text-sky-400" aria-hidden />
          <span className="font-semibold">HookRelay</span>
        </div>
        {nav}
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setOpen(false);
            }}
          />
          <aside className="relative h-full w-64 bg-sidebar">
            <div className="flex items-center justify-between px-4 py-4 text-white">
              <span className="font-semibold">HookRelay</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => {
                  setOpen(false);
                }}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted hover:bg-panel2 md:hidden"
            aria-label="Open navigation menu"
            onClick={() => {
              setOpen(true);
            }}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <div className="ml-auto flex items-center gap-3">
            {route.name === 'playground' ? (
              <Badge tone="sim">simulation workspace</Badge>
            ) : (
              <Badge tone={hasApiKey ? 'success' : 'neutral'}>
                {hasApiKey ? 'key in memory' : 'no key'}
              </Badge>
            )}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="rounded-md p-1.5 text-muted hover:bg-panel2"
            >
              {dark ? (
                <Sun className="size-4" aria-hidden />
              ) : (
                <Moon className="size-4" aria-hidden />
              )}
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          <div className="mx-auto max-w-6xl">
            <Page route={route} />
          </div>
        </main>
      </div>
    </div>
  );
}
