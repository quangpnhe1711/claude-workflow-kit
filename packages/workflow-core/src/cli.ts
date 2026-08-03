import { readFileSync } from 'node:fs';
import { formatConventionReport } from './conventions.js';
import { applyHook, type ClaudeHookPayload } from './hooks.js';
import { WorkflowRuntime } from './runtime.js';
import { TransitionError, derivedRunStatus } from './state-machine.js';
import { WorkflowDefinitionError } from './loader.js';
import { RunNotFoundError, RunStateCorruptError } from './store.js';
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
  cw run start <workflow> [--label "..."] [--id <runId>] [--force]
  cw run complete [--run <id>]        validated: gates, phases, artifacts, end state
  cw run fail [--run <id>] [--message "..."]
  cw run abandon [--run <id>] [--message "..."]
  cw run claim [<runId>] --session <id> [--force] [--reason "..."]
  cw run transfer [<runId>] --to <sessionId> [--reason "..."]
  cw run quarantine-current [--run <id>] --reason "..."   retire an unreadable run
  cw run list [--json]
  cw run show [--run <id>] [--json]

  cw phase enter <node> [--run <id>] [--force]
  cw phase complete [node] [--run <id>]
  cw phase skip <node> [--run <id>] [--message "..."]
  cw phase fail [node] [--run <id>] [--message "..."]
      both enter and complete enforce the declared artifact contract; override
      with --allow-missing-artifacts --reason "<why>" (audited).

  cw gate wait <GATE> [--message "..."]      only from the owning phase
  cw gate pass <GATE>                        needs the owner's evidence on disk
  cw gate override <GATE> --reason "..."     explicit, audited, never implicit
  cw gate fail <GATE> [--message "..."]

  cw note "<message>"
  cw artifact <filename>
  cw status [--json]          compact "where am I" for the current run
  cw review-context [--run <id>] [--json]    canonical pointers for a reviewer
  cw policy [--json]          is the PreToolUse policy actually running?
  cw conventions status [--json]
  cw workflows [--json]
  cw init-runtime             create the runtime directory skeleton

A gate is decided at the phase that owns it, and only once that phase's declared
artifact exists as a non-empty file. While any active run in this project has an
open gate, the PreToolUse hook denies repository writes and arbitrary command
execution; writes of the current phase's declared artifacts stay allowed.

Runtime plumbing (used by Claude Code hooks, not by humans):
  cw hook [--event <HookName>]        reads the hook JSON payload on stdin
  cw event <EVENT_TYPE> [--tool X] [--agent Y] [--message Z]

Global flags:
  --project <dir>   project root (default: nearest directory with a runtime dir)
  --runtime <dir>   runtime directory name (default: from .claude/cw-runtime)
  --session <id>    caller identity, checked against the run's owner
  --json            machine-readable output

Env:
  CW_STRICT=0       relax *graph transitions* only: an illegal phase enter is
                    downgraded to a forced one and recorded as
                    FORCED_TRANSITION. It never passes a gate, never skips
                    artifact validation, never bypasses ownership and never
                    completes a run.
  CW_SESSION        default for --session (CLAUDE_SESSION_ID is also read)
`;

function line(run: RunState, runtime: WorkflowRuntime): string {
  const view = runtime.derivedStatus(run);
  const node = runtime.workflow(run.workflow).nodes.find((n) => n.id === run.currentNode);
  const tool = run.runtime.tool ? ` tool=${run.runtime.tool}` : '';
  return `${run.runId} ${run.workflow} ${view} node=${node?.label ?? run.currentNode} claude=${run.runtime.claude}${tool}`;
}

function printRun(run: RunState, runtime: WorkflowRuntime, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...run,
          derivedStatus: runtime.derivedStatus(run),
          derivedSemantic: runtime.derivedSemantic(run),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${line(run, runtime)}\n`);
  if (runtime.lastWarning) {
    process.stderr.write(`cw: warning: ${runtime.lastWarning}\n`);
    runtime.lastWarning = undefined;
  }
}

