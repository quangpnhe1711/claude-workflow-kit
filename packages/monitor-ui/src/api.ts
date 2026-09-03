import type {
  Analytics,
  AppInfo,
  BoardAction,
  ConfigView,
  DoctorCheck,
  EventPage,
  InstallOutcome,
  LaunchMode,
  ProjectSummary,
  RunDetail,
  RunPage,
  Snapshot,
  TaskOutputPage,
  TaskRecord,
  WorkspaceAnalytics,
} from './types';

// Same-origin in production (the app server serves this bundle) and proxied in
// dev by vite, so every path is relative.
//
// Every runtime route is project-scoped: `/api/projects/<id>/...`. The
// single-project monitor mounts the same handlers at `/api/...`, so this file
// only has to know the prefix, not two dialects.
function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${init?.method ?? 'GET'} ${input} -> ${res.status}`);
  return body;
}

/** Everything the app knows at boot: projects, capabilities, presets. */
export function fetchApp(): Promise<AppInfo> {
  return json<AppInfo>('/api/app');
}

export function fetchProjects(): Promise<{ projects: ProjectSummary[]; lastProjectId: string | null }> {
  return json('/api/projects');
}

/** Totals across every registered project — what one project's view cannot show. */
export function fetchWorkspaceAnalytics(): Promise<WorkspaceAnalytics> {
  return json<WorkspaceAnalytics>('/api/analytics');
}

export interface AddProjectRequest {
  path: string;
  name?: string;
  runtimeDir?: string;
  /** Present = run the installer as part of adding. */
  install?: { preset?: string; monitorPort?: number; mode?: 'init' | 'update'; dryRun?: boolean };
}

export function addProject(
  request: AddProjectRequest,
): Promise<{ project: ProjectSummary; install?: InstallOutcome }> {
  return json('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/** Unregister. The project's files are never touched. */
export function removeProject(projectId: string): Promise<{ removed: string }> {
  return json(base(projectId), { method: 'DELETE' });
}

export function renameProject(projectId: string, name: string): Promise<{ project: ProjectSummary }> {
  return json(base(projectId), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

/** Remember which project the user was last in, for the next visit. */
export function markProjectOpened(projectId: string): Promise<{ lastProjectId: string | null }> {
  return json(`${base(projectId)}/open`, { method: 'POST' });
}

export function fetchDoctor(projectId: string): Promise<{ projectId: string; checks: DoctorCheck[] }> {
  return json(`${base(projectId)}/doctor`);
}

export function installProject(
  projectId: string,
  options: { mode?: 'init' | 'update'; preset?: string; dryRun?: boolean } = {},
): Promise<{ install: InstallOutcome; project: ProjectSummary }> {
  return json(`${base(projectId)}/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
}

export function fetchConfig(projectId: string): Promise<ConfigView> {
  return json(`${base(projectId)}/config`);
}

export function patchConfig(projectId: string, patch: Record<string, unknown>): Promise<ConfigView> {
  return json(`${base(projectId)}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// --- tasks -------------------------------------------------------------------

export function fetchTasks(projectId: string): Promise<{ projectId: string; tasks: TaskRecord[] }> {
  return json(`${base(projectId)}/tasks`);
}

/**
 * Start a Claude Code session in this project. `confirmUnsafe` is required by
 * the server for any mode that can write to the repository — the UI asks first
 * rather than sending it by default.
 */
export function startTask(
  projectId: string,
  request: { prompt: string; mode: LaunchMode; confirmUnsafe?: boolean },
): Promise<{ task: TaskRecord }> {
  return json(`${base(projectId)}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export function stopTask(projectId: string, taskId: string): Promise<{ task: TaskRecord }> {
  return json(`${base(projectId)}/tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' });
}

/** One page of raw session output, from a byte cursor. */
export function fetchTaskOutput(
  projectId: string,
  taskId: string,
  after = 0,
): Promise<TaskOutputPage> {
  return json(`${base(projectId)}/tasks/${encodeURIComponent(taskId)}/output?after=${after}`);
}

// --- runtime (same shapes as the single-project monitor) ----------------------

export function fetchSnapshot(projectId: string): Promise<Snapshot> {
  return json<Snapshot>(`${base(projectId)}/state`);
}

export function fetchRunDetail(projectId: string, runId: string): Promise<RunDetail> {
  return json<RunDetail>(`${base(projectId)}/runs/${encodeURIComponent(runId)}`);
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
export function fetchRuns(projectId: string, filter: RunFilter = {}): Promise<RunPage> {
  const params = new URLSearchParams();
  if (filter.status?.length) params.set('status', filter.status.join(','));
  if (filter.workflow) params.set('workflow', filter.workflow);
  if (filter.skill) params.set('skill', filter.skill);
  if (filter.q) params.set('q', filter.q);
  if (filter.sort) params.set('sort', filter.sort);
  if (filter.offset) params.set('offset', String(filter.offset));
  if (filter.limit) params.set('limit', String(filter.limit));
  return json<RunPage>(`${base(projectId)}/runs?${params.toString()}`);
}

/** One page of the event log, from a byte cursor. `after: 0` is the beginning. */
export function fetchEvents(
  projectId: string,
  runId: string,
  after = 0,
  limit = 200,
): Promise<EventPage> {
  return json<EventPage>(
    `${base(projectId)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`,
  );
}

export function fetchAnalytics(projectId: string): Promise<Analytics> {
  return json<Analytics>(`${base(projectId)}/analytics`);
}

/**
 * Send a Mission Board action. The server answers with the refreshed detail, so
 * the board shows the result of the click rather than waiting for the next poll.
 * Its error message is the user's message: it explains what the action still needs.
 */
export function postBoardAction(
  projectId: string,
  runId: string,
  action: BoardAction,
): Promise<RunDetail> {
  return json<RunDetail>(`${base(projectId)}/runs/${encodeURIComponent(runId)}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
}

export function artifactUrl(projectId: string, runId: string, name: string): string {
  return `${base(projectId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
}

/**
 * One SSE subscription for the whole app: a `workspace` frame for the switcher,
 * and `snapshot` frames for the project being viewed. Two EventSources would
 * cost two of the six connections a browser allows per origin over HTTP/1.1,
 * and the second would starve the first while a run is busy.
 */
export function subscribe(
  projectId: string | null,
  handlers: {
    onSnapshot: (snapshot: Snapshot) => void;
    onWorkspace: (workspace: { projects: ProjectSummary[]; lastProjectId: string | null }) => void;
    onOpen?: () => void;
    onError?: () => void;
  },
): () => void {
  const source = new EventSource(
    projectId ? `/api/stream?project=${encodeURIComponent(projectId)}` : '/api/stream',
  );

  const on = <T,>(event: string, apply: (value: T) => void) =>
    source.addEventListener(event, (raw) => {
      try {
        apply(JSON.parse((raw as MessageEvent<string>).data) as T);
      } catch {
        // a truncated frame is dropped; the next tick resends the full payload
      }
    });

  on<Snapshot>('snapshot', handlers.onSnapshot);
  on<{ projects: ProjectSummary[]; lastProjectId: string | null }>('workspace', handlers.onWorkspace);
  source.addEventListener('open', () => handlers.onOpen?.());
  source.addEventListener('error', () => handlers.onError?.());

  return () => source.close();
}
