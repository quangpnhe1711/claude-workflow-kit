import type { BoardAction, RunDetail, Snapshot } from './types';

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
