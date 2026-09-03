/**
 * Which project the screens below are reading.
 *
 * The id is already in the URL, so this context is not state — it is the route's
 * project handed down so that a panel five levels deep does not need a prop
 * threaded through every component between it and the router. Anything that
 * *changes* the project goes through the URL, never through here.
 */
import { createContext, useContext, type ReactNode } from 'react';

const ProjectContext = createContext<string | null>(null);

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  return <ProjectContext.Provider value={projectId}>{children}</ProjectContext.Provider>;
}

/**
 * Throws rather than returning null: every screen that calls this is only
 * reachable from a project route, and a silent `undefined` here would turn into
 * a request for `/api/projects/undefined/...` that is much harder to read.
 */
export function useProjectId(): string {
  const projectId = useContext(ProjectContext);
  if (!projectId) throw new Error('useProjectId was called outside a project route');
  return projectId;
}
