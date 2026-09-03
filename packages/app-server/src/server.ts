/**
 * The app server: one process, many projects.
 *
 * `cw monitor` binds one `WorkflowRuntime` at boot and serves it at `/api/...`.
 * The app keeps a registry instead and serves each project under
 * `/api/projects/:id/...`, delegating every runtime-scoped route to the same
 * `handleRuntimeRoute` table the monitor uses. The app-only routes are the ones
 * a single-project monitor has no reason to have: the registry itself,
 * provisioning, config, and the task launcher.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildSnapshot,
  createStaticHandler,
  handleRuntimeRoute,
  handlePreflight,
  HttpError,
  readJsonBody,
  sameOrigin,
  sendError,
  sendJson,
  sendText,
  snapshotSignature,
  type MonitorSnapshot,
} from '@claude-workflow-kit/monitor-server';
import { workspaceAnalytics } from './analytics.js';
import { readProjectConfig, validateConfigPatch, writeProjectConfig } from './config.js';
import { claudeAvailable, TaskLauncher, type StartTaskRequest } from './launcher.js';
import { requireProvisioning, type ProvisioningHooks } from './provisioning.js';
import { RuntimeRegistry } from './runtimes.js';
import { projectSummary, summarySignature, type ProjectSummary } from './summary.js';
import { detectRuntimeDir, Workspace } from './workspace.js';

export interface AppOptions {
  port?: number;
  host?: string;
  /** Directory containing the built monitor UI. Omit to run API-only. */
  uiDir?: string;
  /** Registry to serve. Defaults to the one in `~/.claude-workflow-kit`. */
  workspace?: Workspace;
  /** Injected by the CLI; without it the provisioning routes answer 501. */
  provisioning?: ProvisioningHooks;
  pollMs?: number;
}

export interface AppHandle {
  server: Server;
  /** The bound port. Differs from the requested one when port 0 was asked for. */
  port: number;
  url: string;
  workspace: Workspace;
  /** Resolves once the socket is bound and `port`/`url` are final. */
  ready: Promise<AppHandle>;
  close: () => Promise<void>;
}

/** The default app port, distinct from the per-project monitor's 4173. */
export const DEFAULT_APP_PORT = 4600;

interface StreamClient {
  res: ServerResponse;
  projectId: string | null;
  lastSnapshotSignature: string;
}

