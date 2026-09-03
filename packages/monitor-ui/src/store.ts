import { create } from 'zustand';
import type { AppInfo, ProjectSummary, Snapshot } from './types';

interface MonitorState {
  /** Capabilities and presets, read once at boot. */
  app: AppInfo | null;
  /** The switcher's rows, refreshed by every `workspace` frame. */
  projects: ProjectSummary[];
  lastProjectId: string | null;
  /** Live state of the project being viewed; null while switching or loading. */
  snapshot: Snapshot | null;
  /** Phase selected in the diagram, scoped to the run being viewed. */
  selectedNodeId: string | null;
  /** Which panel the context column shows. */
  sideTab: 'board' | 'phase' | 'context';
  connection: 'connecting' | 'live' | 'offline';
  /** Ticks once per second so "5s ago" and STALE stay honest without a push. */
  now: number;
  error: string | null;
  setApp: (app: AppInfo) => void;
  setWorkspace: (workspace: { projects: ProjectSummary[]; lastProjectId: string | null }) => void;
  setSnapshot: (snapshot: Snapshot) => void;
  clearSnapshot: () => void;
  selectNode: (nodeId: string | null) => void;
  setSideTab: (tab: MonitorState['sideTab']) => void;
  setConnection: (connection: MonitorState['connection']) => void;
  setError: (error: string | null) => void;
  tick: () => void;
}

export const useMonitor = create<MonitorState>((set) => ({
  app: null,
  projects: [],
  lastProjectId: null,
  snapshot: null,
  selectedNodeId: null,
  sideTab: 'board',
  connection: 'connecting',
  now: Date.now(),
  error: null,

  setApp: (app) => set({ app, projects: app.projects, lastProjectId: app.lastProjectId }),
  setWorkspace: ({ projects, lastProjectId }) => set({ projects, lastProjectId }),
  setSnapshot: (snapshot) => set({ snapshot, connection: 'live', error: null }),
  // Switching projects must not leave the previous project's runs on screen for
  // the moment before the first frame of the new one arrives.
  clearSnapshot: () => set({ snapshot: null, selectedNodeId: null }),
  // Clicking a phase means "show me that phase"; the board is one click back.
  selectNode: (nodeId) => set({ selectedNodeId: nodeId, sideTab: nodeId ? 'phase' : 'board' }),
  setSideTab: (sideTab) => set({ sideTab }),
  setConnection: (connection) => set({ connection }),
  setError: (error) => set({ error }),
  tick: () => set({ now: Date.now() }),
}));

/** The row for the project being viewed, if the workspace knows about it. */
export function projectOf(projects: ProjectSummary[], projectId: string | null): ProjectSummary | null {
  if (!projectId) return null;
  return projects.find((p) => p.id === projectId) ?? null;
}
