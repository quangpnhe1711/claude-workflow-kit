import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createMonitorServer, type MonitorHandle, type MonitorOptions } from './server.js';

export * from './snapshot.js';
export * from './actions.js';
export * from './http.js';
export * from './runtime-routes.js';
export * from './project-summary.js';
export { createMonitorServer, createStaticHandler } from './server.js';
export type { MonitorOptions, MonitorHandle } from './server.js';

/** Locate the built monitor UI, if the package is installed alongside. */
export function resolveUiDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('@claude-workflow-kit/monitor-ui/package.json');
    const dist = join(dirname(pkg), 'dist');
    return existsSync(dist) ? dist : undefined;
  } catch {
    return undefined;
  }
}

export function startMonitor(options: MonitorOptions = {}): MonitorHandle {
  const uiDir = options.uiDir ?? resolveUiDir();
  return createMonitorServer(uiDir ? { ...options, uiDir } : options);
}

const USAGE = `cw monitor — live workflow monitor

  cw monitor [--project <dir>] [--runtime <dir>] [--port <n>] [--host <h>] [--open]

Serves the workflow diagram and a JSON/SSE API for the project's runtime state.
`;

export async function mainMonitor(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  if (flags['help']) {
    process.stdout.write(USAGE);
    return;
  }

  const options: MonitorOptions = {};
  if (typeof flags['project'] === 'string') options.projectRoot = resolve(flags['project']);
  if (typeof flags['runtime'] === 'string') options.runtimeDir = flags['runtime'];
  if (typeof flags['port'] === 'string') options.port = Number(flags['port']);
  if (typeof flags['host'] === 'string') options.host = flags['host'];
  if (typeof flags['ui'] === 'string') options.uiDir = resolve(flags['ui']);

  const handle = startMonitor(options);
  process.stdout.write(`claude-workflow-kit monitor: ${handle.url}\n`);
  if (!resolveUiDir() && !options.uiDir) {
    process.stdout.write('UI bundle not found; API-only mode (/api/state, /api/stream)\n');
  }

  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive until the server closes.
  await new Promise<void>((done) => handle.server.on('close', () => done()));
}
