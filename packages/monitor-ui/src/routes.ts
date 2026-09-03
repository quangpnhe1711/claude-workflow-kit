/**
 * The route algebra: what a hash means, and what a route looks like as a link.
 *
 * Kept free of React and of `window` so it can be tested directly — the browser
 * bindings live next door in `router.ts`.
 *
 * Every screen except the project list is scoped to one project, and the project
 * id lives in the URL (`#/p/<id>/runs/<runId>`) rather than in a store. That is
 * what makes a link to a run mean the same thing tomorrow, in a second window,
 * or after the app restarts and reopens a different "last project".
 */

export type ProjectScreen = 'dashboard' | 'runs' | 'run' | 'skills' | 'launch' | 'settings';

export type Route =
  | { name: 'projects' }
  | { name: 'dashboard'; projectId: string }
  | { name: 'runs'; projectId: string }
  | { name: 'run'; projectId: string; runId: string }
  | { name: 'skills'; projectId: string }
  | { name: 'launch'; projectId: string }
  | { name: 'settings'; projectId: string };

/** `#/` with no project yet — App decides where to send the user. */
export const NO_ROUTE: Route = { name: 'projects' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] !== 'p' || !parts[1]) return { name: 'projects' };
  const projectId = parts[1];
  const screen = parts[2] ?? 'dashboard';

  switch (screen) {
    case 'runs':
      return parts[3]
        ? { name: 'run', projectId, runId: parts[3] }
        : { name: 'runs', projectId };
    case 'skills':
      return { name: 'skills', projectId };
    case 'launch':
      return { name: 'launch', projectId };
    case 'settings':
      return { name: 'settings', projectId };
    default:
      return { name: 'dashboard', projectId };
  }
}

export function href(route: Route): string {
  if (route.name === 'projects') return '#/projects';
  const base = `#/p/${encodeURIComponent(route.projectId)}`;
  switch (route.name) {
    case 'run':
      return `${base}/runs/${encodeURIComponent(route.runId)}`;
    case 'runs':
      return `${base}/runs`;
    case 'skills':
      return `${base}/skills`;
    case 'launch':
      return `${base}/launch`;
    case 'settings':
      return `${base}/settings`;
    default:
      return `${base}/dashboard`;
  }
}

/** The project a route belongs to, or null for the project list. */
export function routeProjectId(route: Route): string | null {
  return route.name === 'projects' ? null : route.projectId;
}

/** Same screen, different project — what the switcher does. */
export function switchProject(route: Route, projectId: string): Route {
  switch (route.name) {
    case 'projects':
      return { name: 'dashboard', projectId };
    // A run id belongs to one project, so following it across would 404.
    case 'run':
      return { name: 'runs', projectId };
    default:
      return { ...route, projectId };
  }
}
