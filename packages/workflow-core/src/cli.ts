import { readFileSync } from 'node:fs';
import { applyHook, type ClaudeHookPayload } from './hooks.js';
import { WorkflowRuntime } from './runtime.js';
import { TransitionError, derivedRunStatus } from './state-machine.js';
import { WorkflowDefinitionError } from './loader.js';
import { RunNotFoundError } from './store.js';
import type { EventType, RunState } from './types.js';

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { positional, flags };
}

const HELP = `cw — claude-workflow-kit runtime CLI

Workflow commands (emitted by workflow skills; the CLI owns all state):
  cw run start <workflow> [--label "..."] [--id <runId>]
  cw run complete [--run <id>]
  cw run fail [--run <id>] [--message "..."]
  cw run list [--json]
  cw run show [--run <id>] [--json]

  cw phase enter <node> [--run <id>] [--force]
  cw phase complete [node] [--run <id>]
  cw phase skip <node> [--run <id>] [--message "..."]
  cw phase fail [node] [--run <id>] [--message "..."]

  cw gate wait <GATE> [--message "..."]
  cw gate pass <GATE>
  cw gate fail <GATE> [--message "..."]

  cw note "<message>"
  cw artifact <filename>
  cw status [--json]          compact "where am I" for the current run
  cw workflows [--json]
  cw init-runtime             create the runtime directory skeleton

Runtime plumbing (used by Claude Code hooks, not by humans):
  cw hook [--event <HookName>]        reads the hook JSON payload on stdin
  cw event <EVENT_TYPE> [--tool X] [--agent Y] [--message Z]

Global flags:
  --project <dir>   project root (default: nearest directory with a runtime dir)
  --runtime <dir>   runtime directory name (default: .ai-workflow)
  --json            machine-readable output

Env:
  CW_STRICT=0       downgrade illegal transitions to warnings instead of errors
`;

function line(run: RunState, runtime: WorkflowRuntime): string {
  const view = runtime.derivedStatus(run);
  const node = runtime.workflow(run.workflow).nodes.find((n) => n.id === run.currentNode);
  const tool = run.runtime.tool ? ` tool=${run.runtime.tool}` : '';
  return `${run.runId} ${run.workflow} ${view} node=${node?.label ?? run.currentNode} claude=${run.runtime.claude}${tool}`;
}

