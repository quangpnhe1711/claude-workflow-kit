import { create } from 'zustand';
import type { RunDetail, Snapshot } from './types';

interface MonitorState {
  snapshot: Snapshot | null;
  detail: RunDetail | null;
  selectedRunId: string | null;
  selectedNodeId: string | null;
  connection: 'connecting' | 'live' | 'offline';
  /** Ticks once per second so "5s ago" and STALE stay honest without a push. */
  now: number;
  error: string | null;
  setSnapshot: (snapshot: Snapshot) => void;
  setDetail: (detail: RunDetail | null) => void;
  selectRun: (runId: string | null) => void;
  selectNode: (nodeId: string | null) => void;
  setConnection: (connection: MonitorState['connection']) => void;
  setError: (error: string | null) => void;
  tick: () => void;
}

export const useMonitor = create<MonitorState>((set, get) => ({
  snapshot: null,
  detail: null,
  selectedRunId: null,
  selectedNodeId: null,
  connection: 'connecting',
  now: Date.now(),
  error: null,

  setSnapshot: (snapshot) => {
    const { selectedRunId } = get();
    const stillExists = snapshot.runs.some((r) => r.runId === selectedRunId);
    // Follow the active run until the user picks one explicitly.
    const nextSelected = stillExists
      ? selectedRunId
      : snapshot.currentRunId ?? snapshot.runs[0]?.runId ?? null;
    set({ snapshot, selectedRunId: nextSelected, connection: 'live', error: null });
  },

  setDetail: (detail) => set({ detail }),
  selectRun: (runId) => set({ selectedRunId: runId, selectedNodeId: null, detail: null }),
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  setConnection: (connection) => set({ connection }),
  setError: (error) => set({ error }),
  tick: () => set({ now: Date.now() }),
}));

export function selectedRun(state: MonitorState) {
  return state.snapshot?.runs.find((r) => r.runId === state.selectedRunId) ?? null;
}
