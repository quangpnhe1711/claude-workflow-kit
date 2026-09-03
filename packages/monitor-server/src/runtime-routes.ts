/**
 * Every endpoint that answers from a single project's `WorkflowRuntime`.
 *
 * It is mounted twice: at `/api` by the single-project monitor, and at
 * `/api/projects/:id` by the app server. Keeping one table means a project
 * opened in the app and the same project opened in `cw monitor` can never
 * disagree about what a run looks like.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkflowRuntime, RunQuery } from '@claude-workflow-kit/workflow-core';
import { applyBoardAction, type ActionRequest } from './actions.js';
import { buildAnalytics, buildRunDetail, buildSnapshot } from './snapshot.js';
import { MIME, readJsonBody, sameOrigin, sendError, sendJson, sendText } from './http.js';

export interface RuntimeRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** Path with the mount prefix already removed; `''` or `/state`, `/runs/x/events`… */
  rest: string;
  /** Port the server listens on, for the same-origin check on writes. */
  port: number;
  /** Called after a successful write so the caller can force the next SSE frame. */
  onMutation?: () => void;
}

function parseRunQuery(url: URL): RunQuery {
  const status = url.searchParams.getAll('status').flatMap((v) => v.split(',')).filter(Boolean);
  const query: RunQuery = {};
  if (status.length) query.status = status;
  for (const key of ['workflow', 'skill', 'q', 'since', 'until'] as const) {
    const value = url.searchParams.get(key);
    if (value) query[key] = value;
  }
  const sort = url.searchParams.get('sort');
  if (sort === 'started' || sort === 'duration' || sort === 'updated') query.sort = sort;
  if (url.searchParams.get('order') === 'asc') query.order = 'asc';
  const offset = Number(url.searchParams.get('offset'));
  if (Number.isFinite(offset) && offset > 0) query.offset = offset;
  const limit = Number(url.searchParams.get('limit'));
  if (Number.isFinite(limit) && limit > 0) query.limit = limit;
  return query;
}

/**
 * Handle one runtime-scoped request. Returns false when `rest` names no route
 * here, so the caller can keep looking (static files, app-level endpoints).
 * Throws nothing: failures are written to the response.
 */
export function handleRuntimeRoute(runtime: WorkflowRuntime, ctx: RuntimeRouteContext): boolean {
  const { res, rest, url } = ctx;

  if (rest === '/health') {
    sendJson(res, 200, { ok: true, projectRoot: runtime.paths.projectRoot });
    return true;
  }

  if (rest === '/state') {
    sendJson(res, 200, buildSnapshot(runtime));
    return true;
  }

  // History. Answered from the derived index, so the cost is the page size
  // and not the size of the archive.
  if (rest === '/runs') {
    sendJson(res, 200, runtime.queryRuns(parseRunQuery(url)));
    return true;
  }

  if (rest === '/analytics') {
    sendJson(res, 200, buildAnalytics(runtime));
    return true;
  }

  const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(rest);
  if (eventsMatch) {
    const runId = decodeURIComponent(eventsMatch[1]!);
    const after = Number(url.searchParams.get('after'));
    const limit = Number(url.searchParams.get('limit'));
    sendJson(res, 200, {
      runId,
      ...runtime.eventPage(runId, {
        ...(Number.isFinite(after) && after > 0 ? { after } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
    });
    return true;
  }

  const rollupMatch = /^\/runs\/([^/]+)\/rollup$/.exec(rest);
  if (rollupMatch) {
    sendJson(res, 200, runtime.rollup(decodeURIComponent(rollupMatch[1]!)));
    return true;
  }

  const actionMatch = /^\/runs\/([^/]+)\/actions$/.exec(rest);
  if (actionMatch) {
    if (ctx.req.method !== 'POST') {
      sendJson(res, 405, { error: 'use POST to send a Mission Board action' });
      return true;
    }
    if (!sameOrigin(ctx.req, ctx.port)) {
      sendJson(res, 403, {
        error: 'cross-origin Mission Board actions are refused; open the monitor UI itself',
      });
      return true;
    }
    const runId = decodeURIComponent(actionMatch[1]!);
    readJsonBody(ctx.req)
      .then((body) => {
        const detail = applyBoardAction(runtime, runId, (body ?? {}) as ActionRequest);
        // The board must not wait a poll tick to show the user their own click.
        ctx.onMutation?.();
        sendJson(res, 200, detail);
      })
      .catch((error: unknown) => sendError(res, error));
    return true;
  }

  const runMatch = /^\/runs\/([^/]+)$/.exec(rest);
  if (runMatch) {
    sendJson(res, 200, buildRunDetail(runtime, decodeURIComponent(runMatch[1]!)));
    return true;
  }

  const artifactMatch = /^\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(rest);
  if (artifactMatch) {
    const runId = decodeURIComponent(artifactMatch[1]!);
    const name = decodeURIComponent(artifactMatch[2]!);
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      sendJson(res, 400, { error: 'invalid artifact name' });
      return true;
    }
    const file = join(runtime.paths.runDir(runId), name);
    if (!existsSync(file)) {
      sendJson(res, 404, { error: 'artifact not found' });
      return true;
    }
    sendText(res, 200, readFileSync(file, 'utf8'), MIME[extname(file)] ?? 'text/plain; charset=utf-8');
    return true;
  }

  return false;
}