function statusReport(runtime: WorkflowRuntime, run: RunState): string {
  const def = runtime.workflow(run.workflow);
  const out: string[] = [];
  out.push(`run       ${run.runId} (${def.label})`);
  out.push(`status    ${runtime.derivedStatus(run)}`);
  if (runtime.derivedSemantic(run) === 'SEMANTIC_LAG') {
    out.push(
      `semantic  SEMANTIC_LAG — Claude is active but no phase transition since ${run.lastSemanticAt}. Emit the phase you are actually in.`,
    );
  }
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
  const unusable = runtime.invalidArtifacts(run.runId);
  if (unusable.length) {
    out.push(`unusable  ${unusable.map((a) => `${a.name} (${a.reason})`).join(', ')}`);
  }
  const missing = runtime.missingArtifacts(run, run.currentNode);
  if (missing.length) out.push(`missing   ${missing.join(', ')} (declared by this phase)`);
  const overridden = Object.entries(run.gateProvenance ?? {}).filter(([, p]) => p.overrideReason);
  if (overridden.length) {
    out.push(`override  ${overridden.map(([g, p]) => `${g}: ${p.overrideReason}`).join('; ')}`);
  }
  const open = Object.entries(run.gates).filter(([, s]) => s !== 'PASSED');
  if (open.length) {
    out.push(
      `mutation  DENIED until ${open.map(([g]) => g).join(' and ')} pass ` +
        `(repository writes and arbitrary commands; declared artifact writes stay allowed)`,
    );
  }
  const health = runtime.policyHealth();
  if (health && health.status !== 'OK') {
    out.push(`policy    ${health.status} — ${health.lastError?.split('\n')[0] ?? 'gate enforcement is not active'}`);
  }
  return out.join('\n');
}

