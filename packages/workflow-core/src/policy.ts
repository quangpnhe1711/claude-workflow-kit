/**
 * Mutation authorisation for Claude Code's PreToolUse hook.
 *
 * The state machine refuses illegal *bookkeeping* transitions. That is not the
 * same as refusing to write code, which is what "NO BUSINESS DECISION = NO
 * CODING" actually promises. This module answers the only question the hook
 * needs: may this tool call change anything right now?
 *
 * Two categories, deliberately separated:
 *
 *   A. repository mutation — source, config, tests, migrations, anything in the
 *      working tree. Denied while any active run in this project still has an
 *      unpassed gate.
 *   B. workflow artifact writes — the evidence a gate itself depends on. Allowed
 *      behind an open gate, but only inside the active run directory, only for a
 *      filename the current phase declares, and only via a normalised path that
 *      cannot escape that directory.
 *
 * Command execution is category A by default: a shell can write any file in one
 * line, so allowing `Bash` behind an open gate would make the gate a suggestion.
 * Behind an open gate only an allowlist of read-only commands survives.
 */
import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  isTerminalRun,
  type KitConfig,
  type MutationDecision,
  type MutationKind,
  type RunState,
  type WorkflowDefinition,
} from './types.js';
import { artifactsOf, findNode, gateOwner, gatesOf } from './state-machine.js';
import { missionMutationBlocks } from './mission.js';

const ALLOW = (kind: MutationKind): MutationDecision => ({ decision: 'allow', kind });

/** Files inside a run directory that only the runtime may write. */
export const RUNTIME_OWNED_FILES = ['state.json', 'events.jsonl', 'QUARANTINED'];

export type PolicyConfig = Pick<
  KitConfig,
  | 'enforceGates'
  | 'mutationTools'
  | 'mutationToolPatterns'
  | 'commandTools'
  | 'readOnlyCommands'
  | 'readOnlyGitSubcommands'
  | 'allowTestCommandsBehindGate'
  | 'testCommands'
>;

/** Gates the run still has to pass before anything may change. */
export function missingGates(def: WorkflowDefinition, run: RunState): string[] {
  return gatesOf(def).filter((gate) => run.gates[gate] !== 'PASSED');
}

/**
 * Everything that currently forbids repository mutation for one run: unpassed
 * topology gates plus mission blocks (paused mission, an open human checkpoint, a
 * required checkpoint never opened, evidence the mission itself called unusable).
 *
 * Mission blocks matter most on the gate-free topologies: without them a Standard
 * or Fast mission could print "checkpoint required" and keep editing anyway.
 */
export function mutationBlocks(def: WorkflowDefinition, run: RunState): string[] {
  const blocks = missingGates(def, run).map((gate) => {
    const owner = gateOwner(def, gate);
    return owner ? `unpassed gate ${gate} (decided at "${owner.id}")` : `unpassed gate ${gate}`;
  });
  if (run.mission) blocks.push(...missionMutationBlocks(run.mission));
  return blocks;
}

/** Artifact filenames the run's current phase is allowed to write right now. */
export function allowedArtifactNames(def: WorkflowDefinition, run: RunState): string[] {
  const current = findNode(def, run.currentNode);
  if (!current) return [];
  const names = new Set(artifactsOf(current));
  // Parked on a waiting node: the phase that owns the gate is still the author
  // of its evidence, so its artifacts stay writable while the user is asked.
  if (current.kind === 'waiting' && current.gate) {
    for (const name of artifactsOf(gateOwner(def, current.gate))) names.add(name);
  }
  return [...names];
}

// ---- tool classification ---------------------------------------------------

// Narrowed on purpose: telemetry classifies tools too, and it has no business
// holding the gate-enforcement half of the policy config.
export function isCommandTool(
  toolName: string | undefined,
  config: Pick<PolicyConfig, 'commandTools'>,
): boolean {
  if (!toolName) return false;
  return config.commandTools.some((t) => t.toLowerCase() === toolName.toLowerCase());
}

export function isFileWriteTool(
  toolName: string | undefined,
  config: Pick<PolicyConfig, 'mutationTools' | 'mutationToolPatterns'>,
): boolean {
  if (!toolName) return false;
  if (config.mutationTools.some((t) => t.toLowerCase() === toolName.toLowerCase())) return true;
  return config.mutationToolPatterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(toolName);
    } catch {
      return false;
    }
  });
}

const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
  'target_file',
  'targetFile',
  'file',
  'filename',
  'destination',
  'dest',
];

/** Every path a write tool call names, including nested edit lists. */
export function targetPaths(toolInput: Record<string, unknown> | undefined): string[] {
  if (!toolInput) return [];
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && item && (PATH_KEYS.includes(key) || key === 'paths')) {
        out.push(item);
        continue;
      }
      if (typeof item === 'object') visit(item, depth + 1);
    }
  };
  visit(toolInput, 0);
  return out;
}

