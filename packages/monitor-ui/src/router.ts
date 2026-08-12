/**
 * Hash routing in twenty lines. The monitor is served from a plain node:http
 * server with a catch-all, and the whole app is four screens — a router library
 * would be more configuration than code.
 */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'runs' }
  | { name: 'run'; runId: string }
  | { name: 'skills' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const [head, tail] = path.split('/');
  if (head === 'runs' && tail) return { name: 'run', runId: decodeURIComponent(tail) };
  if (head === 'runs') return { name: 'runs' };
  if (head === 'skills') return { name: 'skills' };
  return { name: 'dashboard' };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'run':
      return `#/runs/${encodeURIComponent(route.runId)}`;
    case 'runs':
      return '#/runs';
    case 'skills':
      return '#/skills';
    default:
      return '#/dashboard';
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
