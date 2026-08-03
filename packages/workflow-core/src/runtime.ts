import { existsSync, mkdirSync } from 'node:fs';
import { loadWorkflow, loadWorkflows } from './loader.js';
import * as sm from './state-machine.js';
import { inspectConventions, type ConventionReport } from './conventions.js';
import { evaluateMutation, missingGates, type RunGateContext as PolicyRunContext } from './policy.js';
import {
  RunStateCorruptError,
  RuntimePaths,
  appendEvent,
  findProjectRoot,
  isQuarantined,
  listRunIds,
  nextRunId,
  quarantineRun,
  readConfig,
  readCurrentRunId,
  readEvents,
  readPolicyHealth,
  readRun,
  readSessions,
  recordPolicyHealth,
  resolveRuntimeDirName,
  scanArtifacts,
  tryReadRun,
  writeCurrentRunId,
  writeRun,
  writeSessions,
} from './store.js';
import {
  DEFAULT_CONFIG,
  isTerminalRun,
  type EventType,
  type InvalidArtifact,
  type KitConfig,
  type MutationDecision,
  type PolicyHealth,
  type RunState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from './types.js';

export interface RuntimeOptions {
  projectRoot?: string;
  runtimeDir?: string;
  now?: () => Date;
  /**
   * Identity of the caller for ownership checks on semantic commands. The CLI
   * fills it from `--session` / `CW_SESSION` / `CLAUDE_SESSION_ID` when present.
   */
  sessionId?: string;
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
  /** Caller identity used for ownership checks; undefined = unidentified. */
  readonly sessionId: string | undefined;
  private readonly clock: () => Date;

  constructor(options: RuntimeOptions = {}) {
    const root = options.projectRoot ?? findProjectRoot(process.cwd(), options.runtimeDir ?? DEFAULT_CONFIG.runtimeDir);
    const runtimeDirName = resolveRuntimeDirName(root, options.runtimeDir);
    this.paths = new RuntimePaths(root, runtimeDirName);
    this.config = readConfig(this.paths);
    if (!options.runtimeDir && this.config.runtimeDir !== runtimeDirName) {
      this.paths = new RuntimePaths(root, this.config.runtimeDir);
    }
    this.sessionId = options.sessionId;
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

  /** Throws RunStateCorruptError if the pointer targets an unreadable run. */
  currentRun(): RunState | undefined {
    const id = this.currentRunId();
    return id ? tryReadRun(this.paths, id) : undefined;
  }

  /** The active run, or undefined when it is missing *or* unreadable. */
  currentRunSafe(): RunState | undefined {
    try {
      return this.currentRun();
    } catch {
      return undefined;
    }
  }

  /**
   * Runs that are neither completed, failed, abandoned nor quarantined. A
   * quarantined run is retired by hand: it must stop blocking new runs and stop
   * holding gates closed, even if someone later restores its state file.
   */
  activeRuns(): RunState[] {
    const out: RunState[] = [];
    for (const id of this.runIds()) {
      if (isQuarantined(this.paths, id)) continue;
      let run: RunState;
      try {
        run = this.run(id);
      } catch {
        continue;
      }
      if (!isTerminalRun(run.status)) out.push(run);
    }
    return out;
  }

  /** Runs whose state.json exists but cannot be read, quarantine excluded. */
  unreadableRunIds(): string[] {
    const out: string[] = [];
    for (const id of this.runIds()) {
      if (isQuarantined(this.paths, id)) continue;
      try {
        this.run(id);
      } catch (error) {
        if (error instanceof RunStateCorruptError) out.push(id);
      }
    }
    return out;
  }

  quarantinedRunIds(): string[] {
    return this.runIds().filter((id) => isQuarantined(this.paths, id));
  }

  policyHealth(): PolicyHealth | undefined {
    return readPolicyHealth(this.paths);
  }

  recordPolicyEvaluation(ok: boolean, error?: unknown): PolicyHealth {
    const update: { ok: boolean; enforceGates: boolean; error?: string; now: string } = {
      ok,
      enforceGates: this.config.enforceGates,
      now: this.now(),
    };
    if (!ok) update.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return recordPolicyHealth(this.paths, update);
  }

  /**
   * Retire an unreadable run without deserialising it. The corrupt files stay in
   * place; only the pointer is cleared, and the reason is written to the audit log.
   */
  quarantineCurrentRun(reason: string, explicitRunId?: string): { runId: string; marker: string } {
    const runId = explicitRunId ?? readCurrentRunId(this.paths);
    if (!runId) throw new sm.TransitionError('no current run to quarantine');
    const result = quarantineRun(this.paths, runId, reason);
    if (readCurrentRunId(this.paths) === runId) writeCurrentRunId(this.paths, undefined);
    const sessions = readSessions(this.paths);
    let changed = false;
    for (const [session, entry] of Object.entries(sessions)) {
      if (entry.runId !== runId) continue;
      delete sessions[session];
      changed = true;
    }
    if (changed) writeSessions(this.paths, sessions);
    return { runId, marker: result.marker };
  }

  // ---- session correlation --------------------------------------------------

  /**
   * Resolve the run a Claude session may write to.
   *
   * 1. the run this session is already bound to;
   * 2. otherwise the global current run, but only while it is unclaimed —
   *    `cw run start` runs over Bash and has no session id, so the session that
   *    issued it adopts the run on its next hook event;
   * 3. otherwise nothing: another session owns it.
   */
  runForSession(sessionId: string | undefined): RunState | undefined {
    if (sessionId) {
      const bound = readSessions(this.paths)[sessionId];
      if (bound) {
        const run = tryReadRun(this.paths, bound.runId);
        if (run && !isTerminalRun(run.status)) return run;
      }
    }
    const current = this.currentRun();
    if (!current) return undefined;
    if (!sessionId) return current;
    if (current.ownerSessionId && current.ownerSessionId !== sessionId) return undefined;
    return current;
  }

  /**
   * Refuse a semantic mutation from a session that does not own the run.
   *
   * `cw` is invoked over a shell and usually has no session identity, so this is
   * a check, not the guarantee: the enforceable half lives in the PreToolUse
   * policy, which does know which session issued the command. When an identity
   * *is* available, disagreeing with the recorded owner is always a mistake.
   */
  private assertOwnership(run: RunState, what: string): void {
    const caller = this.sessionId;
    if (!caller) return;
    if (!run.ownerSessionId || run.ownerSessionId === caller) return;
    throw new sm.TransitionError(
      `run ${run.runId} is owned by Claude session ${run.ownerSessionId}; session ${caller} may not ${what}. ` +
        `Take it over deliberately: cw run claim ${run.runId} --session ${caller} --force --reason "<why>"`,
    );
  }

  /** Take ownership of a run. `force` is required to displace a live owner. */
  claimRun(opts: { runId?: string; sessionId?: string; force?: boolean; reason?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const sessionId = opts.sessionId ?? this.sessionId;
    if (!sessionId) {
      throw new sm.TransitionError('cw run claim needs an identity: --session <sessionId> (or CW_SESSION)');
    }
    if (run.ownerSessionId && run.ownerSessionId !== sessionId && !opts.force) {
      throw new sm.TransitionError(
        `run ${run.runId} is already owned by session ${run.ownerSessionId}. ` +
          `Override deliberately: cw run claim ${run.runId} --session ${sessionId} --force --reason "<why>"`,
      );
    }
    const previous = run.ownerSessionId;
    run.ownerSessionId = sessionId;
    const sessions = readSessions(this.paths);
    for (const [session, entry] of Object.entries(sessions)) {
      if (entry.runId === run.runId && session !== sessionId) delete sessions[session];
    }
    sessions[sessionId] = { runId: run.runId, updatedAt: this.now() };
    writeSessions(this.paths, sessions);
    run.lastActivityAt = this.now();
    run.updatedAt = run.lastActivityAt;
    this.record(run, 'RUN_CLAIMED', {
      sessionId,
      node: run.currentNode,
      message: `claimed by ${sessionId}${previous ? ` from ${previous}` : ''}${opts.reason ? `: ${opts.reason}` : ''}`,
    });
    return this.persist(run);
  }

  /** Hand a run to another session, from its current owner. */
  transferRun(opts: { runId?: string; to: string; reason?: string }): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'transfer it');
    const previous = run.ownerSessionId;
    run.ownerSessionId = opts.to;
    const sessions = readSessions(this.paths);
    for (const [session, entry] of Object.entries(sessions)) {
      if (entry.runId === run.runId) delete sessions[session];
    }
    sessions[opts.to] = { runId: run.runId, updatedAt: this.now() };
    writeSessions(this.paths, sessions);
    run.lastActivityAt = this.now();
    run.updatedAt = run.lastActivityAt;
    this.record(run, 'RUN_TRANSFERRED', {
      sessionId: opts.to,
      node: run.currentNode,
      message: `transferred ${previous ?? '(unowned)'} -> ${opts.to}${opts.reason ? `: ${opts.reason}` : ''}`,
    });
    return this.persist(run);
  }

  bindSession(sessionId: string, run: RunState): void {
    const sessions = readSessions(this.paths);
    sessions[sessionId] = { runId: run.runId, updatedAt: this.now() };
    writeSessions(this.paths, sessions);
    if (!run.ownerSessionId) run.ownerSessionId = sessionId;
  }

  /** Drop the binding when a run ends so the session can start a fresh one. */
  private unbindRun(runId: string): void {
    const sessions = readSessions(this.paths);
    let changed = false;
    for (const [session, entry] of Object.entries(sessions)) {
      if (entry.runId !== runId) continue;
      delete sessions[session];
      changed = true;
    }
    if (changed) writeSessions(this.paths, sessions);
  }

  events(runId: string, limit?: number): WorkflowEvent[] {
    return readEvents(this.paths, runId, limit);
  }

  artifacts(runId: string): string[] {
    return scanArtifacts(this.paths, runId).valid;
  }

  private record(run: RunState, type: EventType, extra: Partial<WorkflowEvent> = {}): WorkflowEvent {
    const event: WorkflowEvent = { ts: this.now(), type, runId: run.runId, ...extra };
    appendEvent(this.paths, event);
    return event;
  }

  private persist(run: RunState): RunState {
    const scan = scanArtifacts(this.paths, run.runId);
    run.artifacts = scan.valid;
    if (scan.invalid.length) run.invalidArtifacts = scan.invalid;
    else delete run.invalidArtifacts;
    writeRun(this.paths, run);
    return run;
  }

  /** Artifacts in the run directory that satisfy the evidence contract. */
  validArtifacts(runId: string): string[] {
    return scanArtifacts(this.paths, runId).valid;
  }

  /**
   * Present-but-unusable artifacts, read from disk rather than from the last
   * persisted state: a refused transition never got to persist anything, and that
   * is exactly the moment the user needs to be told *why*.
   */
  invalidArtifacts(runId: string): InvalidArtifact[] {
    return scanArtifacts(this.paths, runId).invalid;
  }

  // ---- semantic transitions -------------------------------------------------

  /**
   * Opening a second run while one is live is how evidence gets orphaned: the
   * first run stays WAITING_USER forever and its artifacts belong to nothing.
   * Refuse by default; `force` abandons the previous run explicitly so the
   * handover is recorded rather than silent.
   */
  startRun(
    workflowId: string,
    opts: { label?: string; runId?: string; force?: boolean; sessionId?: string; reason?: string } = {},
  ): RunState {
    const def = this.workflow(workflowId);
    this.ensureRuntimeDir();

    // An unreadable current run must never be silently replaced: the new run
    // would look like the only run in the project and the broken one's evidence
    // would belong to nothing.
    const pointer = readCurrentRunId(this.paths);
    if (pointer && !isQuarantined(this.paths, pointer)) {
      try {
        readRun(this.paths, pointer);
      } catch (error) {
        if (error instanceof RunStateCorruptError) {
          throw new sm.TransitionError(
            `the active run "${pointer}" is CORRUPT (${error.message}). A new run must not replace it. ` +
              `Inspect ${error.file}, restore it, or retire it explicitly: ` +
              `cw run quarantine-current --reason "corrupt state"`,
          );
        }
      }
    }
    const unreadable = this.unreadableRunIds();
    if (unreadable.length && !opts.force) {
      throw new sm.TransitionError(
        `${unreadable.length} run(s) are unreadable: ${unreadable.join(', ')}. ` +
          `Retire them (cw run quarantine-current --reason "...") before starting a new run.`,
      );
    }

    const blocking = this.activeRuns();
    if (blocking.length && !opts.force) {
      const list = blocking
        .map((r) => `${r.runId} (${r.workflow}, ${r.status}${r.label ? `, "${r.label}"` : ''})`)
        .join('; ');
      throw new sm.TransitionError(
        `cannot start "${workflowId}": ${blocking.length} run(s) still active: ${list}. ` +
          `Continue it (cw status), finish it (cw run complete), retire it (cw run abandon), ` +
          `or override with: cw run start ${workflowId} --force --reason "<why>"`,
      );
    }
    // Superseding a run whose gate is still closed is the same escape as
    // abandoning it, so it carries the same requirement: say why.
    const gated = blocking.filter((r) => {
      try {
        return missingGates(this.workflow(r.workflow), r).length > 0;
      } catch {
        return false;
      }
    });
    if (gated.length && !opts.reason?.trim()) {
      throw new sm.TransitionError(
        `cannot supersede ${gated.map((r) => r.runId).join(', ')}: still behind unpassed gate(s). ` +
          `Retiring a gated run is a deliberate decision: ` +
          `cw run start ${workflowId} --force --reason "<why the previous task is withdrawn>"`,
      );
    }
    for (const previous of blocking) {
      this.abandonRun({
        runId: previous.runId,
        message: `superseded by a new ${workflowId} run${opts.reason ? `: ${opts.reason}` : ''}`,
        internal: true,
      });
    }

    const now = this.now();
    const runId = opts.runId ?? nextRunId(this.paths, workflowId, this.clock());
    const run = sm.initialRunState(def, runId, now, opts.label);
    if (opts.sessionId) run.ownerSessionId = opts.sessionId;
    writeRun(this.paths, run);
    writeCurrentRunId(this.paths, runId);
    if (opts.sessionId) this.bindSession(opts.sessionId, run);
    const extra: Partial<WorkflowEvent> = { node: run.currentNode };
    if (opts.label) extra.message = opts.label;
    if (opts.sessionId) extra.sessionId = opts.sessionId;
    this.record(run, 'RUN_STARTED', extra);
    return this.persist(run);
  }

  /**
   * Retiring a run with a gate still closed is the one legitimate way past that
   * gate — the task itself is withdrawn. It therefore cannot be a bare command:
   * without a stated reason it would be a silent bypass, which is the whole thing
   * the gate exists to prevent. The open gates go into the audit record.
   */
  abandonRun(opts: { runId?: string; message?: string; internal?: boolean } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    if (!opts.internal) this.assertOwnership(run, 'abandon it');
    let open: string[] = [];
    try {
      open = missingGates(this.workflow(run.workflow), run);
    } catch {
      open = [];
    }
    if (open.length && !opts.internal && !opts.message?.trim()) {
      throw new sm.TransitionError(
        `run ${run.runId} still has unpassed gate(s) ${open.join(', ')}; abandoning it is how the ` +
          `workflow is left behind, so it needs a stated reason: ` +
          `cw run abandon --message "<why this task is withdrawn>"`,
      );
    }
    sm.abandonRun(run, this.now(), opts.message);
    const extra: Partial<WorkflowEvent> = { node: run.currentNode };
    if (opts.message) {
      extra.message = open.length
        ? `${opts.message} (abandoned with unpassed gate(s): ${open.join(', ')})`
        : opts.message;
    }
    if (open.length) extra.data = { unpassedGates: open };
    this.record(run, 'RUN_ABANDONED', extra);
    this.persist(run);
    this.unbindRun(run.runId);
    if (this.currentRunId() === run.runId) writeCurrentRunId(this.paths, undefined);
    return run;
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

  /**
   * The node contract, enforced centrally.
   *
   * A phase that declares evidence has not finished until that evidence exists,
   * and a workflow whose earlier evidence was deleted is not in the state it
   * claims. Relying on every skill to remember `--require-artifacts` made the
   * contract advisory, which is the same as not having one.
   */
  private assertArtifactContract(
    run: RunState,
    def: WorkflowDefinition,
    leaving: string | undefined,
    target: string | undefined,
    opts: { allowMissing?: boolean; reason?: string },
  ): void {
    const valid = this.validArtifacts(run.runId);
    const problems: string[] = [];

    const leavingNode = leaving ? sm.findNode(def, leaving) : undefined;
    const targetNode = target ? sm.findNode(def, target) : undefined;
    // Parking on a waiting node is the *reason* the evidence is not written yet.
    const waitingHop =
      leavingNode?.kind === 'waiting' ||
      (targetNode?.kind === 'waiting' && targetNode.gate === leavingNode?.gate);

    if (leavingNode && !waitingHop) {
      for (const artifact of sm.artifactsOf(leavingNode)) {
        if (!valid.includes(artifact)) problems.push(`${artifact} (declared by "${leavingNode.id}")`);
      }
    }
    for (const node of def.nodes) {
      if (node.id === leavingNode?.id) continue;
      if (run.nodes[node.id]?.status !== 'COMPLETED') continue;
      for (const artifact of sm.artifactsOf(node)) {
        if (!valid.includes(artifact)) problems.push(`${artifact} (completed phase "${node.id}")`);
      }
    }
    if (!problems.length) return;

    const invalid = run.invalidArtifacts ?? [];
    const detail = invalid.length
      ? ` Present but unusable: ${invalid.map((a) => `${a.name} — ${a.reason}`).join('; ')}.`
      : '';
    if (!opts.allowMissing) {
      throw new sm.TransitionError(
        `required artifact(s) missing or unusable: ${problems.join(', ')}.${detail} ` +
          `Write them into ${this.paths.runDir(run.runId)} first, or override deliberately with ` +
          `--allow-missing-artifacts --reason "<why>".`,
      );
    }
    if (!opts.reason) {
      throw new sm.TransitionError('--allow-missing-artifacts requires --reason "<why>"');
    }
    this.record(run, 'ARTIFACT_CONTRACT_OVERRIDE', {
      node: leaving ?? run.currentNode,
      message: `overrode missing artifact(s) ${problems.join(', ')}: ${opts.reason}`,
    });
  }

  enterPhase(
    nodeId: string,
    opts: { runId?: string; force?: boolean; allowMissingArtifacts?: boolean; reason?: string } = {},
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'change its phase');
    const def = this.workflow(run.workflow);
    if (nodeId !== run.currentNode) {
      // An illegal edge is reported before a missing artifact: they need
      // different fixes and the graph problem is the more fundamental one.
      if (!opts.force) {
        const legal = sm.checkEnter(def, run, nodeId);
        if (!legal.ok) throw new sm.TransitionError(legal.reason!);
      }
      const contract: { allowMissing?: boolean; reason?: string } = {};
      if (opts.allowMissingArtifacts) contract.allowMissing = true;
      if (opts.reason) contract.reason = opts.reason;
      this.assertArtifactContract(run, def, run.currentNode, nodeId, contract);
    }
    const wouldBeIllegal =
      opts.force === true && nodeId !== run.currentNode && !sm.allowedEdges(def, run).map((e) => e.to).includes(nodeId);
    sm.enterNode(def, run, nodeId, this.now(), { force: opts.force ?? false });
    // A forced transition is legitimate but must never be invisible in the log.
    if (wouldBeIllegal) {
      this.record(run, 'FORCED_TRANSITION', {
        node: nodeId,
        message: `transition into "${nodeId}" was forced; the workflow definition does not allow it from "${run.currentNode}"`,
      });
    }
    this.record(run, 'NODE_ENTER', { node: nodeId });
    return this.persist(run);
  }

  /** Declared artifacts of a phase that are missing or unusable as evidence. */
  missingArtifacts(run: RunState, nodeId: string): string[] {
    const def = this.workflow(run.workflow);
    const declared = sm.artifactsOf(sm.findNode(def, nodeId));
    if (!declared.length) return [];
    const valid = this.validArtifacts(run.runId);
    return declared.filter((a) => !valid.includes(a));
  }

  completePhase(
    nodeId?: string,
    opts: { runId?: string; allowMissingArtifacts?: boolean; reason?: string } = {},
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'complete its phases');
    const def = this.workflow(run.workflow);
    const target = nodeId ?? run.currentNode;
    const contract: { allowMissing?: boolean; reason?: string } = {};
    if (opts.allowMissingArtifacts) contract.allowMissing = true;
    if (opts.reason) contract.reason = opts.reason;
    this.assertArtifactContract(run, def, target, undefined, contract);
    sm.completeNode(def, run, target, this.now());
    this.record(run, 'NODE_COMPLETE', { node: target });
    return this.persist(run);
  }

  /** Set by the last mutating call when it succeeded but something looked wrong. */
  lastWarning?: string;

  skipPhase(nodeId: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'skip its phases');
    const def = this.workflow(run.workflow);
    sm.skipNode(def, run, nodeId, this.now());
    const extra: Partial<WorkflowEvent> = { node: nodeId };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'NODE_SKIP', extra);
    return this.persist(run);
  }

  failPhase(nodeId?: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'fail its phases');
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
    this.assertOwnership(run, 'park its gates');
    const def = this.workflow(run.workflow);
    sm.waitGate(def, run, gate, this.now());
    const extra: Partial<WorkflowEvent> = { gate, node: run.currentNode };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'GATE_WAIT', extra);
    return this.persist(run);
  }

  /**
   * A gate opens only from its owning phase, with that phase's evidence on disk.
   * There is no implicit override: `CW_STRICT=0` relaxes graph transitions, never
   * a gate. Deliberate overrides go through `overrideGate`, which demands a reason
   * and writes an audit event.
   */
  passGate(gate: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'decide its gates');
    const def = this.workflow(run.workflow);
    const check = sm.checkGatePass(def, run, gate, this.validArtifacts(run.runId));
    if (!check.ok) {
      throw new sm.TransitionError(
        `${check.reason} (deliberate override: cw gate override ${gate} --reason "<why>")`,
      );
    }
    sm.passGate(def, run, gate, this.now());
    this.record(run, 'GATE_PASS', { gate, node: run.currentNode });
    return this.persist(run);
  }

  /** Explicit, audited gate override. Never reachable from an env var. */
  overrideGate(gate: string, reason: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'override its gates');
    if (!reason.trim()) throw new sm.TransitionError('cw gate override requires --reason "<why>"');
    const def = this.workflow(run.workflow);
    const check = sm.checkGatePass(def, run, gate, this.validArtifacts(run.runId));
    sm.passGate(def, run, gate, this.now(), { overrideReason: reason });
    this.record(run, 'GATE_OVERRIDE', {
      gate,
      node: run.currentNode,
      message: `overridden at "${run.currentNode}": ${reason}${check.ok ? '' : ` (would have failed: ${check.reason})`}`,
    });
    this.record(run, 'GATE_PASS', { gate, node: run.currentNode, message: 'overridden' });
    return this.persist(run);
  }

  failGate(gate: string, opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'fail its gates');
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

  /**
   * COMPLETED is a claim about the workflow, so it is verified. There is no
   * `--force`: a run that cannot legitimately finish is retired with
   * `cw run abandon`, and ABANDONED never reads as success.
   */
  completeRun(opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'complete it');
    const def = this.workflow(run.workflow);
    const check = sm.checkRunComplete(def, run, this.validArtifacts(run.runId));
    if (!check.ok) {
      throw new sm.TransitionError(
        `run ${run.runId} cannot be completed:\n  - ${check.reasons.join('\n  - ')}\n` +
          `A run that will not finish is retired, not completed: cw run abandon --message "<why>"`,
      );
    }
    sm.completeRun(def, run, this.now());
    this.record(run, 'RUN_COMPLETED', { node: run.currentNode });
    this.persist(run);
    this.unbindRun(run.runId);
    if (this.currentRunId() === run.runId) writeCurrentRunId(this.paths, undefined);
    return run;
  }

  failRun(opts: { runId?: string; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'fail it');
    sm.failRun(run, this.now(), opts.message);
    const extra: Partial<WorkflowEvent> = { node: run.currentNode };
    if (opts.message) extra.message = opts.message;
    this.record(run, 'RUN_FAILED', extra);
    this.persist(run);
    this.unbindRun(run.runId);
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
    const sessionId = payload.sessionId;
    // A hook must never surface a storage error into the user's session; an
    // unreadable run simply has no activity recorded against it.
    let run: RunState | undefined;
    try {
      run = this.runForSession(sessionId);
    } catch {
      return undefined;
    }

    if (!run && opts.autoStart && this.config.autoGenericRun && !this.activeRuns().length) {
      const startOpts: { label?: string; sessionId?: string } = {};
      if (payload.message) startOpts.label = payload.message;
      if (sessionId) startOpts.sessionId = sessionId;
      run = this.startRun('generic', startOpts);
      this.enterPhase('working', { runId: run.runId, force: true });
      run = this.run(run.runId);
    }
    if (!run) return undefined;
    if (isTerminalRun(run.status)) return undefined;
    if (sessionId && run.ownerSessionId && run.ownerSessionId !== sessionId) return undefined;
    if (sessionId) this.bindSession(sessionId, run);

    const event: WorkflowEvent = { ts: this.now(), type, runId: run.runId, ...payload };
    appendEvent(this.paths, event);
    sm.applyRuntimeEvent(run, event);
    this.persist(run);

    // A `generic` run has no gates and no report; it exists only to give the
    // monitor something to attach the session to. When the session ends it is
    // done — leaving it RUNNING is what filled the monitor with dead runs.
    if (type === 'SESSION_END' && run.workflow === 'generic') return this.completeRun({ runId: run.runId });
    return this.run(run.runId);
  }

  /**
   * PreToolUse decision.
   *
   * Authorisation is a property of the *project*, not of a Claude session: while
   * any active run in this worktree has an open gate, no session may change the
   * repository. Telemetry ownership stays session-scoped (a second session must
   * not overwrite the first session's runtime state) — the two are different
   * questions and were previously answered by the same lookup.
   */
  checkMutation(input: {
    toolName: string | undefined;
    toolInput?: Record<string, unknown> | undefined;
    sessionId?: string | undefined;
  }): MutationDecision {
    const contexts: PolicyRunContext[] = [];
    for (const run of this.activeRuns()) {
      let def: WorkflowDefinition;
      try {
        def = this.workflow(run.workflow);
      } catch {
        continue; // an unloadable definition cannot authorise or block anything
      }
      contexts.push({ run, def, runDir: this.paths.runDir(run.runId) });
    }

    let owned: RunState | undefined;
    try {
      owned = this.runForSession(input.sessionId);
    } catch {
      owned = undefined; // unreadable: it simply owns nothing
    }

    const decision = evaluateMutation({
      toolName: input.toolName,
      toolInput: input.toolInput,
      config: this.config,
      runs: contexts,
      sessionRunId: owned?.runId,
      sessionId: input.sessionId,
      projectRoot: this.paths.projectRoot,
      runtimeDir: this.paths.runtimeDir,
    });

    if (decision.decision === 'deny' && decision.runId) {
      const extra: Partial<WorkflowEvent> = {
        message:
          `denied ${input.toolName} (${decision.kind ?? 'repository'})` +
          (decision.missingGates?.length ? `: missing ${decision.missingGates.join(', ')}` : ''),
      };
      const target = contexts.find((c) => c.run.runId === decision.runId);
      if (target) extra.node = target.run.currentNode;
      if (input.toolName) extra.tool = input.toolName;
      if (input.sessionId) extra.sessionId = input.sessionId;
      appendEvent(this.paths, {
        ts: this.now(),
        type: 'MUTATION_DENIED',
        runId: decision.runId,
        ...extra,
      });
    }
    return decision;
  }

  conventions(): ConventionReport {
    return inspectConventions(this.paths);
  }

  derivedStatus(run: RunState): sm.RunStatusView {
    return sm.derivedRunStatus(run, this.config.stallThresholdSeconds, this.now());
  }

  derivedSemantic(run: RunState): sm.SemanticView {
    return sm.derivedSemanticStatus(run, this.config.semanticLagThresholdSeconds, this.now());
  }
}
