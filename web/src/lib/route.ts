import { useEffect, useState } from 'react';

export type Route =
  | { name: 'overview' }
  | { name: 'events' }
  | { name: 'event'; id: string }
  | { name: 'dead' }
  | { name: 'playground' }
  | { name: 'health' }
  | { name: 'settings' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean);
  switch (parts[0]) {
    case 'events':
      return parts[1] !== undefined
        ? { name: 'event', id: decodeURIComponent(parts[1]) }
        : { name: 'events' };
    case 'dead':
      return { name: 'dead' };
    case 'playground':
      return { name: 'playground' };
    case 'health':
      return { name: 'health' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'overview' };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);
  return route;
}
