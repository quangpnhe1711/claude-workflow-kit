#!/usr/bin/env node
// `cw` is the runtime CLI used by workflow skills and hooks. `cw monitor` is
// the one subcommand that lives in the monitor package.
import { runCwMain } from '@claude-workflow-kit/workflow-core';

const argv = process.argv.slice(2);

if (argv[0] === 'monitor') {
  const { mainMonitor } = await import('@claude-workflow-kit/monitor-server');
  await mainMonitor(argv.slice(1));
} else if (
  argv[0] === 'doctor' ||
  argv[0] === 'init' ||
  argv[0] === 'update' ||
  argv[0] === 'uninstall' ||
  argv[0] === 'app'
) {
  const { main } = await import('../dist/cli.js');
  await main(argv);
} else {
  await runCwMain(argv);
}
