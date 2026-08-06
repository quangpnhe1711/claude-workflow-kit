import { readFileSync } from 'node:fs';
import { formatConventionReport } from './conventions.js';
import { applyHook, type ClaudeHookPayload } from './hooks.js';
import { WorkflowRuntime } from './runtime.js';
import { TransitionError, derivedRunStatus } from './state-machine.js';
import { WorkflowDefinitionError } from './loader.js';
import { RunNotFoundError, RunStateCorruptError } from './store.js';
import {
  CHECKPOINT_KINDS,
  COMPLEXITIES,
  CONFIDENCE_DIMENSIONS,
  EVIDENCE_CATEGORIES,
  EVIDENCE_STATUSES,
  MISSION_FLAG_KEYS,
  MISSION_STATES,
  RISK_CATEGORIES,
  RISK_LEVELS,
  TASK_TYPES,
  WORKFLOW_CLASSES,
  formatMissionBoard,
  outputTemplateFor,
  routeMission,
  type CheckpointKind,
  type Complexity,
  type ConfidenceDimension,
  type EvidenceCategory,
  type EvidenceStatus,
  type MissionFlags,
  type MissionState,
  type MissionTaskStatus,
  type RiskCategory,
  type RiskLevel,
  type TaskType,
  type WorkflowClass,
} from './mission.js';
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
  cw run escalate <workflow> --reason "..." [--run <id>]
      keeps the same task/run id and activates only the stricter topology
  cw run complete [--run <id>]        validated: gates, phases, artifacts, end state
  cw run fail [--run <id>] [--message "..."]
  cw run abandon [--run <id>] [--message "..."]
  cw run claim [<runId>] --session <id> [--force] [--reason "..."]
  cw run transfer [<runId>] --to <sessionId> [--reason "..."]
  cw run quarantine-current [--run <id>] --reason "..."   retire an unreadable run
  cw run list [--json]
  cw run show [--run <id>] [--json]

  cw analysis ready --source "path[,path...]" [--run <analysisId>]
      validate the six artifacts, snapshot relevant source, stop at ANALYSIS_READY
  cw analysis approve --solution "..." --scope "..." [--run <analysisId>]
  cw analysis handoff [--run <analysisId>] [--label "..."]
      create a trace-linked feature-change run; never happens automatically
  cw analysis freshness [--run <featureId>]
  cw analysis refresh --source "path[,path...]" --reason "..." [--run <featureId>]

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

Mission Control (the Tech Lead layer over the topology):
  cw mission route --type <taskType> --complexity trivial|low|medium|high
      dry run: which workflow, checkpoints, validation and thresholds apply
  cw mission classify --type <taskType> [--subtypes a,b] --complexity <c>
      [--risk none|low|medium|high|critical] [--flags database-change,permission,...]
      [--class lightning|fast|standard|deep|research] [--reason "..."] [--no-route]
      routes the run: a deeper class escalates the same run id in place
  cw mission plan --objective "..." --scope "a,b" [--out-of-scope "..."]
      [--assumptions ...] [--dependencies ...] [--stop-conditions ...]
      [--success ...] [--required-steps ...] [--skipped-steps ...] [--validation ...]
  cw mission state <MISSION_STATE> [--force] [--message "..."]
  cw mission pause [--reason "..."] | resume | cancel --reason "..."
  cw mission confidence <dimension> <0-100> [--note "..."]
  cw mission evidence <category> <NOT_REQUIRED|MISSING|PARTIAL|SUFFICIENT|CONFLICTING|OUTDATED>
  cw mission risk --category <c> --level <l> --trigger "..." [--id R-001]
      [--evidence "..."] [--probability "..."] [--impact "..."] [--mitigation "..."]
      [--status OPEN|MITIGATED|ACCEPTED|CLOSED] [--decision "..."]
  cw mission decision --decision "..." --reason "..." [--evidence "a;b"]
      [--confidence 87] [--alternatives "a;b"] [--rejected "a;b"] [--impact "..."]
      [--risk medium] [--reversibility "..."] [--approval]
  cw mission task add --epic "..." --title "..." [--weight 3] [--reason "..."]
  cw mission task <taskId> <PENDING|ACTIVE|DONE|SKIPPED|BLOCKED> [--message "..."]
  cw mission offtrack ON_TRACK|OFF_TRACK [--expected "..."] [--actual "..."] [--reason "..."]
  cw mission context [--summary "..."] [--coverage 70] [--questions "a;b"] [--degraded]
  cw mission scope --previous "..." --new "..." --reason "..." [--added "T-004"]
  cw mission deliverable <name> [--not-required] [--reason "..."] [--status DONE] [--location path]
  cw mission action "<what the mission is doing right now>"
  cw mission accept-risk --reason "..." [--blockers "a;b"]   "Proceed Anyway", audited
  cw mission show [--json]
  cw mission template [--type <taskType>]    report template for this task type

  cw checkpoint open <KIND> --summary "..." --decision "..." [--recommend "..."]
      [--alternatives "a;b"] [--evidence "a;b"] [--risk medium] [--impact "..."]
      [--confidence 80]        KIND: PLAN INVESTIGATION ROOT_CAUSE ARCHITECTURE
                               DESIGN HIGH_RISK CODE RELEASE
  cw checkpoint resolve <id> --action approve|reject|modify|cancel [--note "..."]
  cw checkpoint list [--json]
  cw board [--json]           the Mission Board: state, evidence, risk, decisions

