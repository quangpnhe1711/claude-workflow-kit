/**
 * Derived run summary — the observability read model.
 *
 * Folds `events.jsonl` (append-only, authoritative) into per-run and per-step
 * counts. Nothing here is a source of truth: delete every rollup and the next
 * fold reproduces it exactly. No correctness decision may read it — gates,
 * mutation policy and run completion all keep reading `state.json`.
 *
 * A metric that cannot be measured is `null` with `available: false`, never 0.
 * A zero that means "we did not look" is the one lie an observability tool must
 * not tell.
 */
import type { NodeStatus, RunState, WorkflowEvent } from './types.js';

/** Paths kept per step and per run. Counts stay exact; the lists are a sample. */
export const MAX_PATHS_PER_STEP = 40;
export const MAX_PATHS_PER_RUN = 200;

export interface UsageRollup {
  /** False until a usage source is wired up. The UI must render N/A, not 0. */
  available: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  models: string[];
}

export interface StepRollup {
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs: number | null;
  visits: number;
  events: number;
  toolCalls: number;
  filesRead: number;
  filesChanged: number;
  commands: number;
  tests: number;
  findings: number;
  decisions: number;
  /** Sample of paths this step touched, changed ones first. */
  paths: string[];
}

export interface RunRollup {
  runId: string;
  generatedAt: string;
  /** Bytes of `events.jsonl` folded. The cache key: same size, same rollup. */
  eventBytes: number;
  eventCount: number;
  run: {
    status: string;
    workflow: string;
    startedAt: string;
    finishedAt?: string;
    durationMs: number | null;
  };
  steps: Record<string, StepRollup>;
  files: { read: number; changed: number; readPaths: string[]; changedPaths: string[] };
  commands: { started: number; completed: number; failed: number };
  /**
   * Test *commands*, not test cases. Nothing in the current runtime parses a
   * test report, so case counts stay unavailable rather than guessed.
   */
  tests: {
    commandsStarted: number;
    commandsPassed: number;
    commandsFailed: number;
    cases: { available: boolean; total: number | null; passed: number | null; failed: number | null };
  };
  tools: { calls: number; byName: Record<string, number> };
  gates: { passed: number; failed: number; waits: number; overrides: number };
  governance: {
    decisions: number;
    findings: number;
    checkpointsOpened: number;
    checkpointsResolved: number;
    mutationsDenied: number;
  };
  usage: UsageRollup;
}

function emptyStep(status: NodeStatus = 'PENDING'): StepRollup {
  return {
    status,
    durationMs: null,
    visits: 0,
    events: 0,
    toolCalls: 0,
    filesRead: 0,
    filesChanged: 0,
    commands: 0,
    tests: 0,
    findings: 0,
    decisions: 0,
    paths: [],
  };
}