function printRun(run: RunState, runtime: WorkflowRuntime, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...run, derivedStatus: runtime.derivedStatus(run) }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${line(run, runtime)}\n`);
}

function statusReport(runtime: WorkflowRuntime, run: RunState): string {
  const def = runtime.workflow(run.workflow);
  const out: string[] = [];
  out.push(`run       ${run.runId} (${def.label})`);
  out.push(`status    ${runtime.derivedStatus(run)}`);
  const current = def.nodes.find((n) => n.id === run.currentNode);
  out.push(`phase     ${current?.label ?? run.currentNode} [${run.nodes[run.currentNode]?.status ?? '?'}]`);
  const gates = Object.entries(run.gates);
  if (gates.length) out.push(`gates     ${gates.map(([g, s]) => `${g}=${s}`).join(' ')}`);
  out.push(`claude    ${run.runtime.claude}${run.runtime.tool ? ` (${run.runtime.tool})` : ''}`);
  const nextIds = def.edges
    .filter((e) => e.from === run.currentNode)
    .map((e) => (e.when ? `${e.to} [${e.when}]` : e.to));
  if (nextIds.length) out.push(`next      ${nextIds.join(', ')}`);
  if (run.artifacts.length) out.push(`artifacts ${run.artifacts.join(', ')}`);
  return out.join('\n');
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (!command || flags['help'] || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const options: { projectRoot?: string; runtimeDir?: string } = {};
  if (typeof flags['project'] === 'string') options.projectRoot = flags['project'];
  if (typeof flags['runtime'] === 'string') options.runtimeDir = flags['runtime'];
  const json = flags['json'] === true || flags['json'] === 'true';
  const strict = process.env['CW_STRICT'] !== '0';
  const force = flags['force'] === true || flags['force'] === 'true' || !strict;
  const runFlag = typeof flags['run'] === 'string' ? flags['run'] : undefined;
  const message = typeof flags['message'] === 'string' ? flags['message'] : undefined;

  const runtime = new WorkflowRuntime(options);

  const withRun = <T extends object>(base: T) =>
    (runFlag ? { ...base, runId: runFlag } : base) as T & { runId?: string };

  switch (command) {
    case 'init-runtime': {
      runtime.ensureRuntimeDir();
      process.stdout.write(`runtime ready at ${runtime.paths.runtimeDir}\n`);
      return 0;
    }

    case 'workflows': {
      const defs = [...runtime.workflows().values()];
      if (json) {
        process.stdout.write(`${JSON.stringify(defs, null, 2)}\n`);
        return 0;
      }
      for (const def of defs) {
        process.stdout.write(`${def.id.padEnd(16)} ${def.label} (${def.nodes.length} nodes)\n`);
      }
      return 0;
    }

    case 'run': {
      const sub = positional[1];
      if (sub === 'start') {
        const workflowId = positional[2];
        if (!workflowId) throw new TransitionError('usage: cw run start <workflow>');
        const opts: { label?: string; runId?: string } = {};
        if (typeof flags['label'] === 'string') opts.label = flags['label'];
        if (typeof flags['id'] === 'string') opts.runId = flags['id'];
        const run = runtime.startRun(workflowId, opts);
        printRun(run, runtime, json);
        return 0;
      }
      if (sub === 'complete') {
        printRun(runtime.completeRun(withRun({})), runtime, json);
        return 0;
      }
      if (sub === 'fail') {
        printRun(runtime.failRun(withRun(message ? { message } : {})), runtime, json);
        return 0;
      }
      if (sub === 'list' || sub === undefined) {
        const runs = runtime.runIds().map((id) => runtime.run(id));
        if (json) {
          process.stdout.write(
            `${JSON.stringify(
              runs.map((r) => ({ ...r, derivedStatus: runtime.derivedStatus(r) })),
              null,
              2,
            )}\n`,
          );
          return 0;
        }
        const current = runtime.currentRunId();
        for (const run of runs) {
          process.stdout.write(`${run.runId === current ? '*' : ' '} ${line(run, runtime)}\n`);
        }
        if (!runs.length) process.stdout.write('no runs\n');
        return 0;
      }
      if (sub === 'show') {
        printRun(runtime.resolveRun(runFlag), runtime, json);
        return 0;
      }
      throw new TransitionError(`unknown: cw run ${sub}`);
    }

    case 'phase': {
      const sub = positional[1];
      const node = positional[2];
      if (sub === 'enter') {
        if (!node) throw new TransitionError('usage: cw phase enter <node>');
        printRun(runtime.enterPhase(node, withRun({ force })), runtime, json);
        return 0;
      }
      if (sub === 'complete') {
        printRun(runtime.completePhase(node, withRun({})), runtime, json);
        return 0;
      }
      if (sub === 'skip') {
        if (!node) throw new TransitionError('usage: cw phase skip <node>');
        printRun(runtime.skipPhase(node, withRun(message ? { message } : {})), runtime, json);
        return 0;
      }
      if (sub === 'fail') {
        printRun(runtime.failPhase(node, withRun(message ? { message } : {})), runtime, json);
        return 0;
      }
      throw new TransitionError(`unknown: cw phase ${sub}`);
    }

    case 'gate': {
      const sub = positional[1];
      const gate = positional[2];
      if (!gate) throw new TransitionError(`usage: cw gate ${sub ?? '<wait|pass|fail>'} <GATE>`);
      if (sub === 'wait') {
        printRun(runtime.waitGate(gate, withRun(message ? { message } : {})), runtime, json);
        return 0;
      }
      if (sub === 'pass') {
        printRun(runtime.passGate(gate, withRun({})), runtime, json);
        return 0;
      }
      if (sub === 'fail') {
        printRun(runtime.failGate(gate, withRun(message ? { message } : {})), runtime, json);
        return 0;
      }
      throw new TransitionError(`unknown: cw gate ${sub}`);
    }

    case 'note': {
      const text = positional.slice(1).join(' ') || message;
      if (!text) throw new TransitionError('usage: cw note "<message>"');
      printRun(runtime.note(text, withRun({})), runtime, json);
      return 0;
    }

    case 'artifact': {
      const name = positional[1];
      if (!name) throw new TransitionError('usage: cw artifact <filename>');
      printRun(runtime.artifact(name, withRun({})), runtime, json);
      return 0;
    }

    case 'status': {
      const run = runtime.currentRun() ?? (runFlag ? runtime.run(runFlag) : undefined);
      if (!run) {
        process.stdout.write(json ? 'null\n' : 'no active run\n');
        return 0;
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ...run, derivedStatus: runtime.derivedStatus(run) }, null, 2)}\n`,
        );
        return 0;
      }
      process.stdout.write(`${statusReport(runtime, run)}\n`);
      return 0;
    }

    case 'event': {
      const type = positional[1] as EventType | undefined;
      if (!type) throw new TransitionError('usage: cw event <EVENT_TYPE>');
      const payload: Record<string, string> = {};
      for (const key of ['tool', 'agent', 'agentId', 'sessionId', 'message', 'node'] as const) {
        const value = flags[key];
        if (typeof value === 'string') payload[key] = value;
      }
      const run = runtime.recordRuntimeEvent(type, payload, { autoStart: true });
      if (!run) {
        process.stdout.write('no active run; event dropped\n');
        return 0;
      }
      printRun(run, runtime, json);
      return 0;
    }

    case 'hook': {
      // Hooks must never break a Claude session: always exit 0.
      try {
        const raw = readStdin().trim();
        const payload: ClaudeHookPayload = raw ? (JSON.parse(raw) as ClaudeHookPayload) : {};
        if (typeof flags['event'] === 'string') payload.hook_event_name = flags['event'];
        const runId = applyHook(runtime, payload);
        if (json) process.stdout.write(`${JSON.stringify({ runId: runId ?? null })}\n`);
      } catch {
        // swallowed on purpose
      }
      return 0;
    }

    default:
      process.stderr.write(`cw: unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

/** Entry point used by the `cw` bin. Maps known errors to a clean message. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await runCli(argv);
  } catch (error) {
    if (
      error instanceof TransitionError ||
      error instanceof WorkflowDefinitionError ||
      error instanceof RunNotFoundError
    ) {
      process.stderr.write(`cw: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export { derivedRunStatus };
