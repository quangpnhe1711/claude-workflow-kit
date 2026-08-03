import type { NodeStatusView, RunView } from './types.js';

export function nodeStatusView(run: RunView, nodeId: string, nowMs: number, thresholdSeconds: number): NodeStatusView {
  const status = run.nodes[nodeId]?.status ?? 'PENDING';
  if (status !== 'ACTIVE') return status;
  const idleMs = nowMs - Date.parse(run.lastActivityAt);
  return idleMs > thresholdSeconds * 1000 ? 'STALE' : 'ACTIVE';
}

export function secondsSince(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
}

export function ago(iso: string | undefined, nowMs: number): string {
  const seconds = secondsSince(iso, nowMs);
  if (seconds === null) return '—';
  return `${formatDuration(seconds * 1000)} ago`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function elapsed(startedAt: string | undefined, finishedAt: string | undefined, nowMs: number): string {
  if (!startedAt) return '—';
  const end = finishedAt ? Date.parse(finishedAt) : nowMs;
  return formatDuration(end - Date.parse(startedAt));
}

export function clock(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