function unavailableUsage(): UsageRollup {
  return {
    available: false,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    estimatedCost: null,
    models: [],
  };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold events into a rollup. Pure: same events + same run state -> same result,
 * which is what makes "delete it and rebuild" a safe operation.
 */
export function foldRollup(
  run: RunState,
  events: WorkflowEvent[],
  opts: { eventBytes?: number; now?: string } = {},
): RunRollup {
  const steps: Record<string, StepRollup> = {};
  for (const [id, state] of Object.entries(run.nodes)) {
    const step = emptyStep(state.status);
    step.visits = state.visits;
    if (state.startedAt) step.startedAt = state.startedAt;
    if (state.finishedAt) step.finishedAt = state.finishedAt;
    step.durationMs =
      state.durationMs ??
      (state.startedAt && state.finishedAt
        ? Date.parse(state.finishedAt) - Date.parse(state.startedAt)
        : null);
    steps[id] = step;
  }

  const rollup: RunRollup = {
    runId: run.runId,
    generatedAt: opts.now ?? new Date().toISOString(),
    eventBytes: opts.eventBytes ?? 0,
    eventCount: events.length,
    run: {
      status: run.status,
      workflow: run.workflow,
      startedAt: run.startedAt,
      durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
    },
    steps,
    files: { read: 0, changed: 0, readPaths: [], changedPaths: [] },
    commands: { started: 0, completed: 0, failed: 0 },
    tests: {
      commandsStarted: 0,
      commandsPassed: 0,
      commandsFailed: 0,
      cases: { available: false, total: null, passed: null, failed: null },
    },
    tools: { calls: 0, byName: {} },
    gates: { passed: 0, failed: 0, waits: 0, overrides: 0 },
    governance: {
      decisions: 0,
      findings: 0,
      checkpointsOpened: 0,
      checkpointsResolved: 0,
      mutationsDenied: 0,
    },
    usage: unavailableUsage(),
  };
  if (run.finishedAt) rollup.run.finishedAt = run.finishedAt;

  const readPaths = new Set<string>();
  const changedPaths = new Set<string>();
  const usageBySession = new Map<string, Record<string, unknown>>();
  // Telemetry events carry the node they happened in; older events may not, so
  // the fold also tracks the last phase the run was seen entering.
  let currentNode = '';

  const stepOf = (event: WorkflowEvent): StepRollup | undefined => {
    const id = event.node ?? currentNode;
    if (!id) return undefined;
    return (steps[id] ??= emptyStep());
  };

  for (const event of events) {
    if (event.type === 'NODE_ENTER' && event.node) currentNode = event.node;
    const step = stepOf(event);
    if (step) step.events += 1;

    switch (event.type) {
      case 'TOOL_START':
        rollup.tools.calls += 1;
        if (event.tool) rollup.tools.byName[event.tool] = (rollup.tools.byName[event.tool] ?? 0) + 1;
        if (step) step.toolCalls += 1;
        break;
      case 'FILE_READ': {
        const path = typeof event.data?.['path'] === 'string' ? (event.data['path'] as string) : undefined;
        rollup.files.read += 1;
        if (step) step.filesRead += 1;
        if (path) {
          readPaths.add(path);
          if (step && step.paths.length < MAX_PATHS_PER_STEP && !step.paths.includes(path)) {
            step.paths.push(path);
          }
        }
        break;
      }
      case 'FILE_CHANGED': {
        const path = typeof event.data?.['path'] === 'string' ? (event.data['path'] as string) : undefined;
        rollup.files.changed += 1;
        if (step) step.filesChanged += 1;
        if (path) {
          changedPaths.add(path);
          if (step && !step.paths.includes(path)) {
            // A changed file outranks a read one in a truncated sample.
            step.paths.unshift(path);
            if (step.paths.length > MAX_PATHS_PER_STEP) step.paths.pop();
          }
        }
        break;
      }
      case 'COMMAND_STARTED':
        rollup.commands.started += 1;
        if (step) step.commands += 1;
        break;
      case 'COMMAND_COMPLETED':
        rollup.commands.completed += 1;
        break;
      case 'COMMAND_FAILED':
        rollup.commands.failed += 1;
        break;
      case 'TEST_STARTED':
        rollup.tests.commandsStarted += 1;
        if (step) step.tests += 1;
        break;
      case 'TEST_PASSED':
        rollup.tests.commandsPassed += 1;
        break;
      case 'TEST_FAILED':
        rollup.tests.commandsFailed += 1;
        break;
      case 'GATE_PASS':
        rollup.gates.passed += 1;
        break;
      case 'GATE_FAIL':
        rollup.gates.failed += 1;
        break;
      case 'GATE_WAIT':
        rollup.gates.waits += 1;
        break;
      case 'GATE_OVERRIDE':
        rollup.gates.overrides += 1;
        break;
      case 'DECISION_RECORDED':
        rollup.governance.decisions += 1;
        if (step) step.decisions += 1;
        break;
      case 'RISK_RECORDED':
      case 'RISK_ESCALATED':
        rollup.governance.findings += 1;
        if (step) step.findings += 1;
        break;
      case 'CHECKPOINT_OPENED':
        rollup.governance.checkpointsOpened += 1;
        break;
      case 'CHECKPOINT_RESOLVED':
        rollup.governance.checkpointsResolved += 1;
        break;
      case 'MUTATION_DENIED':
        rollup.governance.mutationsDenied += 1;
        break;
      // A usage event is a cumulative snapshot for one Claude session, not a
      // delta: `cw usage sync` can run many times during a run, and summing the
      // snapshots would multiply the bill. Last snapshot per session wins.
      case 'USAGE_RECORDED': {
        const data = event.data ?? {};
        const session = (typeof data['sessionId'] === 'string' && data['sessionId']) || event.sessionId || '-';
        usageBySession.set(session, data);
        break;
      }
      default:
        break;
    }
  }

  if (usageBySession.size) {
    const usage = rollup.usage;
    usage.available = true;
    usage.inputTokens = 0;
    usage.outputTokens = 0;
    usage.cacheReadTokens = 0;
    usage.cacheWriteTokens = 0;
    let costed = 0;
    for (const snapshot of usageBySession.values()) {
      usage.inputTokens += num(snapshot['inputTokens']) ?? 0;
      usage.outputTokens += num(snapshot['outputTokens']) ?? 0;
      usage.cacheReadTokens += num(snapshot['cacheReadTokens']) ?? 0;
      usage.cacheWriteTokens += num(snapshot['cacheWriteTokens']) ?? 0;
      const cost = num(snapshot['estimatedCost']);
      if (cost !== undefined) {
        usage.estimatedCost = (usage.estimatedCost ?? 0) + cost;
        costed += 1;
      }
      const model = snapshot['model'];
      if (typeof model === 'string' && model && !usage.models.includes(model)) usage.models.push(model);
      const models = snapshot['models'];
      if (Array.isArray(models)) {
        for (const item of models) {
          if (typeof item === 'string' && item && !usage.models.includes(item)) usage.models.push(item);
        }
      }
    }
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    // Part-priced usage would read as a complete bill. All or nothing.
    if (costed !== usageBySession.size) usage.estimatedCost = null;
  }
  rollup.files.readPaths = [...readPaths].slice(0, MAX_PATHS_PER_RUN);
  rollup.files.changedPaths = [...changedPaths].slice(0, MAX_PATHS_PER_RUN);
  return rollup;
}
