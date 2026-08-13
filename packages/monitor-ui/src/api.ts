import type {
  Analytics,
  BoardAction,
  EventPage,
  RunDetail,
  RunPage,
  SkillGuide,
  SkillGuideEntry,
  Snapshot,
} from './types';

// Same-origin in production (the monitor server serves this bundle) and proxied
// in dev by vite, so every path is relative.

export async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  return (await res.json()) as Snapshot;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(`GET /api/runs/${runId} -> ${res.status}`);
  return (await res.json()) as RunDetail;
}

export interface RunFilter {
  status?: string[];
  workflow?: string;
  skill?: string;
  q?: string;
  sort?: 'started' | 'duration' | 'updated';
  offset?: number;
  limit?: number;
}

/** History, from the derived index. Never loads a full run state. */
export async function fetchRuns(filter: RunFilter = {}): Promise<RunPage> {
  const params = new URLSearchParams();
  if (filter.status?.length) params.set('status', filter.status.join(','));
  if (filter.workflow) params.set('workflow', filter.workflow);
  if (filter.skill) params.set('skill', filter.skill);
  if (filter.q) params.set('q', filter.q);
  if (filter.sort) params.set('sort', filter.sort);
  if (filter.offset) params.set('offset', String(filter.offset));
  if (filter.limit) params.set('limit', String(filter.limit));
  const res = await fetch(`/api/runs?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/runs -> ${res.status}`);
  return (await res.json()) as RunPage;
}

/** One page of the event log, from a byte cursor. `after: 0` is the beginning. */
export async function fetchEvents(runId: string, after = 0, limit = 200): Promise<EventPage> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`GET events -> ${res.status}`);
  return (await res.json()) as EventPage;
}

/** Installed skills without their bodies — the guide's list pane. */
export async function fetchSkills(): Promise<SkillGuide> {
  const res = await fetch('/api/skills');
  if (!res.ok) throw new Error(`GET /api/skills -> ${res.status}`);
  return (await res.json()) as SkillGuide;
}

/** One skill with its full SKILL.md body. */
export async function fetchSkill(name: string): Promise<SkillGuideEntry> {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`GET /api/skills/${name} -> ${res.status}`);
  return (await res.json()) as SkillGuideEntry;
}

export async function fetchAnalytics(): Promise<Analytics> {
  const res = await fetch('/api/analytics');
  if (!res.ok) throw new Error(`GET /api/analytics -> ${res.status}`);
  return (await res.json()) as Analytics;
}

/**
 * Send a Mission Board action. The server answers with the refreshed detail, so
 * the board shows the result of the click rather than waiting for the next poll.
 * Its error message is the user's message: it explains what the action still needs.
 */
export async function postBoardAction(runId: string, action: BoardAction): Promise<RunDetail> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<RunDetail> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `POST action ${action.action} -> ${res.status}`);
  return body as RunDetail;
}

export function artifactUrl(runId: string, name: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
}

/**
 * SSE subscription. EventSource reconnects on its own; we only surface the
 * connection state so the header can say "offline" instead of freezing.
 */
export function subscribe(handlers: {
  onSnapshot: (snapshot: Snapshot) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  const source = new EventSource('/api/stream');

  source.addEventListener('snapshot', (event) => {
    try {
      handlers.onSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
    } catch {
      // a truncated frame is dropped; the next tick resends the full snapshot
    }
  });
  source.addEventListener('open', () => handlers.onOpen?.());
  source.addEventListener('error', () => handlers.onError?.());

  return () => source.close();
}
