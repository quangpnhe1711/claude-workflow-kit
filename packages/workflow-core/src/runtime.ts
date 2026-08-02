import { existsSync, mkdirSync } from 'node:fs';
import { loadWorkflow, loadWorkflows } from './loader.js';
import * as sm from './state-machine.js';
import {
  RuntimePaths,
  appendEvent,
  findProjectRoot,
  listArtifacts,
  listRunIds,
  nextRunId,
  readConfig,
  readCurrentRunId,
  readEvents,
  readRun,
  tryReadRun,
  writeCurrentRunId,
  writeRun,
} from './store.js';
import {
  DEFAULT_CONFIG,
  type EventType,
  type KitConfig,
  type RunState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from './types.js';

export interface RuntimeOptions {
  projectRoot?: string;
  runtimeDir?: string;
  now?: () => Date;
}

const SEMANTIC_EVENTS = new Set<EventType>([
  'RUN_STARTED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'NODE_ENTER',
  'NODE_COMPLETE',
  'NODE_SKIP',
  'NODE_FAIL',
  'GATE_WAIT',
  'GATE_PASS',
  'GATE_FAIL',
  'ARTIFACT',
  'NOTE',
]);

export function isSemanticEvent(type: EventType): boolean {
  return SEMANTIC_EVENTS.has(type);
}

/**
 * The only writer of workflow runtime state. Skills and hooks go through this
 * class (via the `cw` CLI); nothing else edits `state.json`.
 */
export class WorkflowRuntime {
  readonly paths: RuntimePaths;
  readonly config: KitConfig;
  private readonly clock: () => Date;

  constructor(options: RuntimeOptions = {}) {
    const runtimeDirName = options.runtimeDir ?? DEFAULT_CONFIG.runtimeDir;
    const root = options.projectRoot ?? findProjectRoot(process.cwd(), runtimeDirName);
    this.paths = new RuntimePaths(root, runtimeDirName);
    this.config = readConfig(this.paths);
    if (!options.runtimeDir && this.config.runtimeDir !== runtimeDirName) {
      this.paths = new RuntimePaths(root, this.config.runtimeDir);
    }
    this.clock = options.now ?? (() => new Date());
  }

  private now(): string {
    return this.clock().toISOString();
  }

  workflows(): Map<string, WorkflowDefinition> {
    return loadWorkflows(this.paths.runtimeDir);
  }

  workflow(id: string): WorkflowDefinition {
    return loadWorkflow(id, this.paths.runtimeDir);
  }

  ensureRuntimeDir(): void {
    mkdirSync(this.paths.runsDir, { recursive: true });
    mkdirSync(this.paths.conventionsDir, { recursive: true });
  }

  runIds(): string[] {
    return listRunIds(this.paths);
  }

  run(runId: string): RunState {
    return readRun(this.paths, runId);
  }

  currentRunId(): string | undefined {
    const id = readCurrentRunId(this.paths);
    if (!id) return undefined;
    return existsSync(this.paths.stateFile(id)) ? id : undefined;
  }

  currentRun(): RunState | undefined {
    const id = this.currentRunId();
    return id ? tryReadRun(this.paths, id) : undefined;
  }

  events(runId: string, limit?: number): WorkflowEvent[] {
    return readEvents(this.paths, runId, limit);
  }

  artifacts(runId: string): string[] {
    return listArtifacts(this.paths, runId);
  }

  private record(run: RunState, type: EventType, extra: Partial<WorkflowEvent> = {}): WorkflowEvent {
    const event: WorkflowEvent = { ts: this.now(), type, runId: run.runId, ...extra };
    appendEvent(this.paths, event);
    return event;
  }

  private persist(run: RunState): RunState {
    run.artifacts = listArtifacts(this.paths, run.runId);
    writeRun(this.paths, run);
    return run;
  }

  // ---- semantic transitions -------------------------------------------------

  startRun(workflowId: string, opts: { label?: string; runId?: string } = {}): RunState {
    const def = this.workflow(workflowId);
    this.ensureRuntimeDir();
    const now = this.now();
    const runId = opts.runId ?? nextRunId(this.paths, workflowId, this.clock());
    const run = sm.initialRunState(def, runId, now, opts.label);
    writeRun(this.paths, run);
    writeCurrentRunId(this.paths, runId);
    const extra: Partial<WorkflowEvent> = { node: run.currentNode };
    if (opts.label) extra.message = opts.label;
    this.record(run, 'RUN_STARTED', extra);
    return this.persist(run);
  }

  /** Resolve a run id argument: explicit id, or the current run. */
  resolveRun(runId?: string): RunState {
    if (runId) return this.run(runId);
    const current = this.currentRun();
    if (!current) {
      throw new sm.TransitionError(
        'no active run. Start one first: cw run start <workflow>',
      );
    }
    return current;
  }

  enterPhase(nodeId: string, opts: { runId?: string; force?: boolean } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    sm.enterNode(def, run, nodeId, this.now(), { force: opts.force ?? false });
    this.record(run, 'NODE_ENTER', { node: nodeId });
    return this.persist(run);
  }

  completePhase(nodeId?: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    const target = nodeId ?? run.currentNode;
    sm.completeNode(def, run, target, this.now());
    this.record(run, 'NODE_COMPLETE', { node: target });
    return this.persist(run);
  }

  skipPhase(nodeId: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    sm.skipNode(def, run, nodeId, this.now());
    const extra: Partial<WorkflowEvent> = { node: nodeId };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'NODE_SKIP', extra);
    return this.persist(run);
  }

  failPhase(nodeId?: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    const target = nodeId ?? run.currentNode;
    sm.failNode(def, run, target, this.now(), opts.message);
    const extra: Partial<WorkflowEvent> = { node: target };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'NODE_FAIL', extra);
    return this.persist(run);
  }

  waitGate(gate: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    sm.waitGate(def, run, gate, this.now());
    const extra: Partial<WorkflowEvent> = { gate, node: run.currentNode };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'GATE_WAIT', extra);
    return this.persist(run);
  }

  passGate(gate: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    sm.passGate(def, run, gate, this.now());
    this.record(run, 'GATE_PASS', { gate, node: run.currentNode });
    return this.persist(run);
  }

  failGate(gate: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    sm.failGate(def, run, gate, this.now(), opts.message);
    const extra: Partial<WorkflowEvent> = { gate };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'GATE_FAIL', extra);
    return this.persist(run);
  }

  note(message: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    run.lastActivityAt = this.now();
    run.updatedAt = run.lastActivityAt;
    this.record(run, 'NOTE', { message, node: run.currentNode });
    return this.persist(run);
  }

  artifact(name: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    run.lastActivityAt = this.now();
    run.updatedAt = run.lastActivityAt;
    this.record(run, 'ARTIFACT', { artifact: name, node: run.currentNode });
    return this.persist(run);
  }

  completeRun(opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const def = this.workflow(run.workflow);
    sm.completeRun(def, run, this.now());
    this.record(run, 'RUN_COMPLETED', { node: run.currentNode });
    this.persist(run);
    if (this.currentRunId() === run.runId) writeCurrentRunId(this.paths, undefined);
    return run;
  }

  failRun(opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    sm.failRun(run, this.now(), opts.message);
    const extra: Partial<WorkflowEvent> = { node: run.currentNode };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'RUN_FAILED', extra);
    this.persist(run);
    if (this.currentRunId() === run.runId) writeCurrentRunId(this.paths, undefined);
    return run;
  }

  // ---- runtime (hook) events -----------------------------------------------

  /**
   * Record a Claude Code lifecycle event against the active run. Returns
   * undefined when there is nothing to attach it to; hooks treat that as a
   * no-op rather than an error.
   */
  recordRuntimeEvent(
    type: EventType,
    payload: Partial<WorkflowEvent> = {},
    opts: { autoStart?: boolean } = {},
  ): RunState | undefined {
    let run = this.currentRun();

    if (!run && opts.autoStart && this.config.autoGenericRun) {
      run = this.startRun('generic', payload.message ? { label: payload.message } : {});
      this.enterPhase('working', { runId: run.runId, force: true });
      run = this.run(run.runId);
    }
    if (!run) return undefined;
    if (run.status === 'COMPLETED' || run.status === 'FAILED') return undefined;

    const event: WorkflowEvent = { ts: this.now(), type, runId: run.runId, ...payload };
    appendEvent(this.paths, event);
    sm.applyRuntimeEvent(run, event);
    return this.persist(run);
  }

  derivedStatus(run: RunState): sm.RunStatusView {
    return sm.derivedRunStatus(run, this.config.stallThresholdSeconds, this.now());
  }
}