export interface ArtifactWriteContext {
  /** Absolute path of the run directory that may be written. */
  runDir: string;
  /** Filenames the current phase declares. */
  allowed: string[];
}

/**
 * Classify one write target. A path is a workflow artifact only if it resolves
 * to `<runDir>/<declared-name>` exactly — no separators, no `..`, no symlink
 * games through a nested directory.
 */
export function classifyPath(
  rawPath: string,
  projectRoot: string,
  runtimeDir: string,
  artifact: ArtifactWriteContext | undefined,
): MutationKind {
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectRoot, rawPath);
  const inRuntime = abs === runtimeDir || abs.startsWith(runtimeDir + sep);

  if (artifact) {
    const expected = resolve(artifact.runDir, basename(rawPath));
    const declared =
      artifact.allowed.includes(basename(rawPath)) &&
      !RUNTIME_OWNED_FILES.includes(basename(rawPath)) &&
      abs === expected;
    if (declared) return 'workflow-artifact';
  }
  return inRuntime ? 'runtime-internal' : 'repository';
}

// ---- command classification -----------------------------------------------

/** Shell syntax that can create or overwrite a file without naming a program. */
const REDIRECTION = /(^|[^0-9<>&|])>{1,2}|\|&|\$\(|`|<\(|>\(/;

/** Split a command line into the programs it will actually run. */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** argv of one segment, quotes stripped, env-var prefixes dropped. */
export function argvOf(segment: string): string[] {
  const parts = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const argv = parts.map((p) => p.replace(/^["']|["']$/g, ''));
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv.shift();
  return argv;
}

export function programName(arg: string): string {
  const bare = arg.replace(/\\/g, '/').split('/').pop() ?? arg;
  return bare.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/** Multiplexers whose first non-flag argument decides whether this is a write. */
const SUBCOMMANDS: Record<string, string[]> = {
  npm: ['test', 't', 'run', 'run-script', 'ls', 'list', 'why', 'outdated', 'view'],
  pnpm: ['test', 'run', 'ls', 'list', 'why', 'outdated'],
  yarn: ['test', 'run', 'list', 'why'],
  go: ['test', 'build', 'vet', 'list', 'version', 'env'],
  cargo: ['test', 'build', 'check', 'clippy', 'tree', 'metadata'],
  dotnet: ['test', 'build', '--version'],
  bazel: ['test', 'build', 'query'],
};

/** `git branch` is a read *unless* it is asked to change one. */
const GIT_BRANCH_WRITE_FLAGS = ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--set-upstream-to', '--edit-description', '--unset-upstream'];

/**
 * Flags that turn an allowlisted reader into a writer or an arbitrary executor.
 * `find -delete` and `fd -x` are the ones that matter: both read as searches.
 */
const FORBIDDEN_FLAGS: Record<string, string[]> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
  fd: ['-x', '--exec', '-X', '--exec-batch'],
  sort: ['-o', '--output'],
};

export interface CommandVerdict {
  safe: boolean;
  reason?: string;
}

/**
 * Is this command line safe to run while a gate is open? The answer is "no"
 * unless every program it launches is on the allowlist and nothing redirects
 * output into a file. Anything that can execute code (`node -e`, `python -c`,
 * `perl`, `pwsh -Command`) is not on the allowlist, on purpose.
 */
export function evaluateCommand(command: string, config: PolicyConfig): CommandVerdict {
  const text = command.trim();
  if (!text) return { safe: true };
  if (REDIRECTION.test(text)) {
    return { safe: false, reason: 'the command redirects output into a file' };
  }

  for (const segment of commandSegments(text)) {
    const argv = argvOf(segment);
    if (!argv.length) continue;
    const program = programName(argv[0]!);
    const args = argv.slice(1).filter((a) => a !== '');

    const forbidden = FORBIDDEN_FLAGS[program.toLowerCase()];
    if (forbidden) {
      const used = args.find((a) => forbidden.includes(a.split('=')[0]!));
      if (used) {
        return { safe: false, reason: `"${program} ${used}" can write or execute, not just read` };
      }
    }

    const readOnly = config.readOnlyCommands.some((c) => c.toLowerCase() === program.toLowerCase());
    const test =
      config.allowTestCommandsBehindGate &&
      config.testCommands.some((c) => c.toLowerCase() === program.toLowerCase());
    if (!readOnly && !test) {
      return { safe: false, reason: `"${program}" is not on the read-only command allowlist` };
    }

    if (program.toLowerCase() === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!sub || !config.readOnlyGitSubcommands.includes(sub)) {
        return { safe: false, reason: `"git ${sub ?? ''}" is not a read-only git subcommand` };
      }
      if (sub === 'branch' && args.some((a) => GIT_BRANCH_WRITE_FLAGS.includes(a))) {
        return { safe: false, reason: 'this "git branch" call modifies a branch' };
      }
      continue;
    }

    const allowedSubs = SUBCOMMANDS[program.toLowerCase()];
    if (allowedSubs) {
      const sub = args.find((a) => !a.startsWith('-')) ?? args[0];
      if (!sub || !allowedSubs.includes(sub)) {
        return { safe: false, reason: `"${program} ${sub ?? ''}" is not an allowed test/build command` };
      }
    }
  }
  return { safe: true };
}

// ---- semantic `cw` commands ------------------------------------------------

/** `cw` subcommands that change workflow state rather than reporting it. */
const SEMANTIC_CW = new Set([
  'phase',
  'gate',
  'note',
  'artifact',
  'analysis',
  // Mission Control writes the same state file: classification, plan, risks,
  // decisions and checkpoint answers all belong to the owning session's run.
  'mission',
  'checkpoint',
]);
// `start` is here because it either promotes the prompt's generic run or, with
// `--force`, retires a run whose gate may still be closed. Both change state.
const SEMANTIC_RUN_SUBS = new Set([
  'complete',
  'fail',
  'abandon',
  'transfer',
  'quarantine-current',
  'start',
  'escalate',
]);

export interface CwCommandRef {
  /** The `cw` invocation mutates workflow state. */
  semantic: boolean;
  verb: string;
  /** `--run <id>` if given; otherwise the active run is the target. */
  runId?: string;
}

/**
 * Recognise a `cw` invocation inside a command line. Only used to protect one
 * session's run from another session's *semantic* commands — never to authorise
 * anything.
 */
export function classifyCwCommand(command: string): CwCommandRef | undefined {
  for (const segment of commandSegments(command)) {
    const argv = argvOf(segment);
    if (!argv.length) continue;
    if (programName(argv[0]!).toLowerCase() !== 'cw') continue;
    const positional = argv.slice(1).filter((a) => !a.startsWith('--'));
    const verb = positional[0];
    if (!verb) continue;
    const runFlagIndex = argv.findIndex((a) => a === '--run' || a.startsWith('--run='));
    let runId: string | undefined;
    if (runFlagIndex >= 0) {
      const flag = argv[runFlagIndex]!;
      runId = flag.includes('=') ? flag.split('=').slice(1).join('=') : argv[runFlagIndex + 1];
    }
    const semantic =
      SEMANTIC_CW.has(verb) || (verb === 'run' && SEMANTIC_RUN_SUBS.has(positional[1] ?? ''));
    const ref: CwCommandRef = { semantic, verb: positional.slice(0, 2).join(' ') };
    if (runId) ref.runId = runId;
    if (semantic) return ref;
  }
  return undefined;
}

// ---- the decision ---------------------------------------------------------

export interface RunGateContext {
  run: RunState;
  def: WorkflowDefinition;
  /** Absolute run directory. */
  runDir: string;
}

export interface MutationCheckInput {
  toolName: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  config: PolicyConfig;
  /** Every non-terminal run in this project. Gate authority is project-wide. */
  runs: RunGateContext[];
  /** The run the calling session owns, if any. Only its artifacts are writable. */
  sessionRunId?: string | undefined;
  sessionId?: string | undefined;
  projectRoot: string;
  /** Absolute runtime directory. */
  runtimeDir: string;
}

function ownershipDenial(input: MutationCheckInput): MutationDecision | undefined {
  if (!isCommandTool(input.toolName, input.config)) return undefined;
  const command = typeof input.toolInput?.['command'] === 'string' ? (input.toolInput['command'] as string) : '';
  if (!command) return undefined;
  const ref = classifyCwCommand(command);
  if (!ref?.semantic) return undefined;

  const target = ref.runId
    ? input.runs.find((r) => r.run.runId === ref.runId)
    : input.runs.find((r) => r.run.runId === input.sessionRunId) ??
      input.runs.find((r) => !isTerminalRun(r.run.status));
  const owner = target?.run.ownerSessionId;
  if (!target || !owner) return undefined;
  if (!input.sessionId || owner === input.sessionId) return undefined;

  return {
    decision: 'deny',
    kind: 'runtime-internal',
    runId: target.run.runId,
    reason:
      `Blocked by claude-workflow-kit: run ${target.run.runId} is owned by Claude session ${owner}, ` +
      `and "cw ${ref.verb}" changes its workflow state. A second session must not steer another ` +
      `session's run. To take it over deliberately: cw run claim ${target.run.runId} --session <this-session> --force ` +
      `--reason "<why>". Read-only commands (cw status, cw run list) are always allowed.`,
  };
}