A pending blocking checkpoint, a paused mission, a required checkpoint that was
never opened, or evidence the mission itself marked MISSING/CONFLICTING/OUTDATED
denies repository writes exactly like an unpassed gate. Confidence thresholds are
enforced when the implementation phase is entered.

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
  // The published report is the only output a human is expected to open, so it
  // is echoed on the command that creates it, not just in `cw status`.
  if (run.analysis?.status === 'ANALYSIS_READY' && run.analysis.reportDir) {
    process.stdout.write(`report ${run.analysis.reportDir}/\n`);
  }
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
  if (run.mission) {
    const board = runtime.missionBoard(run.runId);
    const classification = run.mission.classification;
    out.push(
      `mission   ${board.missionState}${
        classification
          ? ` — ${classification.workflowClass} ${classification.taskType} (${classification.complexity}/${classification.riskLevel})`
          : ' — not classified'
      }`,
    );
    out.push(`health    ${board.health.health} — ${board.health.reasons[0]}`);
    out.push(`action    ${board.currentAction}`);
    if (board.progress.basis === 'tasks') {
      out.push(
        `progress  ${board.progress.percent}% (${board.progress.completedTasks}/${board.progress.totalTasks} tasks, weighted)`,
      );
    }
    for (const checkpoint of board.pendingCheckpoints) {
      out.push(`waiting   checkpoint ${checkpoint.id} [${checkpoint.kind}]: ${checkpoint.decisionRequired}`);
    }
    if (!board.readiness.ok) {
      out.push(`blocked   ${board.readiness.blockers.join('; ')}`);
    }
    out.push('board     cw board');
  }
  const gates = Object.entries(run.gates);
  if (gates.length) out.push(`gates     ${gates.map(([g, s]) => `${g}=${s}`).join(' ')}`);
  out.push(`claude    ${run.runtime.claude}${run.runtime.tool ? ` (${run.runtime.tool})` : ''}`);
  const nextIds = def.edges
    .filter((e) => e.from === run.currentNode)
    .map((e) => (e.when ? `${e.to} [${e.when}]` : e.to));
  if (nextIds.length) out.push(`next      ${nextIds.join(', ')}`);
  if (run.artifacts.length) out.push(`artifacts ${run.artifacts.join(', ')}`);
  if (run.analysis) out.push(`analysis  ${run.analysis.status}`);
  if (run.analysis?.reportDir) out.push(`report    ${run.analysis.reportDir}/`);
  if (run.sourceAnalysisRunId) {
    out.push(
      `handoff   ${run.sourceAnalysisRunId} freshness=${run.analysisHandoff?.freshness ?? 'UNCHECKED'}`,
    );
  }
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

