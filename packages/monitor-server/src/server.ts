import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WorkflowRuntime } from '@claude-workflow-kit/workflow-core';
import { ActionError, applyBoardAction, type ActionRequest } from './actions.js';
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

const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new ActionError('request body is too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return done({});
      try {
        done(JSON.parse(raw));
      } catch (error) {
        fail(new ActionError(`body is not JSON: ${(error as Error).message}`));
      }
    });
    req.on('error', (error) => fail(error));
  });
}

/**
 * The API is readable from anywhere (`access-control-allow-origin: *`) because it
 * is local telemetry. Writing is different: any web page the user has open could
 * POST to localhost and approve a checkpoint on their behalf. Browsers always send
 * `Origin` on a cross-origin POST and cannot forge it, so a mismatched Origin is
 * refused. A tool with no Origin at all (curl, a script) is not a browser and is
 * allowed — it already has shell access to run `cw` directly.
 */
function sameOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers['origin'];
  if (!origin || Array.isArray(origin)) return !origin;
  try {
    const url = new URL(origin);
    if (url.port && url.port !== String(port)) return false;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
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

      const actionMatch = /^\/api\/runs\/([^/]+)\/actions$/.exec(path);
      if (actionMatch) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'use POST to send a Mission Board action' });
          return;
        }
        if (!sameOrigin(req, port)) {
          sendJson(res, 403, {
            error: 'cross-origin Mission Board actions are refused; open the monitor UI itself',
          });
          return;
        }
        const runId = decodeURIComponent(actionMatch[1]!);
        readJsonBody(req)
          .then((body) => {
            const detail = applyBoardAction(runtime, runId, (body ?? {}) as ActionRequest);
            // The board must not wait a poll tick to show the user their own click.
            lastSignature = '';
            sendJson(res, 200, detail);
          })
          .catch((error: unknown) => {
            const status = error instanceof ActionError ? error.status : 400;
            sendJson(res, status, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
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