function denyReason(
  blocking: RunGateContext[],
  blocks: Map<string, string[]>,
  gateNames: string[],
): string {
  const parts = blocking.map(
    (ctx) => `run ${ctx.run.runId} (${ctx.def.id}): ${(blocks.get(ctx.run.runId) ?? []).join('; ')}`,
  );
  const fix = gateNames.length
    ? `Complete the gate phase, persist its evidence artifact, then run: ` +
      `${gateNames.map((g) => `cw gate pass ${g}`).join(' && ')}. ` +
      `If the decision is not yours to make, run: cw gate wait ${gateNames[0]} --message "<open decision>" and ask the user.`
    : `Inspect it with: cw board. Then resolve the human decision (cw checkpoint resolve <id> ` +
      `--action approve|reject|modify --note "..."), resume a paused mission (cw mission resume), ` +
      `or take the blockers on deliberately (cw mission accept-risk --reason "<why>").`;
  return (
    `Blocked by claude-workflow-kit: ${parts.join(' | ')}. ` +
    `Nothing in the repository may change until those clear. ${fix}`
  );
}

/**
 * Never returns `deny` unless there is a live controlled run with an open gate.
 * No run, no gates, gates passed, enforcement off, terminal run -> allow.
 */
export function evaluateMutation(input: MutationCheckInput): MutationDecision {
  const { config, toolName, toolInput } = input;

  // Session ownership is not a gate question: it holds even with every gate passed.
  const ownership = ownershipDenial(input);
  if (ownership) return ownership;

  if (!config.enforceGates) return ALLOW('none');

  const live = input.runs.filter((r) => !isTerminalRun(r.run.status));
  const missing = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  for (const ctx of live) {
    const gaps = missingGates(ctx.def, ctx.run);
    if (gaps.length) missing.set(ctx.run.runId, gaps);
    const reasons = mutationBlocks(ctx.def, ctx.run);
    if (reasons.length) blocks.set(ctx.run.runId, reasons);
  }
  const blocking = live.filter((ctx) => blocks.has(ctx.run.runId));
  const gateNames = [...new Set([...missing.values()].flat())];

  const command = isCommandTool(toolName, config);
  const write = isFileWriteTool(toolName, config);
  if (!command && !write) return ALLOW('none');
  if (!blocking.length) return ALLOW(command ? 'command' : 'repository');

  const base = denyReason(blocking, blocks, gateNames);

  if (command) {
    const raw = typeof toolInput?.['command'] === 'string' ? (toolInput['command'] as string) : '';
    const verdict = evaluateCommand(raw, config);
    if (verdict.safe) return ALLOW('command');
    return {
      decision: 'deny',
      kind: 'command',
      missingGates: gateNames,
      runId: blocking[0]!.run.runId,
      reason:
        `${base} Command execution is denied while mutation is blocked because ${verdict.reason}; ` +
        `read-only commands (git status/diff/log/show, grep, ls, cat, cw ...) and test/build ` +
        `commands stay available.`,
    };
  }

  // A write: allowed only as this session's own declared run artifact.
  const owned = input.runs.find((r) => r.run.runId === input.sessionRunId) ?? live[0];
  const artifactCtx: ArtifactWriteContext | undefined = owned
    ? { runDir: owned.runDir, allowed: allowedArtifactNames(owned.def, owned.run) }
    : undefined;

  const paths = targetPaths(toolInput);
  const kinds = paths.map((p) => classifyPath(p, input.projectRoot, input.runtimeDir, artifactCtx));
  if (kinds.length && kinds.every((k) => k === 'workflow-artifact')) return ALLOW('workflow-artifact');

  const kind: MutationKind = kinds.includes('repository') || !kinds.length ? 'repository' : 'runtime-internal';
  const detail = !paths.length
    ? 'the call names no file path the policy can verify'
    : kind === 'runtime-internal'
      ? `${paths.join(', ')} is inside the runtime directory but is not an artifact this phase declares` +
        (artifactCtx?.allowed.length
          ? ` (allowed here: ${artifactCtx.allowed.join(', ')})`
          : ' (this phase declares no artifacts)')
      : `${paths.join(', ')} is repository content`;

  return {
    decision: 'deny',
    kind,
    missingGates: gateNames,
    runId: (owned ?? blocking[0]!).run.runId,
    reason:
      `${base} This write was refused because ${detail}. ` +
      `Workflow evidence may still be written to ${owned?.runDir ?? 'the active run directory'} ` +
      `under the filename the current phase declares.`,
  };
}
