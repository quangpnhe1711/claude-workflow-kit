import { relative, resolve } from 'node:path';
import { parseArgs } from '@claude-workflow-kit/workflow-core';
import { doctor, formatChecks } from './doctor.js';
import { install, uninstall } from './install.js';
import { kitVersion, listPresets } from './paths.js';

const USAGE = `claude-workflow-kit ${kitVersion()}

  claude-workflow-kit init      [options]   install into a project
  claude-workflow-kit update    [options]   refresh managed skills/agents/hooks/rules
  claude-workflow-kit doctor    [options]   verify the installation
  claude-workflow-kit uninstall [options]   remove managed content
  cw monitor                    [options]   start the live workflow monitor

Options:
  --project <dir>    target project root (default: current directory)
  --preset <id>      workflow preset (default: senior-dev; available: ${listPresets().join(', ') || 'none'})
  --runtime <dir>    runtime directory name (default: .ai-workflow)
  --port <n>         monitor port (default: 4173)
  --no-hooks         do not install Claude Code hooks
  --no-claude-md     do not touch CLAUDE.md
  --purge            uninstall only: also delete the runtime directory
  --dry-run          show what would change, write nothing
  --json             machine-readable output

The installer never overwrites unmanaged content: CLAUDE.md gets a marked
block, settings.json hooks are merged, and modified files are backed up as
*.cw-backup.
`;

function flagOff(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[`no-${name}`] === true || flags[name] === 'false';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (!command || command === 'help' || flags['help']) {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'version' || flags['version']) {
    process.stdout.write(`${kitVersion()}\n`);
    return;
  }

  const projectRoot = resolve(typeof flags['project'] === 'string' ? flags['project'] : process.cwd());
  const json = flags['json'] === true;
  const dryRun = flags['dry-run'] === true;
  const runtimeDir = typeof flags['runtime'] === 'string' ? flags['runtime'] : undefined;

  switch (command) {
    case 'init':
    case 'update': {
      const result = install({
        projectRoot,
        mode: command,
        dryRun,
        hooks: !flagOff(flags, 'hooks'),
        claudeMd: !flagOff(flags, 'claude-md'),
        ...(typeof flags['preset'] === 'string' ? { preset: flags['preset'] } : {}),
        ...(runtimeDir ? { runtimeDir } : {}),
        ...(typeof flags['port'] === 'string' ? { monitorPort: Number(flags['port']) } : {}),
      });

      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      const rel = (f: string) => relative(projectRoot, f).replace(/\\/g, '/') || f;
      process.stdout.write(
        `${dryRun ? '[dry run] ' : ''}${command === 'init' ? 'Installed' : 'Updated'} preset "${result.config.preset}" in ${projectRoot}\n\n`,
      );
      for (const file of result.written) process.stdout.write(`  + ${rel(file)}\n`);
      for (const item of result.skipped) process.stdout.write(`  ~ skipped ${item}\n`);
      for (const item of result.conflicts) process.stdout.write(`  ! preserved conflict ${item}\n`);
      for (const file of result.backups) process.stdout.write(`  backup ${rel(file)}\n`);
      process.stdout.write(
        `\nNext:\n  cw monitor            live workflow diagram on http://127.0.0.1:${result.config.monitorPort}\n  claude-workflow-kit doctor\n  /refresh-conventions  bootstrap repository conventions (inside Claude Code)\n`,
      );
      return;
    }

    case 'doctor': {
      const checks = await doctor({
        projectRoot,
        ...(runtimeDir ? { runtimeDir } : {}),
        ...(typeof flags['monitor-url'] === 'string' ? { monitorUrl: flags['monitor-url'] } : {}),
      });
      if (json) {
        process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatChecks(checks)}\n`);
      }
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
      return;
    }

    case 'uninstall': {
      const result = uninstall({
        projectRoot,
        dryRun,
        purge: flags['purge'] === true,
        ...(runtimeDir ? { runtimeDir } : {}),
      });
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${dryRun ? '[dry run] ' : ''}Removed:\n`);
      for (const file of result.removed) process.stdout.write(`  - ${file}\n`);
      for (const file of result.kept) process.stdout.write(`  kept ${file}\n`);
      return;
    }

    default:
      process.stderr.write(`claude-workflow-kit: unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}