/** `--scope "a,b; c"` -> ['a', 'b', 'c']. Empty entries are dropped. */
function listFlag(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : [];
}

function normaliseToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Accept `HIGH`, `high` and `high-risk` for the same enum member. A taxonomy the
 * caller has to spell exactly is a taxonomy that gets skipped.
 */
function enumFlag<T extends string>(
  value: string | boolean | undefined,
  allowed: readonly T[],
  what: string,
): T | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const wanted = normaliseToken(value);
  const hit = allowed.find((item) => normaliseToken(item) === wanted);
  if (!hit) throw new TransitionError(`unknown ${what} "${value}" (known: ${allowed.join(', ')})`);
  return hit;
}

function requiredEnum<T extends string>(
  value: string | boolean | undefined,
  allowed: readonly T[],
  what: string,
): T {
  const hit = enumFlag(value, allowed, what);
  if (!hit) throw new TransitionError(`missing ${what} (one of: ${allowed.join(', ')})`);
  return hit;
}

function numberFlag(value: string | boolean | undefined, what: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TransitionError(`${what} must be a number, got "${value}"`);
  return parsed;
}

/** `--flags database-change,permission-or-security` -> MissionFlags. */
function parseFlags(value: string | boolean | undefined): MissionFlags | undefined {
  const items = listFlag(value);
  if (!items) return undefined;
  const flags: MissionFlags = {};
  for (const item of items) {
    const wanted = normaliseToken(item);
    const key = MISSION_FLAG_KEYS.find((candidate) => normaliseToken(candidate) === wanted);
    if (!key) {
      throw new TransitionError(
        `unknown mission flag "${item}" (known: ${MISSION_FLAG_KEYS.join(', ')})`,
      );
    }
    flags[key] = true;
  }
  return flags;
}

