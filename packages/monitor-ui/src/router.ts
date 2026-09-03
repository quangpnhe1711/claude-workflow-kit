/**
 * The browser half of routing: reading the hash, and changing it.
 *
 * Everything that only reasons about routes lives in `routes.ts`, which has no
 * React and no `window` — so the route table can be tested without a DOM.
 */
import { useEffect, useState } from 'react';
import { href, parseRoute, type Route } from './routes.js';

export * from './routes.js';

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