/** Claude Code PreToolUse contract: deny is expressed in stdout JSON, exit 0. */
export function hookDenyPayload(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
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

  const options: { projectRoot?: string; runtimeDir?: string; sessionId?: string } = {};
  if (typeof flags['project'] === 'string') options.projectRoot = flags['project'];
  if (typeof flags['runtime'] === 'string') options.runtimeDir = flags['runtime'];
  const sessionId =
    (typeof flags['session'] === 'string' ? flags['session'] : undefined) ??
    process.env['CW_SESSION'] ??
    process.env['CLAUDE_SESSION_ID'];
  if (sessionId) options.sessionId = sessionId;
  const json = flags['json'] === true || flags['json'] === 'true';
  const explicitForce = flags['force'] === true || flags['force'] === 'true';
  // CW_STRICT relaxes graph transitions and nothing else. It used to imply
  // `--force` for every command, which quietly turned gate validation off.
  const strict = process.env['CW_STRICT'] !== '0';
  const transitionForce = explicitForce || !strict;
  const runFlag = typeof flags['run'] === 'string' ? flags['run'] : undefined;
  const message = typeof flags['message'] === 'string' ? flags['message'] : undefined;
  const reason = typeof flags['reason'] === 'string' ? flags['reason'] : undefined;
  const allowMissingArtifacts =
    flags['allow-missing-artifacts'] === true || flags['allow-missing-artifacts'] === 'true';

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
        const opts: {
          label?: string;
          runId?: string;
          force?: boolean;
          sessionId?: string;
          reason?: string;
        } = {};
        if (typeof flags['label'] === 'string') opts.label = flags['label'];
        if (typeof flags['id'] === 'string') opts.runId = flags['id'];
        if (explicitForce) opts.force = true;
        if (reason) opts.reason = reason;
        if (sessionId) opts.sessionId = sessionId;
        const run = runtime.startRun(workflowId, opts);
        printRun(run, runtime, json);
        return 0;
      }
      if (sub === 'claim') {
        const opts: { runId?: string; sessionId?: string; force?: boolean; reason?: string } = {};
        const target = positional[2] ?? runFlag;
        if (target) opts.runId = target;
        if (sessionId) opts.sessionId = sessionId;
        if (explicitForce) opts.force = true;
        if (reason) opts.reason = reason;
        printRun(runtime.claimRun(opts), runtime, json);
        return 0;
      }
      if (sub === 'transfer') {
        const to = typeof flags['to'] === 'string' ? flags['to'] : undefined;
        if (!to) throw new TransitionError('usage: cw run transfer [<runId>] --to <sessionId>');
        const opts: { runId?: string; to: string; reason?: string } = { to };
        const target = positional[2] ?? runFlag;
        if (target) opts.runId = target;
        if (reason) opts.reason = reason;
        printRun(runtime.transferRun(opts), runtime, json);
        return 0;
      }
      if (sub === 'quarantine-current') {
        if (!reason) {
          throw new TransitionError('usage: cw run quarantine-current --reason "<why>"');
        }
        const result = runtime.quarantineCurrentRun(reason, runFlag);
        if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
          process.stdout.write(
            `quarantined ${result.runId}\n` +
              `  files preserved in ${runtime.paths.runDir(result.runId)}\n` +
              `  marker ${result.marker}\n` +
              `  audit  ${runtime.paths.quarantineLog}\n`,
          );
        }
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
      if (sub === 'abandon') {
        printRun(runtime.abandonRun(withRun(message ? { message } : {})), runtime, json);
        return 0;
      }
      if (sub === 'list' || sub === undefined) {
        const broken: string[] = [];
        const runs: RunState[] = [];
        for (const id of runtime.runIds()) {
          try {
            runs.push(runtime.run(id));
          } catch (error) {
            broken.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                runs: runs.map((r) => ({
                  ...r,
                  derivedStatus: runtime.derivedStatus(r),
                  derivedSemantic: runtime.derivedSemantic(r),
                })),
                unreadable: broken,
              },
              null,
              2,
            )}\n`,
          );
          return broken.length ? 1 : 0;
        }
        const current = runtime.currentRunId();
        for (const run of runs) {
          process.stdout.write(`${run.runId === current ? '*' : ' '} ${line(run, runtime)}\n`);
        }
        for (const item of broken) process.stderr.write(`! unreadable ${item}\n`);
        if (!runs.length && !broken.length) process.stdout.write('no runs\n');
        return broken.length ? 1 : 0;
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
        const opts: { force: boolean; allowMissingArtifacts?: boolean; reason?: string } = {
          force: transitionForce,
        };
        if (allowMissingArtifacts) opts.allowMissingArtifacts = true;
        if (reason) opts.reason = reason;
        printRun(runtime.enterPhase(node, withRun(opts)), runtime, json);
        return 0;
      }
      if (sub === 'complete') {
        const opts: { allowMissingArtifacts?: boolean; reason?: string } = {};
        if (allowMissingArtifacts) opts.allowMissingArtifacts = true;
        if (reason) opts.reason = reason;
        printRun(runtime.completePhase(node, withRun(opts)), runtime, json);
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
        if (explicitForce) {
          throw new TransitionError(
            'cw gate pass has no --force. A deliberate override is a separate, audited command: ' +
              `cw gate override ${gate} --reason "<why>"`,
          );
        }
        printRun(runtime.passGate(gate, withRun({})), runtime, json);
        return 0;
      }
      if (sub === 'override') {
        if (!reason) {
          throw new TransitionError(`usage: cw gate override ${gate} --reason "<why>"`);
        }
        printRun(runtime.overrideGate(gate, reason, withRun({})), runtime, json);
        process.stderr.write(`cw: gate ${gate} was OVERRIDDEN, not earned: ${reason}\n`);
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
      // "no run" and "broken run" need opposite recoveries. Reporting the
      // second as the first is what made a corrupt run silently fork into a
      // duplicate one, so it is a distinct, non-zero outcome.
      let run: RunState | undefined;
      try {
        run = runFlag ? runtime.run(runFlag) : runtime.currentRun();
      } catch (error) {
        if (!(error instanceof RunStateCorruptError)) throw error;
        const detail = {
          status: 'CORRUPT',
          runId: error.runId,
          file: error.file,
          error: error.message,
          recovery: [
            `inspect ${error.file}`,
            `restore it, or retire it without deserialising it: cw run quarantine-current --reason "corrupt state"`,
            'a new run is refused while the pointer still targets the corrupt run',
          ],
        };
        if (json) process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
        else {
          process.stderr.write(
            `cw: active run "${error.runId}" is CORRUPT — this is not "no active run".\n` +
              `    ${error.message}\n` +
              `    recovery: ${detail.recovery.join('\n              ')}\n`,
          );
        }
        return 2;
      }
      if (!run) {
        process.stdout.write(json ? 'null\n' : 'no active run\n');
        return 0;
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ...run,
              derivedStatus: runtime.derivedStatus(run),
              derivedSemantic: runtime.derivedSemantic(run),
              missingArtifacts: runtime.missingArtifacts(run, run.currentNode),
              invalidArtifacts: runtime.invalidArtifacts(run.runId),
              policyHealth: runtime.policyHealth() ?? null,
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      process.stdout.write(`${statusReport(runtime, run)}\n`);
      return 0;
    }

    case 'policy': {
      const health = runtime.policyHealth();
      if (json) {
        process.stdout.write(`${JSON.stringify(health ?? { status: 'UNKNOWN' }, null, 2)}\n`);
        return health && health.status === 'DEGRADED' ? 1 : 0;
      }
      if (!health) {
        process.stdout.write(
          'policy    UNKNOWN — the PreToolUse hook has not evaluated a tool call yet\n',
        );
        return 0;
      }
      process.stdout.write(
        `policy    ${health.status}\n` +
          `enforce   ${health.enforceGates}\n` +
          `last ok   ${health.lastOkAt ?? 'never'}\n` +
          (health.lastError ? `last err  ${health.lastErrorAt} ${health.lastError.split('\n')[0]}\n` : '') +
          `errors    ${health.errorCount}\n`,
      );
      return health.status === 'DEGRADED' ? 1 : 0;
    }

    case 'review-context': {
      // REVIEW-01: reviewer independence cannot be enforced by code, but the
      // reviewer's inputs can be made unambiguous instead of remembered.
      const run = runtime.resolveRun(positional[1] ?? runFlag);
      const def = runtime.workflow(run.workflow);
      const dir = runtime.paths.runDir(run.runId);
      const artifactPath = (name: string) =>
        run.artifacts.includes(name) ? `${dir}/${name}` : `${dir}/${name} (MISSING)`;
      const context = {
        runId: run.runId,
        workflow: def.id,
        runDir: dir,
        currentNode: run.currentNode,
        gates: run.gates,
        spec: artifactPath('business-decision.md'),
        rootCause: def.nodes.some((n) => n.id === 'root-cause') ? artifactPath('root-cause.md') : undefined,
        plan: artifactPath('implementation-plan.md'),
        impactRiskScope: artifactPath('impact-risk-scope.md'),
        testStrategy: artifactPath('test-strategy.md'),
        validation: artifactPath('validation.md'),
        evidence: artifactPath('evidence.md'),
        diffCommand: 'git diff',
        stagedDiffCommand: 'git diff --staged',
        reviewArtifact: `${dir}/review.md`,
        artifacts: run.artifacts,
        invalidArtifacts: run.invalidArtifacts ?? [],
      };
      if (json) {
        process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
        return 0;
      }
      const rows = Object.entries(context).filter(([, v]) => v !== undefined);
      const width = Math.max(...rows.map(([k]) => k.length));
      process.stdout.write(
        `${rows
          .map(([k, v]) => `${k.padEnd(width)}  ${Array.isArray(v) ? v.join(', ') || '(none)' : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join('\n')}\n`,
      );
      return 0;
    }

    case 'conventions': {
      const sub = positional[1] ?? 'status';
      if (sub !== 'status') throw new TransitionError(`unknown: cw conventions ${sub}`);
      const report = runtime.conventions();
      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`${formatConventionReport(report)}\n`);
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
      // Hooks must never break a Claude session: always exit 0. A gate denial
      // is expressed in the hook JSON contract, not in the exit code.
      try {
        const raw = readStdin().trim();
        const payload: ClaudeHookPayload = raw ? (JSON.parse(raw) as ClaudeHookPayload) : {};
        if (typeof flags['event'] === 'string') payload.hook_event_name = flags['event'];
        const result = applyHook(runtime, payload);
        if (result.mutation?.decision === 'deny') {
          process.stdout.write(`${JSON.stringify(hookDenyPayload(result.mutation.reason ?? 'gate not passed'))}\n`);
        } else if (json) {
          process.stdout.write(`${JSON.stringify({ runId: result.runId ?? null })}\n`);
        }
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
    if (error instanceof RunStateCorruptError) {
      process.stderr.write(
        `cw: ${error.message}\n` +
          `    recovery: restore ${error.file}, or retire it: cw run quarantine-current --reason "corrupt state"\n`,
      );
      process.exitCode = 2;
      return;
    }
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
