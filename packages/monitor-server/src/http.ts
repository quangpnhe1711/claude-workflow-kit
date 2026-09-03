/**
 * The HTTP primitives shared by the single-project monitor server and the
 * multi-project app server. Both speak the same dialect — JSON with no cache,
 * a same-origin guard on writes, a bounded body reader — and the two servers
 * disagreeing about any of it would be a security bug, not a style difference.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error that already knows which status code it deserves. */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
}

/** Turn any thrown value into the response it describes. */
export function sendError(res: ServerResponse, error: unknown, fallbackStatus = 400): void {
  const status = error instanceof HttpError ? error.status : fallbackStatus;
  sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
}

export const MAX_BODY_BYTES = 64 * 1024;

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError('request body is too large', 413));
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
        fail(new HttpError(`body is not JSON: ${(error as Error).message}`));
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
export function sameOrigin(req: IncomingMessage, port: number): boolean {
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

/** CORS preflight. Answered identically by both servers. */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end();
  return true;
}
