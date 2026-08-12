import { create } from 'zustand';
import type { Snapshot } from './types';

interface MonitorState {
  snapshot: Snapshot | null;
  /** Phase selected in the diagram, scoped to the run being viewed. */
  selectedNodeId: string | null;
  /** Which panel the context column shows. */
  sideTab: 'board' | 'phase' | 'context';
  connection: 'connecting' | 'live' | 'offline';
  /** Ticks once per second so "5s ago" and STALE stay honest without a push. */
  now: number;
  error: string | null;
  setSnapshot: (snapshot: Snapshot) => void;
  selectNode: (nodeId: string | null) => void;
  setSideTab: (tab: MonitorState['sideTab']) => void;
  setConnection: (connection: MonitorState['connection']) => void;
  setError: (error: string | null) => void;
  tick: () => void;
}

export const useMonitor = create<MonitorState>((set) => ({
  snapshot: null,
  selectedNodeId: null,
  sideTab: 'board',
  connection: 'connecting',
  now: Date.now(),
  error: null,

  setSnapshot: (snapshot) => set({ snapshot, connection: 'live', error: null }),
  // Clicking a phase means "show me that phase"; the board is one click back.
  selectNode: (nodeId) => set({ selectedNodeId: nodeId, sideTab: nodeId ? 'phase' : 'board' }),
  setSideTab: (sideTab) => set({ sideTab }),
  setConnection: (connection) => set({ connection }),
  setError: (error) => set({ error }),
  tick: () => set({ now: Date.now() }),
}));
