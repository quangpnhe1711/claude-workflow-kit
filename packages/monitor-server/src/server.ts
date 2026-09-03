import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { handleRuntimeRoute } from './runtime-routes.js';
import { MIME, handlePreflight, sendError, sendJson, sendText } from './http.js';
import { summariseRuntime, type ProjectSummary } from './project-summary.js';
import { buildSnapshot, snapshotSignature, type MonitorSnapshot } from './snapshot.js';

export interface MonitorOptions {
  projectRoot?: string;
  runtimeDir?: string;
  port?: number;
  host?: string;
  /** Directory containing the built monitor UI. Omit to run API-only. */
  uiDir?: string;
  /** Poll interval in ms for detecting run changes. */
  pollMs?: number;
}

export interface MonitorHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Serve `uiDir` for any path the API did not claim, falling back to
 * `index.html` so the hash router owns client-side routes. Exported because the
 * app server serves the same bundle from the same directory.
 */
export function createStaticHandler(uiDir?: string): (pathname: string, res: ServerResponse) => boolean {
  const root = uiDir && existsSync(uiDir) ? resolve(uiDir) : undefined;
  return (pathname, res) => {
    if (!root) return false;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = normalize(join(root, relative));
    if (!target.startsWith(root + sep) && target !== join(root, 'index.html')) return false;
    const file = existsSync(target) && statSync(target).isFile() ? target : join(root, 'index.html');
    if (!existsSync(file)) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
    return true;
  };
}

export function createMonitorServer(options: MonitorOptions = {}): MonitorHandle {
  const runtimeOpts: { projectRoot?: string; runtimeDir?: string } = {};
  if (options.projectRoot) runtimeOpts.projectRoot = options.projectRoot;
  if (options.runtimeDir) runtimeOpts.runtimeDir = options.runtimeDir;
  const runtime = new WorkflowRuntime(runtimeOpts);

  const port = options.port ?? runtime.config.monitorPort;
  const host = options.host ?? '127.0.0.1';
  const pollMs = options.pollMs ?? 1000;
  const serveStatic = createStaticHandler(options.uiDir);

  // The UI bundle is the app's, and the app asks for a project list before it
  // renders anything. The monitor answers as a workspace of exactly one project:
  // the same shape, with nothing it cannot honestly offer — no installer, no
  // launcher, and no second project to switch to.
  const soleProjectId = 'local';
  const identity = {
    id: soleProjectId,
    name: basename(runtime.paths.projectRoot) || soleProjectId,
    path: runtime.paths.projectRoot,
    runtimeDir: runtime.config.runtimeDir,
    available: true,
    installed: existsSync(runtime.paths.configFile),
    ...(runtime.config.preset ? { preset: runtime.config.preset } : {}),
    monitorPort: runtime.config.monitorPort,
  };
  const summarise = (): ProjectSummary[] => [summariseRuntime(runtime, identity)];

  const clients = new Set<ServerResponse>();
  let lastSignature = '';

  function broadcast(snapshot: MonitorSnapshot): void {
    const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      client.write(frame);
    }
  }

  const timer = setInterval(() => {
    let snapshot: MonitorSnapshot;
    try {
      snapshot = buildSnapshot(runtime);
    } catch {
      return; // a half-written state.json resolves itself on the next tick
    }
    const signature = snapshotSignature(snapshot);
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (clients.size) broadcast(snapshot);
  }, pollMs);
  timer.unref?.();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (handlePreflight(req, res)) return;

    try {
      if (path === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write(`retry: 2000\n\n`);
        res.write(
          `event: workspace\ndata: ${JSON.stringify({
            projects: summarise(),
            lastProjectId: soleProjectId,
          })}\n\n`,
        );
        res.write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot(runtime))}\n\n`);
        clients.add(res);
        // Keeps proxies and idle sockets from dropping the stream.
        const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
        keepAlive.unref?.();
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return;
      }

      if (path === '/api/app') {
        sendJson(res, 200, {
          ok: true,
          version: null,
          // The monitor cannot install and cannot start a session; saying so is
          // what makes the UI hide those screens instead of offering dead buttons.
          capabilities: { provisioning: false, launcher: false },
          claude: { ok: false, bin: 'claude', detail: 'not available from `cw monitor`; use `cw app`' },
          presets: [],
          lastProjectId: soleProjectId,
          projects: summarise(),
          workspaceFile: runtime.paths.runtimeDir,
        });
        return;
      }

      if (path === '/api/projects') {
        sendJson(res, 200, { projects: summarise(), lastProjectId: soleProjectId });
        return;
      }

      if (path.startsWith('/api')) {
        // `/api/projects/local/...` is the app dialect; `/api/...` is the
        // monitor's original one. Both reach the same table, so scripts written
        // against `cw monitor` keep working while the shared UI speaks projects.
        const projectMatch = /^\/api\/projects\/([^/]+)((?:\/.*)?)$/.exec(path);
        if (projectMatch && decodeURIComponent(projectMatch[1]!) !== soleProjectId) {
          sendJson(res, 404, {
            error: `this is a single-project monitor; it only serves "${soleProjectId}"`,
          });
          return;
        }
        const rest = projectMatch ? (projectMatch[2] ?? '') : path.slice('/api'.length);
        if (projectMatch && (rest === '' || rest === '/')) {
          sendJson(res, 200, { project: summarise()[0] });
          return;
        }
        // The app marks a project as recently opened; there is only one here.
        if (projectMatch && rest === '/open') {
          sendJson(res, 200, { lastProjectId: soleProjectId });
          return;
        }

        const handled = handleRuntimeRoute(runtime, {
          req,
          res,
          url,
          rest,
          port,
          onMutation: () => {
            lastSignature = '';
          },
        });
        if (handled) return;
        sendJson(res, 404, { error: `unknown endpoint ${path}` });
        return;
      }

      if (serveStatic(path, res)) return;
      sendText(res, 404, 'monitor UI is not built. Run: npm run build\n');
    } catch (error) {
      sendError(res, error, 500);
    }
  });

  server.listen(port, host);

  return {
    server,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(timer);
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => done());
        // Idle keep-alive sockets would otherwise hold the close open forever.
        server.closeAllConnections?.();
      }),
  };
}
