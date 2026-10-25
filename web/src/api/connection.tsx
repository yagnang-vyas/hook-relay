import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient } from './client';

const BASE_URL_STORAGE = 'hookrelay.apiBaseUrl';

function readStoredBaseUrl(): string | undefined {
  try {
    return localStorage.getItem(BASE_URL_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The only build-time setting is the (non-secret) API base URL. The admin key is never read from
 * the environment: the operator types it in and it lives in memory until the tab closes.
 */
export function defaultBaseUrl(): string {
  return (
    readStoredBaseUrl() ??
    (import.meta.env['VITE_HOOKRELAY_API_BASE_URL'] as string | undefined) ??
    ''
  );
}

interface Connection {
  client: ApiClient;
  baseUrl: string;
  setBaseUrl: (url: string) => void;
  hasApiKey: boolean;
  setApiKey: (key: string) => void;
  clearApiKey: () => void;
  /** Bumps when credentials or the base URL change so views can refetch. */
  version: number;
}

const ConnectionContext = createContext<Connection | undefined>(undefined);

export function ConnectionProvider({
  children,
  fetchImpl,
  initialBaseUrl,
  initialApiKey,
}: {
  children: ReactNode;
  fetchImpl?: typeof fetch;
  initialBaseUrl?: string;
  initialApiKey?: string;
}) {
  const keyRef = useRef<string | undefined>(initialApiKey);
  const [hasApiKey, setHasKey] = useState((initialApiKey ?? '') !== '');
  const [baseUrl, setBase] = useState(initialBaseUrl ?? defaultBaseUrl());
  const [version, setVersion] = useState(0);

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl,
        getApiKey: () => keyRef.current,
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      }),
    [baseUrl, fetchImpl],
  );

  const setApiKey = useCallback((key: string) => {
    keyRef.current = key.trim();
    setHasKey(keyRef.current !== '');
    setVersion((v) => v + 1);
  }, []);
  const clearApiKey = useCallback(() => {
    keyRef.current = undefined;
    setHasKey(false);
    setVersion((v) => v + 1);
  }, []);
  const setBaseUrl = useCallback((url: string) => {
    const clean = url.trim().replace(/\/+$/, '');
    setBase(clean);
    setVersion((v) => v + 1);
    try {
      if (clean === '') localStorage.removeItem(BASE_URL_STORAGE);
      else localStorage.setItem(BASE_URL_STORAGE, clean);
    } catch {
      // Persisting the URL is a convenience only.
    }
  }, []);

  const value = useMemo(
    () => ({ client, baseUrl, setBaseUrl, hasApiKey, setApiKey, clearApiKey, version }),
    [client, baseUrl, setBaseUrl, hasApiKey, setApiKey, clearApiKey, version],
  );
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): Connection {
  const ctx = useContext(ConnectionContext);
  if (ctx === undefined) throw new Error('useConnection must be used inside ConnectionProvider');
  return ctx;
}
