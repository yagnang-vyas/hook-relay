import type { ReactNode } from 'react';
import { useConnection } from '../api/connection';
import { EmptyState } from './ui';

/** Renders children only once the operator has entered an admin key for this tab. */
export function RequireKey({ children }: { children: ReactNode }) {
  const { hasApiKey } = useConnection();
  if (hasApiKey) return <>{children}</>;
  return (
    <EmptyState title="Admin API key required">
      This view reads the HookRelay admin API. Enter the key in{' '}
      <a className="text-accent underline" href="#/settings">
        Settings
      </a>
      ; it is held in memory only and is never stored or built into this app.
    </EmptyState>
  );
}