export function createAppServer(options: AppOptions = {}): AppHandle {
  const workspace = options.workspace ?? new Workspace();
  const registry = new RuntimeRegistry(workspace);
  const launcher = new TaskLauncher();
  const requestedPort = options.port ?? DEFAULT_APP_PORT;
  const host = options.host ?? '127.0.0.1';
  // Port 0 means "any free port" — useful in tests. The same-origin check has to
  // compare against the port actually bound, not the one asked for.
  let port = requestedPort;
  const pollMs = options.pollMs ?? 1000;
  const serveStatic = createStaticHandler(options.uiDir);

  const clients = new Set<StreamClient>();
  let lastWorkspaceSignature = '';

  // Probing for the `claude` binary spawns a process, so it is done once and
  // remembered; the app is not a health checker.
  let claudeProbe: ReturnType<typeof claudeAvailable> | undefined;
  const claudeStatus = () => (claudeProbe ??= claudeAvailable());

  for (const entry of workspace.list()) {
    try {
      launcher.reconcile(entry);
    } catch {
      // an unreadable task log must not stop the app from starting
    }
  }

  function summaries(): ProjectSummary[] {
    return workspace.list().map((entry) => projectSummary(registry, entry));
  }

  function frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Force the next tick to resend everything — used right after a write. */
  function invalidateStream(projectId?: string): void {
    lastWorkspaceSignature = '';
    for (const client of clients) {
      if (!projectId || client.projectId === projectId) client.lastSnapshotSignature = '';
    }
  }

  const timer = setInterval(() => {
    if (!clients.size) return;
    workspace.reload();

    const list = summaries();
    const signature = summarySignature(list);
    if (signature !== lastWorkspaceSignature) {
      lastWorkspaceSignature = signature;
      const payload = frame('workspace', { projects: list, lastProjectId: workspace.lastProjectId });
      for (const client of clients) client.res.write(payload);
    }

    // Only projects someone is actually watching are snapshotted. Building every
    // project's full snapshot each second is what would make the app slow down
    // as the registry grows.
    const watched = new Set(
      [...clients].map((c) => c.projectId).filter((id): id is string => Boolean(id)),
    );
    for (const projectId of watched) {
      let snapshot: MonitorSnapshot;
      try {
        snapshot = buildSnapshot(registry.runtime(projectId));
      } catch {
        continue; // a half-written state.json resolves itself on the next tick
      }
      const snapshotSig = snapshotSignature(snapshot);
      const payload = frame('snapshot', snapshot);
      for (const client of clients) {
        if (client.projectId !== projectId) continue;
        if (client.lastSnapshotSignature === snapshotSig) continue;
        client.lastSnapshotSignature = snapshotSig;
        client.res.write(payload);
      }
    }
  }, pollMs);
  timer.unref?.();

  function openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const requested = url.searchParams.get('project');
    const projectId = requested && workspace.find(requested) ? requested : null;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 2000\n\n');
    res.write(frame('workspace', { projects: summaries(), lastProjectId: workspace.lastProjectId }));

    const client: StreamClient = { res, projectId, lastSnapshotSignature: '' };
    if (projectId) {
      try {
        const snapshot = buildSnapshot(registry.runtime(projectId));
        client.lastSnapshotSignature = snapshotSignature(snapshot);
        res.write(frame('snapshot', snapshot));
      } catch (error) {
        res.write(frame('project-error', { projectId, error: String(error) }));
      }
    }
    clients.add(client);

    // Keeps proxies and idle sockets from dropping the stream.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(client);
    });
  }

  /** Writes are same-origin only, for the reason spelled out in `sameOrigin`. */
  function guardWrite(req: IncomingMessage): void {
    if (sameOrigin(req, port)) return;
    throw new HttpError('cross-origin writes are refused; open the app itself', 403);
  }

  function withBody(
    req: IncomingMessage,
    res: ServerResponse,
    apply: (body: Record<string, unknown>) => unknown,
  ): void {
    readJsonBody(req)
      .then((body) => sendJson(res, 200, apply((body ?? {}) as Record<string, unknown>)))
      .catch((error: unknown) => sendError(res, error));
  }

  function handleAppRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string): boolean {
    const method = req.method ?? 'GET';

    if (path === '/api/app') {
      const claude = claudeStatus();
      sendJson(res, 200, {
        ok: true,
        version: options.provisioning?.kitVersion?.() ?? null,
        capabilities: {
          provisioning: Boolean(options.provisioning),
          launcher: claude.ok,
        },
        claude,
        presets: options.provisioning?.listPresets() ?? [],
        lastProjectId: workspace.lastProjectId ?? null,
        projects: summaries(),
        workspaceFile: workspace.file,
      });
      return true;
    }

    // Across every project — the question a single-project monitor cannot answer.
    if (path === '/api/analytics') {
      sendJson(res, 200, workspaceAnalytics(registry, workspace.list()));
      return true;
    }

    if (path === '/api/projects') {
      if (method === 'GET') {
        sendJson(res, 200, { projects: summaries(), lastProjectId: workspace.lastProjectId ?? null });
        return true;
      }
      if (method === 'POST') {
        guardWrite(req);
        withBody(req, res, (body) => {
          const projectPath = String(body['path'] ?? '').trim();
          if (!projectPath) throw new HttpError('"path" is required');
          const install = body['install'] as Record<string, unknown> | undefined;
          const runtimeDir =
            typeof body['runtimeDir'] === 'string' && body['runtimeDir'].trim()
              ? body['runtimeDir'].trim()
              : undefined;

          // Install first: registering a project whose install then failed would
          // leave a broken row in the registry the user has to clean up by hand.
          let outcome: unknown;
          if (install) {
            outcome = requireProvisioning(options.provisioning).install({
              projectRoot: projectPath,
              ...(typeof install['preset'] === 'string' ? { preset: install['preset'] } : {}),
              ...(runtimeDir ? { runtimeDir } : {}),
              ...(typeof install['monitorPort'] === 'number' ? { monitorPort: install['monitorPort'] } : {}),
              mode: install['mode'] === 'update' ? 'update' : 'init',
              ...(install['dryRun'] === true ? { dryRun: true } : {}),
            });
          }
          const entry = workspace.add({
            path: projectPath,
            ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
            runtimeDir: runtimeDir ?? detectRuntimeDir(projectPath),
          });
          registry.invalidate(entry.id);
          invalidateStream();
          return { project: projectSummary(registry, entry), ...(outcome ? { install: outcome } : {}) };
        });
        return true;
      }
      sendJson(res, 405, { error: 'use GET or POST on /api/projects' });
      return true;
    }

    const projectMatch = /^\/api\/projects\/([^/]+)((?:\/.*)?)$/.exec(path);
    if (!projectMatch) return false;

    const projectId = decodeURIComponent(projectMatch[1]!);
    const rest = projectMatch[2] ?? '';
    const entry = registry.project(projectId);

    // --- app-only, project-scoped routes ---

    if (rest === '' || rest === '/') {
      if (method === 'DELETE') {
        guardWrite(req);
        workspace.remove(projectId);
        registry.invalidate(projectId);
        invalidateStream();
        sendJson(res, 200, { removed: projectId });
        return true;
      }
      if (method === 'PATCH') {
        guardWrite(req);
        withBody(req, res, (body) => {
          if (typeof body['name'] === 'string') workspace.rename(projectId, body['name']);
          invalidateStream();
          return { project: projectSummary(registry, registry.project(projectId)) };
        });
        return true;
      }
      sendJson(res, 200, { project: projectSummary(registry, entry), entry });
      return true;
    }

    if (rest === '/open') {
      guardWrite(req);
      workspace.touch(projectId);
      sendJson(res, 200, { lastProjectId: workspace.lastProjectId });
      return true;
    }

    if (rest === '/config') {
      if (method === 'GET') {
        sendJson(res, 200, readProjectConfig(entry));
        return true;
      }
      if (method === 'PATCH' || method === 'POST') {
        guardWrite(req);
        withBody(req, res, (body) => {
          const view = writeProjectConfig(entry, validateConfigPatch(body));
          registry.invalidate(projectId);
          invalidateStream(projectId);
          return view;
        });
        return true;
      }
      sendJson(res, 405, { error: 'use GET or PATCH on /config' });
      return true;
    }

    if (rest === '/doctor') {
      requireProvisioning(options.provisioning)
        .doctor({ projectRoot: entry.path, runtimeDir: entry.runtimeDir })
        .then((checks) => sendJson(res, 200, { projectId, checks }))
        .catch((error: unknown) => sendError(res, error, 500));
      return true;
    }

    if (rest === '/install') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'use POST on /install' });
        return true;
      }
      guardWrite(req);
      withBody(req, res, (body) => {
        const outcome = requireProvisioning(options.provisioning).install({
          projectRoot: entry.path,
          runtimeDir: entry.runtimeDir,
          ...(typeof body['preset'] === 'string' ? { preset: body['preset'] } : {}),
          ...(typeof body['monitorPort'] === 'number' ? { monitorPort: body['monitorPort'] } : {}),
          mode: body['mode'] === 'init' ? 'init' : 'update',
          ...(body['dryRun'] === true ? { dryRun: true } : {}),
        });
        registry.invalidate(projectId);
        invalidateStream(projectId);
        return { install: outcome, project: projectSummary(registry, entry) };
      });
      return true;
    }

    // --- launcher ---

    if (rest === '/tasks') {
      if (method === 'GET') {
        sendJson(res, 200, { projectId, tasks: launcher.list(entry) });
        return true;
      }
      if (method === 'POST') {
        guardWrite(req);
        const claude = claudeStatus();
        if (!claude.ok) {
          sendJson(res, 503, {
            error: `Claude Code is not runnable as "${claude.bin}": ${claude.detail}`,
          });
          return true;
        }
        withBody(req, res, (body) => {
          const task = launcher.start(entry, body as unknown as StartTaskRequest);
          invalidateStream(projectId);
          return { task };
        });
        return true;
      }
      sendJson(res, 405, { error: 'use GET or POST on /tasks' });
      return true;
    }

    const taskStop = /^\/tasks\/([^/]+)\/stop$/.exec(rest);
    if (taskStop) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'use POST to stop a task' });
        return true;
      }
      guardWrite(req);
      const task = launcher.stop(entry, decodeURIComponent(taskStop[1]!));
      invalidateStream(projectId);
      sendJson(res, 200, { task });
      return true;
    }

    const taskOutput = /^\/tasks\/([^/]+)\/output$/.exec(rest);
    if (taskOutput) {
      const after = Number(url.searchParams.get('after'));
      sendJson(
        res,
        200,
        launcher.output(
          entry,
          decodeURIComponent(taskOutput[1]!),
          Number.isFinite(after) && after > 0 ? after : 0,
        ),
      );
      return true;
    }

    const taskOne = /^\/tasks\/([^/]+)$/.exec(rest);
    if (taskOne) {
      sendJson(res, 200, { task: launcher.get(entry, decodeURIComponent(taskOne[1]!)) });
      return true;
    }

    // --- everything else is the shared per-runtime table ---

    const handled = handleRuntimeRoute(registry.runtime(projectId), {
      req,
      res,
      url,
      rest,
      port,
      onMutation: () => invalidateStream(projectId),
    });
    if (handled) return true;

    sendJson(res, 404, { error: `unknown endpoint ${path}` });
    return true;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (handlePreflight(req, res)) return;

    try {
      if (path === '/api/stream') {
        openStream(req, res, url);
        return;
      }
      if (path.startsWith('/api/')) {
        if (handleAppRoute(req, res, url, path)) return;
        sendJson(res, 404, { error: `unknown endpoint ${path}` });
        return;
      }
      if (serveStatic(path, res)) return;
      sendText(res, 404, 'the app UI is not built. Run: npm run build\n');
    } catch (error) {
      sendError(res, error, 500);
    }
  });

  server.listen(requestedPort, host);

  const handle: AppHandle = {
    server,
    port,
    url: `http://${host}:${port}`,
    workspace,
    ready: new Promise<AppHandle>((done, fail) => {
      server.once('error', fail);
      server.once('listening', () => {
        const address = server.address();
        if (address && typeof address === 'object') port = address.port;
        handle.port = port;
        handle.url = `http://${host}:${port}`;
        done(handle);
      });
    }),
    close: () =>
      new Promise<void>((done) => {
        clearInterval(timer);
        launcher.stopAll();
        for (const client of clients) client.res.end();
        clients.clear();
        server.close(() => done());
        // Idle keep-alive sockets would otherwise hold the close open forever.
        server.closeAllConnections?.();
      }),
  };

  return handle;
}