function printRoute(
  route: ReturnType<typeof routeMission>,
  taskType: TaskType,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...route, reportTemplate: outputTemplateFor(taskType) }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `workflow    ${route.workflowClass} (${route.topology})\n` +
      `risk        ${route.riskLevel}\n` +
      `effort      ${route.effort}\n` +
      `checkpoints ${route.requiredCheckpoints.join(', ') || 'none required'}\n` +
      `validation  ${route.validation.join(', ') || 'none (analysis only)'}\n` +
      `skipped     ${route.skippedValidation.join(', ') || 'none'}\n` +
      `thresholds  ${Object.entries(route.confidenceThresholds)
        .map(([d, v]) => `${d}>=${v}%`)
        .join(' ')}\n` +
      `template    ${outputTemplateFor(taskType)}\n` +
      `reason      ${route.reason}\n`,
  );
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
  const sources = typeof flags['source'] === 'string'
    ? flags['source'].split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)
    : [];

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
      if (sub === 'escalate') {
        const workflowId = positional[2];
        if (!workflowId) {
          throw new TransitionError(
            'usage: cw run escalate <workflow> --reason "<concrete finding>"',
          );
        }
        if (!reason) throw new TransitionError('cw run escalate requires --reason "<concrete finding>"');
        const opts: { runId?: string; reason: string; label?: string } = { reason };
        if (runFlag) opts.runId = runFlag;
        if (typeof flags['label'] === 'string') opts.label = flags['label'];
        printRun(runtime.escalateRun(workflowId, opts), runtime, json);
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

    case 'analysis': {
      const sub = positional[1];
      if (sub === 'ready') {
        printRun(runtime.markAnalysisReady(withRun({ sources })), runtime, json);
        return 0;
      }
      if (sub === 'approve') {
        const approvedSolution = typeof flags['solution'] === 'string' ? flags['solution'] : undefined;
        const approvedScope = typeof flags['scope'] === 'string' ? flags['scope'] : undefined;
        if (!approvedSolution || !approvedScope) {
          throw new TransitionError(
            'usage: cw analysis approve --solution "<chosen solution>" --scope "<approved scope>"',
          );
        }
        printRun(
          runtime.approveAnalysis(withRun({ approvedSolution, approvedScope })),
          runtime,
          json,
        );
        return 0;
      }
      if (sub === 'handoff') {
        const opts: { runId?: string; label?: string } = {};
        if (runFlag) opts.runId = runFlag;
        if (typeof flags['label'] === 'string') opts.label = flags['label'];
        printRun(runtime.handoffAnalysis(opts), runtime, json);
        return 0;
      }
      if (sub === 'freshness') {
        printRun(runtime.checkAnalysisFreshness(withRun({})), runtime, json);
        return 0;
      }
      if (sub === 'refresh') {
        if (!reason) {
          throw new TransitionError(
            'usage: cw analysis refresh --source "path[,path...]" --reason "<what was re-analyzed>"',
          );
        }
        printRun(runtime.refreshAnalysisHandoff(withRun({ sources, reason })), runtime, json);
        return 0;
      }
      throw new TransitionError(`unknown: cw analysis ${sub ?? '<ready|approve|handoff|freshness|refresh>'}`);
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

    case 'mission': {
      const sub = positional[1];
      const flagValue = (key: string): string | undefined =>
        typeof flags[key] === 'string' ? (flags[key] as string) : undefined;

      if (sub === 'route' || sub === 'classify') {
        const taskType = requiredEnum(flags['type'], TASK_TYPES, 'task type');
        const complexity = requiredEnum(flags['complexity'], COMPLEXITIES, 'complexity');
        const subtypes = (listFlag(flags['subtypes']) ?? []).map((value) =>
          requiredEnum(value, TASK_TYPES, 'task subtype'),
        );
        const riskLevel = enumFlag(flags['risk'], RISK_LEVELS, 'risk level');
        const requestedClass = enumFlag(flags['class'], WORKFLOW_CLASSES, 'workflow class');
        const missionFlags = parseFlags(flags['flags']);

        if (sub === 'route') {
          printRoute(
            routeMission({
              taskType,
              complexity,
              subtypes,
              ...(riskLevel ? { riskLevel } : {}),
              ...(requestedClass ? { requestedClass } : {}),
              ...(missionFlags ? { flags: missionFlags } : {}),
            }),
            taskType,
            json,
          );
          return 0;
        }

        const opts: Parameters<WorkflowRuntime['classifyMission']>[0] = {
          taskType,
          complexity,
          subtypes,
        };
        if (runFlag) opts.runId = runFlag;
        if (riskLevel) opts.riskLevel = riskLevel;
        if (requestedClass) opts.requestedClass = requestedClass;
        if (missionFlags) opts.flags = missionFlags;
        if (reason) opts.reason = reason;
        if (flags['no-route'] === true || flags['no-route'] === 'true') opts.route = false;
        const { run, route } = runtime.classifyMission(opts);
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ run, route, reportTemplate: outputTemplateFor(taskType) }, null, 2)}\n`,
          );
        } else {
          printRoute(route, taskType, false);
          process.stdout.write(`${line(run, runtime)}\n`);
          if (runtime.lastWarning) {
            process.stderr.write(`cw: warning: ${runtime.lastWarning}\n`);
            runtime.lastWarning = undefined;
          }
        }
        return 0;
      }

      if (sub === 'plan') {
        const objective = flagValue('objective');
        const scope = listFlag(flags['scope']);
        if (!objective || !scope?.length) {
          throw new TransitionError('usage: cw mission plan --objective "..." --scope "a,b"');
        }
        const opts: Parameters<WorkflowRuntime['planMission']>[0] = { objective, scope };
        if (runFlag) opts.runId = runFlag;
        const lists: [keyof typeof opts, string][] = [
          ['outOfScope', 'out-of-scope'],
          ['assumptions', 'assumptions'],
          ['dependencies', 'dependencies'],
          ['stopConditions', 'stop-conditions'],
          ['successCriteria', 'success'],
          ['requiredSteps', 'required-steps'],
          ['skippedSteps', 'skipped-steps'],
          ['validation', 'validation'],
        ];
        for (const [key, flag] of lists) {
          const value = listFlag(flags[flag]);
          if (value) (opts as Record<string, unknown>)[key as string] = value;
        }
        printRun(runtime.planMission(opts), runtime, json);
        return 0;
      }

      if (sub === 'state') {
        const state = requiredEnum(positional[2], MISSION_STATES, 'mission state') as MissionState;
        printRun(
          runtime.setMissionState(state, withRun({ force: explicitForce, ...(message ? { message } : {}) })),
          runtime,
          json,
        );
        return 0;
      }

      if (sub === 'pause') {
        printRun(runtime.pauseMission(withRun(reason ? { reason } : {})), runtime, json);
        return 0;
      }
      if (sub === 'resume') {
        printRun(runtime.resumeMission(withRun({})), runtime, json);
        return 0;
      }
      if (sub === 'cancel') {
        if (!reason) throw new TransitionError('usage: cw mission cancel --reason "<why it is withdrawn>"');
        printRun(runtime.cancelMission(withRun({ reason })), runtime, json);
        return 0;
      }

      if (sub === 'confidence') {
        const dimension = requiredEnum(
          positional[2],
          CONFIDENCE_DIMENSIONS,
          'confidence dimension',
        ) as ConfidenceDimension;
        const value = numberFlag(positional[3] ?? flagValue('value'), 'confidence');
        if (value === undefined) {
          throw new TransitionError('usage: cw mission confidence <dimension> <0-100>');
        }
        const note = flagValue('note');
        printRun(
          runtime.setConfidence(dimension, value, withRun(note ? { note } : {})),
          runtime,
          json,
        );
        return 0;
      }

      if (sub === 'evidence') {
        const category = requiredEnum(
          positional[2],
          EVIDENCE_CATEGORIES,
          'evidence category',
        ) as EvidenceCategory;
        const status = requiredEnum(
          positional[3],
          EVIDENCE_STATUSES,
          'evidence status',
        ) as EvidenceStatus;
        const note = flagValue('note');
        printRun(runtime.setEvidence(category, status, withRun(note ? { note } : {})), runtime, json);
        return 0;
      }

      if (sub === 'risk') {
        const category = requiredEnum(flags['category'], RISK_CATEGORIES, 'risk category') as RiskCategory;
        const level = requiredEnum(flags['level'], RISK_LEVELS, 'risk level') as RiskLevel;
        const trigger = flagValue('trigger');
        if (!trigger) throw new TransitionError('cw mission risk requires --trigger "<what raised it>"');
        const opts: Parameters<WorkflowRuntime['recordRisk']>[0] = { category, level, trigger };
        if (runFlag) opts.runId = runFlag;
        for (const [key, flag] of [
          ['id', 'id'],
          ['evidence', 'evidence'],
          ['probability', 'probability'],
          ['impact', 'impact'],
          ['mitigation', 'mitigation'],
          ['requiredDecision', 'decision'],
        ] as const) {
          const value = flagValue(flag);
          if (value) (opts as Record<string, unknown>)[key] = value;
        }
        const status = enumFlag(flags['status'], ['OPEN', 'MITIGATED', 'ACCEPTED', 'CLOSED'] as const, 'risk status');
        if (status) opts.status = status;
        const result = runtime.recordRisk(opts);
        printRun(result.run, runtime, json);
        return 0;
      }

      if (sub === 'decision') {
        const decision = flagValue('decision');
        const decisionReason = flagValue('reason');
        if (!decision || !decisionReason) {
          throw new TransitionError('usage: cw mission decision --decision "..." --reason "..."');
        }
        const opts: Parameters<WorkflowRuntime['recordDecision']>[0] = {
          decision,
          reason: decisionReason,
        };
        if (runFlag) opts.runId = runFlag;
        const id = flagValue('id');
        if (id) opts.id = id;
        const evidence = listFlag(flags['evidence']);
        if (evidence) opts.evidence = evidence;
        const alternatives = listFlag(flags['alternatives']);
        if (alternatives) opts.alternatives = alternatives;
        const rejected = listFlag(flags['rejected']);
        if (rejected) opts.rejected = rejected;
        const confidence = numberFlag(flags['confidence'], 'confidence');
        if (confidence !== undefined) opts.confidence = confidence;
        const impact = flagValue('impact');
        if (impact) opts.impact = impact;
        const risk = enumFlag(flags['risk'], RISK_LEVELS, 'risk level');
        if (risk) opts.risk = risk;
        const reversibility = flagValue('reversibility');
        if (reversibility) opts.reversibility = reversibility;
        if (flags['approval'] === true || flags['approval'] === 'true') opts.approvalRequired = true;
        printRun(runtime.recordDecision(opts).run, runtime, json);
        return 0;
      }

      if (sub === 'task') {
        if (positional[2] === 'add') {
          const epic = flagValue('epic');
          const title = flagValue('title');
          if (!epic || !title) {
            throw new TransitionError('usage: cw mission task add --epic "..." --title "..."');
          }
          const opts: Parameters<WorkflowRuntime['addMissionTask']>[0] = { epic, title };
          if (runFlag) opts.runId = runFlag;
          const id = flagValue('id');
          if (id) opts.id = id;
          const weight = numberFlag(flags['weight'], 'weight');
          if (weight !== undefined) opts.weight = weight;
          if (reason) opts.reason = reason;
          const evidence = flagValue('evidence');
          if (evidence) opts.evidence = evidence;
          const status = enumFlag(
            flags['status'],
            ['PENDING', 'ACTIVE', 'DONE', 'SKIPPED', 'BLOCKED'] as const,
            'task status',
          );
          if (status) opts.status = status;
          printRun(runtime.addMissionTask(opts).run, runtime, json);
          return 0;
        }
        const taskId = positional[2];
        const status = requiredEnum(
          positional[3],
          ['PENDING', 'ACTIVE', 'DONE', 'SKIPPED', 'BLOCKED'] as const,
          'task status',
        ) as MissionTaskStatus;
        if (!taskId) throw new TransitionError('usage: cw mission task <taskId> <STATUS>');
        printRun(
          runtime.updateMissionTask(taskId, status, withRun(message ? { message } : {})),
          runtime,
          json,
        );
        return 0;
      }

      if (sub === 'offtrack') {
        const status = requiredEnum(positional[2], ['ON_TRACK', 'OFF_TRACK'] as const, 'off-track status');
        const opts: Parameters<WorkflowRuntime['setOffTrack']>[0] = { status };
        if (runFlag) opts.runId = runFlag;
        for (const [key, flag] of [
          ['expectedScope', 'expected'],
          ['actualScope', 'actual'],
          ['reason', 'reason'],
          ['recommendation', 'recommendation'],
        ] as const) {
          const value = flagValue(flag);
          if (value) (opts as Record<string, unknown>)[key] = value;
        }
        printRun(runtime.setOffTrack(opts), runtime, json);
        return 0;
      }

      if (sub === 'context') {
        const opts: Parameters<WorkflowRuntime['recordContextSummary']>[0] = {};
        if (runFlag) opts.runId = runFlag;
        const summary = flagValue('summary');
        if (summary) opts.summary = summary;
        const coverage = numberFlag(flags['coverage'], 'coverage');
        if (coverage !== undefined) opts.coverage = coverage;
        const questions = listFlag(flags['questions']);
        if (questions) opts.openQuestions = questions;
        if (flags['degraded'] === true || flags['degraded'] === 'true') opts.degraded = true;
        printRun(runtime.recordContextSummary(opts), runtime, json);
        return 0;
      }

      if (sub === 'scope') {
        const previousScope = flagValue('previous');
        const newScope = flagValue('new');
        if (!previousScope || !newScope || !reason) {
          throw new TransitionError(
            'usage: cw mission scope --previous "..." --new "..." --reason "..."',
          );
        }
        const opts: Parameters<WorkflowRuntime['recordScopeChange']>[0] = {
          previousScope,
          newScope,
          reason,
        };
        if (runFlag) opts.runId = runFlag;
        const added = listFlag(flags['added']);
        if (added) opts.addedTasks = added;
        const removed = listFlag(flags['removed']);
        if (removed) opts.removedTasks = removed;
        const riskChange = flagValue('risk-change');
        if (riskChange) opts.riskChange = riskChange;
        const workflowChange = flagValue('workflow-change');
        if (workflowChange) opts.workflowChange = workflowChange;
        printRun(runtime.recordScopeChange(opts), runtime, json);
        return 0;
      }

      if (sub === 'deliverable') {
        const name = positional[2];
        if (!name) throw new TransitionError('usage: cw mission deliverable <name> [--not-required]');
        const required = !(flags['not-required'] === true || flags['not-required'] === 'true');
        const opts: Parameters<WorkflowRuntime['setDeliverable']>[0] = { name, required };
        if (runFlag) opts.runId = runFlag;
        if (reason) opts.reason = reason;
        const status = enumFlag(flags['status'], ['PENDING', 'DONE', 'SKIPPED'] as const, 'deliverable status');
        if (status) opts.status = status;
        const location = flagValue('location');
        if (location) opts.location = location;
        printRun(runtime.setDeliverable(opts), runtime, json);
        return 0;
      }

      if (sub === 'action') {
        const action = positional.slice(2).join(' ') || message;
        if (!action) throw new TransitionError('usage: cw mission action "<current action>"');
        printRun(runtime.setCurrentAction(action, withRun({})), runtime, json);
        return 0;
      }

      if (sub === 'accept-risk') {
        if (!reason) {
          throw new TransitionError('usage: cw mission accept-risk --reason "<why proceeding is acceptable>"');
        }
        const opts: Parameters<WorkflowRuntime['acceptMissionRisk']>[0] = { reason };
        if (runFlag) opts.runId = runFlag;
        const blockers = listFlag(flags['blockers']);
        if (blockers?.length) opts.blockers = blockers;
        const result = runtime.acceptMissionRisk(opts);
        if (!json) {
          process.stderr.write(
            `cw: accepted ${result.accepted.length} blocker(s) on the user's decision: ${reason}\n`,
          );
        }
        printRun(result.run, runtime, json);
        return 0;
      }

      if (sub === 'template') {
        const taskType = enumFlag(flags['type'], TASK_TYPES, 'task type') as TaskType | undefined;
        const resolved = taskType ?? runtime.mission(runFlag)?.classification?.taskType;
        if (!resolved) {
          throw new TransitionError('no classified mission; pass --type <taskType>');
        }
        process.stdout.write(
          json
            ? `${JSON.stringify({ taskType: resolved, template: outputTemplateFor(resolved) }, null, 2)}\n`
            : `${outputTemplateFor(resolved)}\n`,
        );
        return 0;
      }

      if (sub === 'show' || sub === undefined) {
        const mission = runtime.mission(runFlag);
        if (!mission) {
          process.stdout.write(json ? 'null\n' : 'this run has no mission record yet\n');
          return 0;
        }
        process.stdout.write(
          json
            ? `${JSON.stringify(mission, null, 2)}\n`
            : `${formatMissionBoard(runtime.missionBoard(runFlag))}\n`,
        );
        return 0;
      }
      throw new TransitionError(`unknown: cw mission ${sub}`);
    }

    case 'checkpoint': {
      const sub = positional[1];
      const flagValue = (key: string): string | undefined =>
        typeof flags[key] === 'string' ? (flags[key] as string) : undefined;

      if (sub === 'open') {
        const kind = requiredEnum(positional[2], CHECKPOINT_KINDS, 'checkpoint kind') as CheckpointKind;
        const summary = flagValue('summary');
        const decisionRequired = flagValue('decision');
        if (!summary || !decisionRequired) {
          throw new TransitionError(
            `usage: cw checkpoint open ${kind} --summary "..." --decision "<what the user must decide>"`,
          );
        }
        const opts: Parameters<WorkflowRuntime['openCheckpoint']>[0] = { kind, summary, decisionRequired };
        if (runFlag) opts.runId = runFlag;
        const id = flagValue('id');
        if (id) opts.id = id;
        const recommendation = flagValue('recommend');
        if (recommendation) opts.recommendation = recommendation;
        const alternatives = listFlag(flags['alternatives']);
        if (alternatives) opts.alternatives = alternatives;
        const evidence = listFlag(flags['evidence']);
        if (evidence) opts.evidence = evidence;
        const risk = enumFlag(flags['risk'], RISK_LEVELS, 'risk level');
        if (risk) opts.risk = risk;
        const impact = flagValue('impact');
        if (impact) opts.impact = impact;
        const confidence = numberFlag(flags['confidence'], 'confidence');
        if (confidence !== undefined) opts.confidence = confidence;
        const result = runtime.openCheckpoint(opts);
        if (json) {
          process.stdout.write(`${JSON.stringify(result.checkpoint, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(
          `checkpoint ${result.checkpoint.id} [${kind}] is PENDING — repository writes are blocked\n` +
            `decision   ${decisionRequired}\n` +
            `resolve    cw checkpoint resolve ${result.checkpoint.id} --action approve|reject|modify --note "..."\n`,
        );
        return 0;
      }

      if (sub === 'resolve') {
        const id = positional[2];
        const action = requiredEnum(
          flags['action'],
          ['approve', 'reject', 'modify', 'cancel'] as const,
          'checkpoint action',
        );
        if (!id) throw new TransitionError('usage: cw checkpoint resolve <id> --action approve|reject|modify');
        const opts: Parameters<WorkflowRuntime['resolveCheckpoint']>[1] = { action };
        if (runFlag) opts.runId = runFlag;
        const note = flagValue('note') ?? message;
        if (note) opts.note = note;
        const nextState = enumFlag(flags['state'], MISSION_STATES, 'mission state');
        if (nextState) opts.nextState = nextState;
        const result = runtime.resolveCheckpoint(id, opts);
        if (json) {
          process.stdout.write(`${JSON.stringify(result.checkpoint, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(
          `checkpoint ${id} ${result.checkpoint.status}; mission state ${result.run.mission?.state}\n`,
        );
        return 0;
      }

      if (sub === 'list' || sub === undefined) {
        const mission = runtime.mission(runFlag);
        const checkpoints = mission?.checkpoints ?? [];
        if (json) {
          process.stdout.write(`${JSON.stringify(checkpoints, null, 2)}\n`);
          return 0;
        }
        if (!checkpoints.length) {
          process.stdout.write('no checkpoints\n');
          return 0;
        }
        for (const checkpoint of checkpoints) {
          process.stdout.write(
            `${checkpoint.id.padEnd(8)} ${checkpoint.kind.padEnd(14)} ${checkpoint.status.padEnd(10)} ${checkpoint.decisionRequired}\n`,
          );
        }
        return 0;
      }
      throw new TransitionError(`unknown: cw checkpoint ${sub}`);
    }

    case 'board': {
      const board = runtime.missionBoard(runFlag);
      process.stdout.write(json ? `${JSON.stringify(board, null, 2)}\n` : `${formatMissionBoard(board)}\n`);
      return 0;
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
              missionBoard: run.mission ? runtime.missionBoard(run.runId) : null,
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
      const linkedAnalysis = run.sourceAnalysisRunId
        ? runtime.paths.runDir(run.sourceAnalysisRunId)
        : undefined;
      const context = {
        runId: run.runId,
        workflow: def.id,
        runDir: dir,
        currentNode: run.currentNode,
        gates: run.gates,
        sourceAnalysisRunId: run.sourceAnalysisRunId,
        sourceAnalysisDir: linkedAnalysis,
        analysisFreshness: run.analysisHandoff?.freshness,
        spec: run.sourceAnalysisRunId
          ? artifactPath('recommended-solution.md')
          : artifactPath('business-decision.md'),
        rootCause: def.nodes.some((n) => n.id === 'root-cause') ? artifactPath('root-cause.md') : undefined,
        plan: artifactPath('implementation-plan.md'),
        impactRiskScope: run.sourceAnalysisRunId
          ? artifactPath('impact-analysis.md')
          : artifactPath('impact-risk-scope.md'),
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
