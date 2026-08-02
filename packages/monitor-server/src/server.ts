import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { buildRunDetail, buildSnapshot, snapshotSignature, type MonitorSnapshot } from './snapshot.js';

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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
}

export interface MonitorHandle {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function createMonitorServer(options: MonitorOptions = {}): MonitorHandle {
  const runtimeOpts: { projectRoot?: string; runtimeDir?: string } = {};
  if (options.projectRoot) runtimeOpts.projectRoot = options.projectRoot;
  if (options.runtimeDir) runtimeOpts.runtimeDir = options.runtimeDir;
  const runtime = new WorkflowRuntime(runtimeOpts);

  const port = options.port ?? runtime.config.monitorPort;
  const host = options.host ?? '127.0.0.1';
  const pollMs = options.pollMs ?? 1000;
  const uiDir = options.uiDir && existsSync(options.uiDir) ? resolve(options.uiDir) : undefined;

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

  function serveStatic(pathname: string, res: ServerResponse): boolean {
    if (!uiDir) return false;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = normalize(join(uiDir, relative));
    if (!target.startsWith(uiDir + sep) && target !== join(uiDir, 'index.html')) return false;
    const file = existsSync(target) && statSync(target).isFile() ? target : join(uiDir, 'index.html');
    if (!existsSync(file)) return false;
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
    return true;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    try {
      if (path === '/api/health') {
        sendJson(res, 200, { ok: true, projectRoot: runtime.paths.projectRoot });
        return;
      }

      if (path === '/api/state') {
        sendJson(res, 200, buildSnapshot(runtime));
        return;
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
      if (runMatch) {
        sendJson(res, 200, buildRunDetail(runtime, decodeURIComponent(runMatch[1]!)));
        return;
      }

      const artifactMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
      if (artifactMatch) {
        const runId = decodeURIComponent(artifactMatch[1]!);
        const name = decodeURIComponent(artifactMatch[2]!);
        if (name.includes('..') || name.includes('/') || name.includes('\\')) {
          sendJson(res, 400, { error: 'invalid artifact name' });
          return;
        }
        const file = join(runtime.paths.runDir(runId), name);
        if (!existsSync(file)) {
          sendJson(res, 404, { error: 'artifact not found' });
          return;
        }
        sendText(res, 200, readFileSync(file, 'utf8'), MIME[extname(file)] ?? 'text/plain; charset=utf-8');
        return;
      }

      if (path === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        res.write(`retry: 2000\n\n`);
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

      if (path.startsWith('/api/')) {
        sendJson(res, 404, { error: `unknown endpoint ${path}` });
        return;
      }

      if (serveStatic(path, res)) return;
      sendText(res, 404, 'monitor UI is not built. Run: npm run build\n');
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
