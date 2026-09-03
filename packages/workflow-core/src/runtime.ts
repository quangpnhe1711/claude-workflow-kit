import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { loadWorkflow, loadWorkflows } from './loader.js';
import * as sm from './state-machine.js';
import * as mc from './mission.js';
import { inspectConventions, type ConventionReport } from './conventions.js';
import { evaluateMutation, missingGates, type RunGateContext as PolicyRunContext } from './policy.js';
import {
  SPEC_MAP_ARTIFACT,
  designSources,
  parseSpecMap,
  specCoverage,
  unmappedItems,
  type SpecCoverage,
  type SpecItem,
  type SpecMap,
} from './spec.js';
import {
  RunStateCorruptError,
  RuntimePaths,
  appendEvent,
  eventsSize,
  findProjectRoot,
  isQuarantined,
  listRunIds,
  nextRunId,
  quarantineRun,
  readConfig,
  readCurrentRunId,
  readEventPage,
  readEvents,
  readPolicyHealth,
  readRun,
  readSessions,
  recordPolicyHealth,
  resolveRuntimeDirName,
  scanArtifacts,
  tryReadRun,
  writeCurrentRunId,
  writeJsonAtomic,
  writeRun,
  writeSessions,
  type EventPage,
} from './store.js';
import { foldRollup, type RunRollup } from './rollup.js';
import {
  queryRuns,
  readRunIndex,
  syncRunIndex,
  type RunIndexEntry,
  type RunPage,
  type RunQuery,
} from './run-index.js';
import { observe, type Observation } from './telemetry.js';
import { readRunUsage, type SessionUsage } from './usage.js';
import {
  DEFAULT_CONFIG,
  SOLUTION_ANALYSIS_ARTIFACTS,
  isTerminalRun,
  type SourceSnapshotEntry,
  type EventType,
  type InvalidArtifact,
  type KitConfig,
  type MutationDecision,
  type PolicyHealth,
  type RunState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from './types.js';

/** NFD combining marks: strips Vietnamese diacritics out of directory slugs. */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

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

export interface SpecCheckReport {
  runId: string;
  present: boolean;
  errors: string[];
  items: SpecItem[];
  designSources: string[];
  /** Requirement ids with no code path yet. */
  unmapped: string[];
  /** Design documents whose content no longer matches the approved fingerprint. */
  staleDesignSources: string[];
  coverage: SpecCoverage[];
}

const SEMANTIC_EVENTS = new Set<EventType>([
  'RUN_STARTED',
  'RUN_ROUTED',
  'RUN_ESCALATED',
  'ANALYSIS_READY',
  'ANALYSIS_APPROVED',
  'ANALYSIS_HANDOFF',
  'ANALYSIS_FRESHNESS',
  'ANALYSIS_REFRESHED',
  'SPEC_DRIFT',
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
    mkdirSync(this.paths.instructionsDir, { recursive: true });
  }

  runIds(): string[] {
    return listRunIds(this.paths);
  }

  run(runId: string): RunState {
    return this.normaliseWorkflowAdditions(readRun(this.paths, runId));
  }

  /** Additive workflow nodes must not make a pre-upgrade run incomplete. */
  private normaliseWorkflowAdditions(run: RunState): RunState {
    if (run.workflow === 'feature-change' && !run.sourceAnalysisRunId) {
      const freshness = run.nodes['freshness'];
      if (!freshness) {
        run.nodes['freshness'] = {
          status: 'SKIPPED',
          visits: 0,
          finishedAt: run.startedAt,
        };
      } else if (freshness.status === 'PENDING') {
        freshness.status = 'SKIPPED';
        freshness.finishedAt = run.startedAt;
      }
    }
    return run;
  }

  currentRunId(): string | undefined {
    const id = readCurrentRunId(this.paths);
    if (!id) return undefined;
    return existsSync(this.paths.stateFile(id)) ? id : undefined;
  }

  /** Throws RunStateCorruptError if the pointer targets an unreadable run. */
  currentRun(): RunState | undefined {
    const id = this.currentRunId();
    const run = id ? tryReadRun(this.paths, id) : undefined;
    return run ? this.normaliseWorkflowAdditions(run) : undefined;
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
        const raw = tryReadRun(this.paths, bound.runId);
        const run = raw ? this.normaliseWorkflowAdditions(raw) : undefined;
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

  /** Forward page of the event log from a byte cursor. See `readEventPage`. */
  eventPage(runId: string, opts: { after?: number; limit?: number } = {}): EventPage {
    return readEventPage(this.paths, runId, opts);
  }

  artifacts(runId: string): string[] {
    return scanArtifacts(this.paths, runId).valid;
  }

  // ---- observability (derived; never a source of truth) --------------------

  /**
   * Per-run rollup. Cached in `rollup.json` keyed by the size of the event log:
   * appending is the only way the log changes, so a matching size means the
   * cached fold is still exact. Deleting the file only costs one re-fold.
   */
  rollup(runId: string): RunRollup {
    const run = this.run(runId);
    const bytes = eventsSize(this.paths, runId);
    const file = this.paths.rollupFile(runId);
    if (existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, 'utf8')) as RunRollup;
        if (cached.eventBytes === bytes && cached.run.status === run.status) return cached;
      } catch {
        // A damaged cache is a cache miss, never an error.
      }
    }
    const rollup = foldRollup(run, readEvents(this.paths, runId), {
      eventBytes: bytes,
      now: this.now(),
    });
    // Only a finished run gets a frozen copy: a live run's log grows every few
    // seconds, and rewriting the cache each time costs more than folding it.
    if (isTerminalRun(run.status)) {
      try {
        writeJsonAtomic(file, rollup);
      } catch {
        // The cache is optional; the fold above is the answer.
      }
    }
    return rollup;
  }

  /**
   * Read this run's token usage out of Claude Code's session transcript and
   * record it as a cumulative `USAGE_RECORDED` snapshot.
   *
   * The kit cannot measure tokens itself — it never sees the model call — so
   * this is a join on the session that owns the run, restricted to the run's own
   * time window. Repeated calls are safe: the fold keeps the newest snapshot per
   * session rather than adding them up.
   *
   * Returns undefined when no transcript can be read, which is a real answer:
   * the UI shows N/A rather than a zero that looks measured.
   */
  syncUsage(opts: { runId?: string; run?: RunState } = {}): SessionUsage | undefined {
    const run = opts.run ?? this.resolveRun(opts.runId);
    const sessionId = run.ownerSessionId;
    if (!sessionId) return undefined;
    const usage = readRunUsage(
      this.paths.projectRoot,
      sessionId,
      { from: run.startedAt, ...(run.finishedAt ? { to: run.finishedAt } : {}) },
      this.config.pricing,
    );
    if (!usage) return undefined;
    this.record(run, 'USAGE_RECORDED', {
      sessionId,
      data: {
        sessionId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
        estimatedCost: usage.estimatedCost,
        models: usage.models,
        messages: usage.messages,
        ...(usage.through ? { through: usage.through } : {}),
        source: 'claude-code-transcript',
      },
    });
    return usage;
  }

  /** Usage sync at the end of a run. Never allowed to fail the run itself. */
  private syncUsageQuietly(run: RunState): void {
    try {
      this.syncUsage({ run });
    } catch {
      // Telemetry is best-effort; a missing transcript is not a run failure.
    }
  }

  /** Refresh the derived history index. Cheap: one `stat` per unchanged run. */
  syncIndex(opts: { force?: boolean } = {}): RunIndexEntry[] {
    return syncRunIndex(
      this.paths,
      {
        runIds: () => this.runIds(),
        readRun: (runId) => {
          try {
            return this.run(runId);
          } catch {
            return undefined;
          }
        },
        definition: (workflowId) => {
          try {
            return this.workflow(workflowId);
          } catch {
            return undefined;
          }
        },
        // Counts come from the frozen rollup of a finished run only; folding a
        // live run's log on every index sync would undo the point of the index.
        rollup: (run) => {
          if (!isTerminalRun(run.status)) return undefined;
          try {
            return this.rollup(run.runId);
          } catch {
            return undefined;
          }
        },
      },
      opts,
    ).entries;
  }

  runIndex(): RunIndexEntry[] {
    return readRunIndex(this.paths);
  }

  /** Paged history query. Reads the index, never the runs themselves. */
  queryRuns(query: RunQuery = {}): RunPage {
    return queryRuns(this.syncIndex(), query);
  }

  /**
   * Record redacted telemetry about a tool call: which project file it touched,
   * which program it ran. Never the arguments, never the contents.
   *
   * This is observability, not semantics — it can never move a phase, open a
   * gate or change a status, which is what keeps D1 intact.
   */
  recordObservations(
    runId: string,
    input: { phase: 'start' | 'end' | 'fail'; toolName?: string; toolInput?: Record<string, unknown> },
  ): Observation[] {
    const observations = observe({
      phase: input.phase,
      toolName: input.toolName,
      toolInput: input.toolInput,
      projectRoot: this.paths.projectRoot,
      config: this.config,
    });
    if (!observations.length) return [];
    let node: string | undefined;
    try {
      node = this.run(runId).currentNode;
    } catch {
      node = undefined;
    }
    for (const observation of observations) {
      const event: WorkflowEvent = {
        ts: this.now(),
        type: observation.type,
        runId,
        data: observation.data,
        ...(node ? { node } : {}),
        ...(input.toolName ? { tool: input.toolName } : {}),
      };
      appendEvent(this.paths, event);
    }
    return observations;
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

  private sourceSnapshot(sources: string[]): SourceSnapshotEntry[] {
    const seen = new Set<string>();
    const snapshot: SourceSnapshotEntry[] = [];
    for (const input of sources) {
      const value = input.trim();
      if (!value) continue;
      const absolute = resolve(this.paths.projectRoot, value);
      const rel = relative(this.paths.projectRoot, absolute);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new sm.TransitionError(`analysis source must be a project file: ${value}`);
      }
      const normalised = rel.replace(/\\/g, '/');
      if (seen.has(normalised)) continue;
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new sm.TransitionError(`analysis source does not exist as a file: ${normalised}`);
      }
      seen.add(normalised);
      snapshot.push({
        path: normalised,
        sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      });
    }
    if (!snapshot.length) {
      throw new sm.TransitionError(
        'analysis readiness requires at least one relevant source file: --source "path[,path...]"',
      );
    }
    return snapshot;
  }

  private staleSnapshotPaths(snapshot: SourceSnapshotEntry[]): string[] {
    const stale: string[] = [];
    for (const entry of snapshot) {
      const absolute = resolve(this.paths.projectRoot, entry.path);
      const rel = relative(this.paths.projectRoot, absolute);
      if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute) || !statSync(absolute).isFile()) {
        stale.push(entry.path);
        continue;
      }
      const current = createHash('sha256').update(readFileSync(absolute)).digest('hex');
      if (current !== entry.sha256) stale.push(entry.path);
    }
    return stale;
  }

  private readSpecMap(runId: string): SpecMap | undefined {
    const path = join(this.paths.runDir(runId), SPEC_MAP_ARTIFACT);
    if (!existsSync(path)) return undefined;
    return parseSpecMap(readFileSync(path, 'utf8'));
  }

  /**
   * Design documents the map cites, kept in every snapshot whether or not the
   * caller listed them: they are the authority the whole analysis rests on, so
   * forgetting one on the command line must not make the analysis look fresh.
   */
  private citedDesignSources(runId: string): string[] {
    return designSources(this.readSpecMap(runId)?.items ?? []).filter((path) =>
      existsSync(resolve(this.paths.projectRoot, path)),
    );
  }

  /**
   * The fingerprint the traceability map is judged against. A handed-off feature
   * run has no snapshot of its own until it refreshes, so the approved analysis
   * run stays the baseline — the same order `checkAnalysisFreshness` uses.
   */
  private specSnapshot(run: RunState): SourceSnapshotEntry[] {
    if (run.analysisHandoff?.sourceSnapshot) return run.analysisHandoff.sourceSnapshot;
    if (run.analysis?.sourceSnapshot) return run.analysis.sourceSnapshot;
    if (!run.sourceAnalysisRunId) return [];
    try {
      return this.run(run.sourceAnalysisRunId).analysis?.sourceSnapshot ?? [];
    } catch {
      return [];
    }
  }

  private specReport(run: RunState, files: string[]): SpecCheckReport {
    const map = this.readSpecMap(run.runId);
    const items = map?.items ?? [];
    const design = designSources(items);
    const snapshot = this.specSnapshot(run).filter((entry) => design.includes(entry.path));
    return {
      runId: run.runId,
      present: map !== undefined,
      errors: map?.errors ?? [],
      items,
      designSources: design,
      unmapped: unmappedItems(items).map((item) => item.id),
      staleDesignSources: this.staleSnapshotPaths(snapshot),
      coverage: specCoverage(items, files),
    };
  }

  /** Is the run parked on the phase that changes the repository? */
  isImplementationPhase(run: RunState): boolean {
    return mc.isImplementationNode(this.workflow(run.workflow), run.currentNode);
  }

  /** Which requirements govern the given files, and where the map has drifted. */
  specCheck(opts: { runId?: string; files?: string[] } = {}): SpecCheckReport {
    return this.specReport(this.resolveRun(opts.runId), opts.files ?? []);
  }

  /**
   * Advisory only, by design. A design document that moved on, or a requirement
   * nobody has claimed a file for, is a fact the implementer must see — but it
   * is not a reason to refuse the phase, because the map is written by the same
   * model whose work it describes.
   */
  specWarnings(run: RunState): string[] {
    const designDriven = run.workflow === 'solution-analysis' || run.sourceAnalysisRunId !== undefined;
    const report = this.specReport(run, []);
    if (!report.present) {
      return designDriven
        ? [`${SPEC_MAP_ARTIFACT} is missing; this run cannot be traced back to a design document`]
        : [];
    }
    const warnings = report.errors.map((error) => `unreadable traceability row — ${error}`);
    for (const id of report.unmapped) {
      warnings.push(`${id} has no code path yet; the design requirement is unclaimed`);
    }
    for (const path of report.staleDesignSources) {
      warnings.push(`design source ${path} changed since the map was approved; re-check the affected rows`);
    }
    return warnings;
  }

  /**
   * Publish the validated analysis to a readable directory in the repository.
   * Run evidence under `runs/<runId>/` stays canonical and machine-owned; this
   * is the copy a human is expected to open, so it is written by `cw` rather
   * than by a gated editor tool.
   */
  private publishAnalysisReport(run: RunState): string | undefined {
    const dirName = this.config.analysisReportDir ?? DEFAULT_CONFIG.analysisReportDir;
    if (!dirName.trim()) return undefined;
    const slug = (run.label ?? '')
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const target = resolve(
      this.paths.projectRoot,
      dirName,
      slug ? `${run.runId}-${slug}` : run.runId,
    );
    mkdirSync(target, { recursive: true });
    for (const name of SOLUTION_ANALYSIS_ARTIFACTS) {
      copyFileSync(join(this.paths.runDir(run.runId), name), join(target, name));
    }
    return relative(this.paths.projectRoot, target).replace(/\\/g, '/');
  }

  private assertSolutionAnalysisRun(run: RunState): void {
    if (run.workflow !== 'solution-analysis') {
      throw new sm.TransitionError(`run ${run.runId} is ${run.workflow}, not solution-analysis`);
    }
  }

  /**
   * Validate the seven-file contract, capture the relevant-source fingerprint and
   * park the run for explicit approval. No repository source is mutated.
   */
  markAnalysisReady(opts: { runId?: string; sources: string[] }): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'mark its analysis ready');
    this.assertSolutionAnalysisRun(run);
    if (run.currentNode !== 'analysis') {
      throw new sm.TransitionError(
        `analysis readiness is recorded from "analysis" (current node is "${run.currentNode}")`,
      );
    }
    const valid = this.validArtifacts(run.runId);
    const missing = SOLUTION_ANALYSIS_ARTIFACTS.filter((name) => !valid.includes(name));
    if (missing.length) {
      throw new sm.TransitionError(
        `solution analysis is incomplete: missing or unusable ${missing.join(', ')} in ${this.paths.runDir(run.runId)}`,
      );
    }

    const map = this.readSpecMap(run.runId);
    if (map?.errors.length) {
      throw new sm.TransitionError(
        `${SPEC_MAP_ARTIFACT} is not a usable traceability map:\n  - ${map.errors.join('\n  - ')}`,
      );
    }

    const now = this.now();
    const sourceSnapshot = this.sourceSnapshot([
      ...opts.sources,
      ...this.citedDesignSources(run.runId),
    ]);
    const reportDir = this.publishAnalysisReport(run);
    run.analysis = {
      status: 'ANALYSIS_READY',
      readyAt: now,
      sourceSnapshot,
      ...(reportDir ? { reportDir } : {}),
    };
    const def = this.workflow(run.workflow);
    sm.completeNode(def, run, 'analysis', now);
    this.record(run, 'NODE_COMPLETE', { node: 'analysis' });
    sm.enterNode(def, run, 'approval', now);
    this.record(run, 'NODE_ENTER', { node: 'approval' });
    sm.waitGate(def, run, 'ANALYSIS_APPROVED', now);
    this.record(run, 'GATE_WAIT', {
      gate: 'ANALYSIS_APPROVED',
      node: run.currentNode,
      message: 'analysis ready; explicit solution and scope approval required',
    });
    this.record(run, 'ANALYSIS_READY', {
      node: run.currentNode,
      data: { sourceFiles: sourceSnapshot.map((entry) => entry.path) },
    });
    return this.persist(run);
  }

  /** Persist the explicit human decision and open the analysis handoff gate. */
  approveAnalysis(
    opts: { runId?: string; approvedSolution: string; approvedScope: string },
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'approve its analysis');
    this.assertSolutionAnalysisRun(run);
    if (run.analysis?.status !== 'ANALYSIS_READY') {
      throw new sm.TransitionError(`run ${run.runId} is not ANALYSIS_READY`);
    }
    if (!opts.approvedSolution.trim() || !opts.approvedScope.trim()) {
      throw new sm.TransitionError('analysis approval requires non-empty --solution and --scope');
    }
    const def = this.workflow(run.workflow);
    const check = sm.checkGatePass(def, run, 'ANALYSIS_APPROVED', this.validArtifacts(run.runId));
    if (!check.ok) throw new sm.TransitionError(check.reason ?? 'analysis approval gate cannot pass');
    const now = this.now();
    const approval = {
      analysisRunId: run.runId,
      approvedAt: now,
      approvedSolution: opts.approvedSolution.trim(),
      approvedScope: opts.approvedScope.trim(),
    };
    run.analysis = {
      ...run.analysis,
      status: 'APPROVED',
      approval,
    };
    sm.passGate(def, run, 'ANALYSIS_APPROVED', now);
    this.record(run, 'GATE_PASS', {
      gate: 'ANALYSIS_APPROVED',
      node: run.currentNode,
      message: 'explicit solution and scope approval persisted',
    });
    this.record(run, 'ANALYSIS_APPROVED', {
      node: run.currentNode,
      data: {
        analysisRunId: run.runId,
        approvedAt: now,
        approvedSolution: approval.approvedSolution,
        approvedScope: approval.approvedScope,
      },
    });
    return this.persist(run);
  }

  /**
   * Finish an approved analysis run and create a linked feature-change run.
   * Canonical artifacts are copied byte-for-byte; the run-id link remains the
   * authority, so this is not a free-form prompt handoff.
   */
  handoffAnalysis(opts: { runId?: string; label?: string } = {}): RunState {
    const analysis = this.resolveRun(opts.runId);
    this.assertOwnership(analysis, 'handoff its analysis');
    this.assertSolutionAnalysisRun(analysis);
    if (analysis.analysis?.status !== 'APPROVED' || !analysis.analysis.approval) {
      throw new sm.TransitionError(`run ${analysis.runId} needs explicit approval before handoff`);
    }
    const missing = SOLUTION_ANALYSIS_ARTIFACTS.filter(
      (name) => !this.validArtifacts(analysis.runId).includes(name),
    );
    if (missing.length) {
      throw new sm.TransitionError(`approved analysis lost required artifact(s): ${missing.join(', ')}`);
    }

    // Validate a project override before completing the source run. A stale
    // custom feature topology remains usable in legacy mode and gets a safe
    // doctor warning, but cannot silently accept an unsupported handoff.
    const featureDef = this.workflow('feature-change');
    if (!sm.findNode(featureDef, 'freshness') || !featureDef.edges.some((e) => e.from === 'prompt' && e.to === 'freshness')) {
      throw new sm.TransitionError(
        'feature-change does not expose the analysis freshness branch. Preserve the custom workflow and merge the new "freshness" node, or run claude-workflow-kit doctor.',
      );
    }
    if (!sm.gatesOf(featureDef).includes('BUSINESS_READY')) {
      throw new sm.TransitionError('feature-change handoff requires the existing BUSINESS_READY gate');
    }

    const analysisDef = this.workflow(analysis.workflow);
    const now = this.now();
    sm.enterNode(analysisDef, analysis, 'done', now);
    const complete = sm.checkRunComplete(analysisDef, analysis, this.validArtifacts(analysis.runId));
    if (!complete.ok) {
      throw new sm.TransitionError(`approved analysis cannot finish: ${complete.reasons.join('; ')}`);
    }
    sm.completeRun(analysisDef, analysis, now);
    this.record(analysis, 'RUN_COMPLETED', { node: analysis.currentNode });
    this.persist(analysis);
    this.unbindRun(analysis.runId);
    if (this.currentRunId() === analysis.runId) writeCurrentRunId(this.paths, undefined);

    const feature = this.startRun('feature-change', { label: opts.label ?? analysis.label });
    feature.sourceAnalysisRunId = analysis.runId;
    feature.analysisHandoff = {
      sourceAnalysisRunId: analysis.runId,
      freshness: 'UNCHECKED',
    };

    for (const name of SOLUTION_ANALYSIS_ARTIFACTS) {
      copyFileSync(
        resolve(this.paths.runDir(analysis.runId), name),
        resolve(this.paths.runDir(feature.runId), name),
      );
    }
    // Compatibility aliases let existing implementation/reviewer skills read
    // their legacy filenames while canonical handoff files remain unchanged.
    copyFileSync(
      resolve(this.paths.runDir(feature.runId), 'recommended-solution.md'),
      resolve(this.paths.runDir(feature.runId), 'business-decision.md'),
    );
    copyFileSync(
      resolve(this.paths.runDir(feature.runId), 'impact-analysis.md'),
      resolve(this.paths.runDir(feature.runId), 'impact-risk-scope.md'),
    );

    for (const nodeId of ['evidence', 'business', 'readiness']) {
      const state = feature.nodes[nodeId];
      if (!state) continue;
      state.status = 'SKIPPED';
      state.finishedAt = now;
    }
    sm.enterNode(featureDef, feature, 'freshness', now);
    this.record(feature, 'NODE_ENTER', { node: 'freshness' });
    this.record(feature, 'ANALYSIS_HANDOFF', {
      node: 'freshness',
      message: `feature-change linked to approved analysis ${analysis.runId}`,
      data: { sourceAnalysisRunId: analysis.runId },
    });
    this.record(analysis, 'ANALYSIS_HANDOFF', {
      node: analysis.currentNode,
      message: `handed off to feature run ${feature.runId}`,
      data: { featureRunId: feature.runId },
    });
    return this.persist(feature);
  }

  /** Compare the relevant-source hashes and inherit BUSINESS_READY only if valid. */
  checkAnalysisFreshness(opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'check its analysis freshness');
    if (run.workflow !== 'feature-change' || !run.sourceAnalysisRunId || !run.analysisHandoff) {
      throw new sm.TransitionError('analysis freshness applies only to a linked feature-change run');
    }
    if (run.currentNode !== 'freshness') {
      throw new sm.TransitionError(`freshness is checked at "freshness" (current node is "${run.currentNode}")`);
    }
    const source = this.run(run.sourceAnalysisRunId);
    if (source.analysis?.status !== 'APPROVED' || !source.analysis.approval) {
      throw new sm.TransitionError(`source analysis ${source.runId} is no longer approved`);
    }
    const snapshot = run.analysisHandoff.sourceSnapshot ?? source.analysis.sourceSnapshot ?? [];
    if (!snapshot.length) {
      throw new sm.TransitionError(`source analysis ${source.runId} has no relevant-source snapshot`);
    }
    const stalePaths = this.staleSnapshotPaths(snapshot);
    const now = this.now();
    run.analysisHandoff.checkedAt = now;
    if (stalePaths.length) {
      run.analysisHandoff.freshness = 'STALE';
      run.analysisHandoff.stalePaths = stalePaths;
      run.gates['BUSINESS_READY'] = 'OPEN';
      this.record(run, 'ANALYSIS_FRESHNESS', {
        node: run.currentNode,
        message: `STALE: ${stalePaths.join(', ')}`,
        data: { status: 'STALE', stalePaths },
      });
      return this.persist(run);
    }

    run.analysisHandoff.freshness = 'VALID';
    delete run.analysisHandoff.stalePaths;
    run.gates['BUSINESS_READY'] = 'PASSED';
    const provenance = run.gateProvenance ?? (run.gateProvenance = {});
    provenance['BUSINESS_READY'] = {
      decidedAtNode: 'freshness',
      decidedAt: now,
    };
    this.record(run, 'GATE_PASS', {
      gate: 'BUSINESS_READY',
      node: run.currentNode,
      message: `inherited from approved analysis ${source.runId}; source snapshot valid`,
    });
    this.record(run, 'ANALYSIS_FRESHNESS', {
      node: run.currentNode,
      message: 'VALID',
      data: { status: 'VALID', sourceAnalysisRunId: source.runId },
    });
    return this.persist(run);
  }

  /** Record a targeted refresh baseline after stale artifacts were updated. */
  refreshAnalysisHandoff(
    opts: { runId?: string; sources: string[]; reason: string },
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'refresh its linked analysis');
    if (run.workflow !== 'feature-change' || !run.analysisHandoff || run.currentNode !== 'freshness') {
      throw new sm.TransitionError('analysis refresh applies only at a linked feature freshness phase');
    }
    if (!opts.reason.trim()) throw new sm.TransitionError('analysis refresh requires --reason');
    const valid = this.validArtifacts(run.runId);
    const missing = SOLUTION_ANALYSIS_ARTIFACTS.filter((name) => !valid.includes(name));
    if (missing.length) throw new sm.TransitionError(`cannot refresh: missing ${missing.join(', ')}`);
    copyFileSync(
      resolve(this.paths.runDir(run.runId), 'recommended-solution.md'),
      resolve(this.paths.runDir(run.runId), 'business-decision.md'),
    );
    copyFileSync(
      resolve(this.paths.runDir(run.runId), 'impact-analysis.md'),
      resolve(this.paths.runDir(run.runId), 'impact-risk-scope.md'),
    );
    const now = this.now();
    run.analysisHandoff.sourceSnapshot = this.sourceSnapshot([
      ...opts.sources,
      ...this.citedDesignSources(run.runId),
    ]);
    run.analysisHandoff.freshness = 'UNCHECKED';
    run.analysisHandoff.refreshedAt = now;
    run.analysisHandoff.refreshReason = opts.reason.trim();
    delete run.analysisHandoff.checkedAt;
    delete run.analysisHandoff.stalePaths;
    run.gates['BUSINESS_READY'] = 'OPEN';
    this.record(run, 'ANALYSIS_REFRESHED', {
      node: run.currentNode,
      message: opts.reason.trim(),
      data: { sourceFiles: run.analysisHandoff.sourceSnapshot.map((entry) => entry.path) },
    });
    return this.persist(run);
  }

  private assertFreshHandoffBeforeLeaving(run: RunState, leaving: string, target?: string): void {
    if (
      run.workflow === 'feature-change' &&
      run.sourceAnalysisRunId &&
      leaving === 'freshness' &&
      target !== 'freshness' &&
      run.analysisHandoff?.freshness !== 'VALID'
    ) {
      const stale = run.analysisHandoff?.stalePaths?.join(', ');
      throw new sm.TransitionError(
        `approved analysis is ${run.analysisHandoff?.freshness ?? 'UNCHECKED'}${stale ? ` (${stale})` : ''}; ` +
          'refresh affected analysis artifacts and rerun cw analysis freshness before implementation',
      );
    }
  }

  // ---- mission control -----------------------------------------------------

  /** The mission record, created on first use. */
  private missionOf(run: RunState): mc.MissionRecord {
    if (!run.mission) run.mission = mc.emptyMission(this.now());
    return run.mission;
  }

  private touchMission(run: RunState, mission: mc.MissionRecord): void {
    const now = this.now();
    mission.updatedAt = now;
    run.updatedAt = now;
    run.lastActivityAt = now;
    run.lastSemanticAt = now;
  }

  /** Mission record of a run, or undefined when it never classified. */
  mission(runId?: string): mc.MissionRecord | undefined {
    return this.resolveRun(runId).mission;
  }

  missionBoard(runId?: string): mc.MissionBoardView {
    const run = this.resolveRun(runId);
    return mc.buildMissionBoard(run, this.workflow(run.workflow), {
      runStatus: this.derivedStatus(run),
    });
  }

  /** Blockers between the mission and its implementation phase. */
  missionReadiness(runId?: string): mc.MissionReadiness {
    const run = this.resolveRun(runId);
    return mc.implementationReadiness(run.mission ?? mc.emptyMission(run.updatedAt));
  }

  /**
   * Classify the mission and route it. The router picks the shortest safe
   * workflow; when that is deeper than the running topology the run is escalated
   * in place, so the run id, evidence and history survive the upgrade.
   */
  classifyMission(opts: {
    runId?: string;
    taskType: mc.TaskType;
    subtypes?: mc.TaskType[];
    complexity: mc.Complexity;
    riskLevel?: mc.RiskLevel;
    flags?: mc.MissionFlags;
    requestedClass?: mc.WorkflowClass;
    reason?: string;
    /** Adopt the routed topology even when it means escalating the run. */
    route?: boolean;
  }): { run: RunState; route: mc.RouteResult } {
    let run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'classify it');
    const routeInput: mc.RouteInput = {
      taskType: opts.taskType,
      complexity: opts.complexity,
    };
    if (opts.subtypes) routeInput.subtypes = opts.subtypes;
    if (opts.riskLevel) routeInput.riskLevel = opts.riskLevel;
    if (opts.flags) routeInput.flags = opts.flags;
    if (opts.requestedClass) routeInput.requestedClass = opts.requestedClass;
    const route = mc.routeMission(routeInput);

    // Routing to a deeper topology is an escalation, not a new task.
    if (route.topology !== run.workflow && opts.route !== false) {
      try {
        run = this.escalateRun(route.topology, {
          runId: run.runId,
          reason: `mission classified ${opts.complexity}/${route.riskLevel} -> ${route.workflowClass}`,
        });
      } catch (error) {
        this.lastWarning =
          `mission routes to "${route.topology}" but the run stays on "${run.workflow}": ` +
          `${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const mission = this.missionOf(run);
    const classification: mc.MissionClassification = {
      taskType: opts.taskType,
      subtypes: opts.subtypes ?? [],
      complexity: opts.complexity,
      riskLevel: route.riskLevel,
      workflowClass: route.workflowClass,
      topology: run.workflow,
      effort: route.effort,
      reason: opts.reason ? `${opts.reason} (${route.reason})` : route.reason,
      flags: opts.flags ?? {},
      classifiedAt: this.now(),
    };
    mission.classification = classification;
    if (mission.state === 'RECEIVED' || mission.state === 'CLASSIFYING') mission.state = 'PLANNING';
    this.touchMission(run, mission);
    this.record(run, 'MISSION_CLASSIFIED', {
      node: run.currentNode,
      message:
        `${classification.taskType} / ${classification.complexity} / risk ${classification.riskLevel} ` +
        `-> ${classification.workflowClass} (${classification.topology})`,
      data: {
        classification,
        requiredCheckpoints: route.requiredCheckpoints,
        validation: route.validation,
        confidenceThresholds: route.confidenceThresholds,
      },
    });
    return { run: this.persist(run), route };
  }

  /** Persist the Execution Plan. Scope and out-of-scope are both required. */
  planMission(opts: {
    runId?: string;
    objective: string;
    scope: string[];
    outOfScope?: string[];
    assumptions?: string[];
    dependencies?: string[];
    stopConditions?: string[];
    successCriteria?: string[];
    requiredSteps?: string[];
    skippedSteps?: string[];
    validation?: string[];
  }): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'plan it');
    if (!opts.objective.trim()) throw new sm.TransitionError('cw mission plan requires --objective');
    if (!opts.scope.length) throw new sm.TransitionError('cw mission plan requires --scope "a,b,c"');
    const mission = this.missionOf(run);
    const classification = mission.classification;
    const plan: mc.MissionPlan = {
      objective: opts.objective.trim(),
      scope: opts.scope,
      outOfScope: opts.outOfScope ?? [],
      assumptions: opts.assumptions ?? [],
      dependencies: opts.dependencies ?? [],
      stopConditions: opts.stopConditions ?? [],
      successCriteria: opts.successCriteria ?? [],
      requiredSteps: opts.requiredSteps ?? [],
      skippedSteps: opts.skippedSteps ?? [],
      validation:
        opts.validation ??
        (classification ? mc.validationStrategy(classification.workflowClass, classification.flags) : []),
      createdAt: this.now(),
    };
    mission.plan = plan;
    if (mission.state === 'RECEIVED' || mission.state === 'CLASSIFYING') mission.state = 'PLANNING';
    this.touchMission(run, mission);
    this.record(run, 'MISSION_PLANNED', {
      node: run.currentNode,
      message: plan.objective,
      data: { plan },
    });
    return this.persist(run);
  }

  /**
   * Move the mission state. Illegal jumps are refused: a mission that reports
   * IMPLEMENTING straight out of PLANNING is a board that lies about its own
   * process. `force` records the jump instead of hiding it.
   */
  setMissionState(state: mc.MissionState, opts: { runId?: string; force?: boolean; message?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'change its mission state');
    const mission = this.missionOf(run);
    const from = mission.state;
    if (!mc.missionStateAllowed(from, state)) {
      if (!opts.force) {
        throw new sm.TransitionError(
          `mission state ${from} -> ${state} is not a legal transition. ` +
            `Legal from here: ${mc.MISSION_STATES.filter((s) => mc.missionStateAllowed(from, s) && s !== from).join(', ')}. ` +
            `Force it deliberately with --force if the mission really jumped.`,
        );
      }
    }
    if (state === 'IMPLEMENTING') this.assertImplementationReady(run, 'IMPLEMENTING');
    mission.state = state;
    if (state !== 'PAUSED') {
      delete mission.stateBeforePause;
      delete mission.pauseReason;
    }
    this.touchMission(run, mission);
    this.record(run, 'MISSION_STATE', {
      node: run.currentNode,
      message: `${from} -> ${state}${opts.message ? `: ${opts.message}` : ''}`,
      data: { from, to: state, forced: Boolean(opts.force) && !mc.missionStateAllowed(from, state) },
    });
    return this.persist(run);
  }

  pauseMission(opts: { runId?: string; reason?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'pause it');
    const mission = this.missionOf(run);
    if (mission.state === 'PAUSED') return run;
    if (mc.TERMINAL_MISSION_STATES.includes(mission.state)) {
      throw new sm.TransitionError(`mission is already ${mission.state} and cannot be paused`);
    }
    mission.stateBeforePause = mission.state;
    mission.state = 'PAUSED';
    if (opts.reason) mission.pauseReason = opts.reason;
    this.touchMission(run, mission);
    this.record(run, 'MISSION_PAUSED', {
      node: run.currentNode,
      message: opts.reason ?? 'paused by the user',
    });
    return this.persist(run);
  }

  resumeMission(opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'resume it');
    const mission = this.missionOf(run);
    if (mission.state !== 'PAUSED') return run;
    const target = mission.stateBeforePause ?? 'INVESTIGATING';
    mission.state = target;
    delete mission.stateBeforePause;
    delete mission.pauseReason;
    this.touchMission(run, mission);
    this.record(run, 'MISSION_RESUMED', { node: run.currentNode, message: `resumed at ${target}` });
    return this.persist(run);
  }

  /**
   * The user withdraws the mission. The run itself is retired through
   * `run abandon`, which keeps "cancelled by the user" distinct from "finished".
   */
  cancelMission(opts: { runId?: string; reason: string }): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'cancel it');
    if (!opts.reason.trim()) throw new sm.TransitionError('cancelling a mission requires a reason');
    const mission = this.missionOf(run);
    mission.state = 'CANCELLED';
    this.touchMission(run, mission);
    this.record(run, 'MISSION_CANCELLED', { node: run.currentNode, message: opts.reason });
    this.persist(run);
    return this.abandonRun({ runId: run.runId, message: `mission cancelled: ${opts.reason}` });
  }

  setConfidence(
    dimension: mc.ConfidenceDimension,
    value: number,
    opts: { runId?: string; note?: string } = {},
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'record its confidence');
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new sm.TransitionError('confidence must be a number between 0 and 100');
    }
    const mission = this.missionOf(run);
    const previous = mission.confidence[dimension];
    mission.confidence[dimension] = Math.round(value);
    this.touchMission(run, mission);
    this.record(run, 'CONFIDENCE_UPDATED', {
      node: run.currentNode,
      message: `${dimension} ${previous ?? '—'} -> ${Math.round(value)}%${opts.note ? `: ${opts.note}` : ''}`,
      data: { dimension, value: Math.round(value), previous },
    });
    return this.persist(run);
  }

  setEvidence(
    category: mc.EvidenceCategory,
    status: mc.EvidenceStatus,
    opts: { runId?: string; note?: string } = {},
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'record its evidence');
    const mission = this.missionOf(run);
    const record: mc.EvidenceRecord = { status, updatedAt: this.now() };
    if (opts.note) record.note = opts.note;
    mission.evidence[category] = record;
    this.touchMission(run, mission);
    this.record(run, 'EVIDENCE_UPDATED', {
      node: run.currentNode,
      message: `${category}=${status}${opts.note ? `: ${opts.note}` : ''}`,
      data: { category, status },
    });
    return this.persist(run);
  }

  /** Record or update a risk. An escalation is an event, not a silent rewrite. */
  recordRisk(opts: {
    runId?: string;
    id?: string;
    category: mc.RiskCategory;
    level: mc.RiskLevel;
    trigger: string;
    evidence?: string;
    probability?: string;
    impact?: string;
    mitigation?: string;
    status?: mc.RiskRecord['status'];
    requiredDecision?: string;
  }): { run: RunState; risk: mc.RiskRecord; escalated: boolean } {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'record its risks');
    if (!opts.trigger.trim()) throw new sm.TransitionError('a risk needs --trigger "<what raised it>"');
    const mission = this.missionOf(run);
    const id = opts.id ?? `R-${String(mission.risks.length + 1).padStart(3, '0')}`;
    const existing = mission.risks.find((r) => r.id === id);
    const now = this.now();
    const previousLevel = existing?.level;
    const risk: mc.RiskRecord = {
      id,
      category: opts.category,
      level: opts.level,
      trigger: opts.trigger.trim(),
      status: opts.status ?? existing?.status ?? 'OPEN',
      peakLevel:
        existing && mc.RISK_LEVELS.indexOf(existing.peakLevel) > mc.RISK_LEVELS.indexOf(opts.level)
          ? existing.peakLevel
          : opts.level,
      updatedAt: now,
    };
    for (const key of ['evidence', 'probability', 'impact', 'mitigation', 'requiredDecision'] as const) {
      const value = opts[key] ?? existing?.[key];
      if (value) risk[key] = value;
    }
    if (existing) mission.risks[mission.risks.indexOf(existing)] = risk;
    else mission.risks.push(risk);

    const escalated =
      previousLevel !== undefined &&
      mc.RISK_LEVELS.indexOf(opts.level) > mc.RISK_LEVELS.indexOf(previousLevel);
    this.touchMission(run, mission);
    this.record(run, escalated ? 'RISK_ESCALATED' : 'RISK_RECORDED', {
      node: run.currentNode,
      message: `${id} ${opts.category} ${previousLevel ? `${previousLevel} -> ` : ''}${opts.level}: ${risk.trigger}`,
      data: { risk, previousLevel },
    });
    // Medium -> High opens a checkpoint by contract; Critical stops the work.
    if (escalated && (opts.level === 'HIGH' || opts.level === 'CRITICAL')) {
      this.lastWarning =
        `risk ${id} escalated to ${opts.level}. ` +
        (opts.level === 'CRITICAL'
          ? 'Implementation is blocked until it is mitigated or explicitly accepted.'
          : `Open a checkpoint: cw checkpoint open HIGH_RISK --summary "..." --decision "..."`);
    }
    return { run: this.persist(run), risk, escalated };
  }

  /** A technical decision with its reason, evidence, alternatives and risk. */
  recordDecision(opts: {
    runId?: string;
    id?: string;
    decision: string;
    reason: string;
    evidence?: string[];
    confidence?: number;
    alternatives?: string[];
    rejected?: string[];
    impact?: string;
    risk?: mc.RiskLevel;
    reversibility?: string;
    approvalRequired?: boolean;
  }): { run: RunState; decision: mc.DecisionRecord } {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'record its decisions');
    if (!opts.decision.trim() || !opts.reason.trim()) {
      throw new sm.TransitionError('a decision needs both --decision and --reason');
    }
    const mission = this.missionOf(run);
    const decision: mc.DecisionRecord = {
      id: opts.id ?? `D-${String(mission.decisions.length + 1).padStart(3, '0')}`,
      decision: opts.decision.trim(),
      reason: opts.reason.trim(),
      evidence: opts.evidence ?? [],
      alternatives: opts.alternatives ?? [],
      rejected: opts.rejected ?? [],
      approvalRequired: opts.approvalRequired ?? false,
      at: this.now(),
    };
    if (opts.confidence !== undefined) decision.confidence = Math.round(opts.confidence);
    if (opts.impact) decision.impact = opts.impact;
    if (opts.risk) decision.risk = opts.risk;
    if (opts.reversibility) decision.reversibility = opts.reversibility;
    mission.decisions.push(decision);
    this.touchMission(run, mission);
    this.record(run, 'DECISION_RECORDED', {
      node: run.currentNode,
      message: `${decision.id}: ${decision.decision}`,
      data: { decision },
    });
    return { run: this.persist(run), decision };
  }

  /** Add a task to the breakdown. Mid-mission additions must justify themselves. */
  addMissionTask(opts: {
    runId?: string;
    id?: string;
    epic: string;
    title: string;
    weight?: number;
    reason?: string;
    evidence?: string;
    status?: mc.MissionTaskStatus;
  }): { run: RunState; task: mc.MissionTask } {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'change its task breakdown');
    if (!opts.epic.trim() || !opts.title.trim()) {
      throw new sm.TransitionError('a task needs --epic and --title');
    }
    const mission = this.missionOf(run);
    // A task added after planning is scope movement, so it carries a reason.
    const planned = !mission.plan || mission.state === 'PLANNING' || mission.state === 'CLASSIFYING';
    if (!planned && !opts.reason?.trim()) {
      throw new sm.TransitionError(
        'a task added after the plan needs --reason "<why this mission needs it>" (evidence, not tidiness)',
      );
    }
    const task: mc.MissionTask = {
      id: opts.id ?? `T-${String(mission.tasks.length + 1).padStart(3, '0')}`,
      epic: opts.epic.trim(),
      title: opts.title.trim(),
      status: opts.status ?? 'PENDING',
      weight: opts.weight && opts.weight > 0 ? opts.weight : 1,
      updatedAt: this.now(),
    };
    if (opts.reason) task.reason = opts.reason.trim();
    if (opts.evidence) task.evidence = opts.evidence;
    mission.tasks.push(task);
    this.touchMission(run, mission);
    this.record(run, 'TASK_ADDED', {
      node: run.currentNode,
      message: `${task.id} ${task.epic}: ${task.title}${task.reason ? ` (${task.reason})` : ''}`,
      data: { task },
    });
    return { run: this.persist(run), task };
  }

  updateMissionTask(
    id: string,
    status: mc.MissionTaskStatus,
    opts: { runId?: string; message?: string } = {},
  ): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'change its task breakdown');
    const mission = this.missionOf(run);
    const task = mission.tasks.find((t) => t.id === id);
    if (!task) {
      throw new sm.TransitionError(
        `no task "${id}" in this mission (known: ${mission.tasks.map((t) => t.id).join(', ') || 'none'})`,
      );
    }
    const previous = task.status;
    task.status = status;
    task.updatedAt = this.now();
    this.touchMission(run, mission);
    this.record(run, 'TASK_UPDATED', {
      node: run.currentNode,
      message: `${id} ${previous} -> ${status}${opts.message ? `: ${opts.message}` : ''}`,
      data: { taskId: id, from: previous, to: status },
    });
    return this.persist(run);
  }

  /**
   * Park the mission on a human decision. A blocking checkpoint denies repository
   * mutation while it is pending, which is what makes it a checkpoint rather than
   * a printed suggestion.
   */
  openCheckpoint(opts: {
    runId?: string;
    id?: string;
    kind: mc.CheckpointKind;
    summary: string;
    decisionRequired: string;
    recommendation?: string;
    alternatives?: string[];
    evidence?: string[];
    risk?: mc.RiskLevel;
    impact?: string;
    confidence?: number;
  }): { run: RunState; checkpoint: mc.Checkpoint } {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'open its checkpoints');
    if (!opts.summary.trim() || !opts.decisionRequired.trim()) {
      throw new sm.TransitionError('a checkpoint needs --summary and --decision "<what the user must decide>"');
    }
    const mission = this.missionOf(run);
    const open = mission.checkpoints.find((c) => c.status === 'PENDING' && c.kind === opts.kind);
    if (open) {
      throw new sm.TransitionError(
        `checkpoint ${open.id} (${opts.kind}) is already pending; resolve it before opening another`,
      );
    }
    const checkpoint: mc.Checkpoint = {
      id: opts.id ?? `CP-${String(mission.checkpoints.length + 1).padStart(3, '0')}`,
      kind: opts.kind,
      summary: opts.summary.trim(),
      decisionRequired: opts.decisionRequired.trim(),
      alternatives: opts.alternatives ?? [],
      evidence: opts.evidence ?? [],
      status: 'PENDING',
      openedAt: this.now(),
      openedAtNode: run.currentNode,
    };
    if (opts.recommendation) checkpoint.recommendation = opts.recommendation;
    if (opts.risk) checkpoint.risk = opts.risk;
    if (opts.impact) checkpoint.impact = opts.impact;
    if (opts.confidence !== undefined) checkpoint.confidence = Math.round(opts.confidence);
    mission.checkpoints.push(checkpoint);

    const waitingState: Partial<Record<mc.CheckpointKind, mc.MissionState>> = {
      PLAN: 'WAITING_PLAN_APPROVAL',
      INVESTIGATION: 'WAITING_INVESTIGATION_APPROVAL',
      ROOT_CAUSE: 'WAITING_INVESTIGATION_APPROVAL',
      ARCHITECTURE: 'WAITING_DESIGN_APPROVAL',
      DESIGN: 'WAITING_DESIGN_APPROVAL',
      HIGH_RISK: 'WAITING_DESIGN_APPROVAL',
      CODE: 'WAITING_CODE_APPROVAL',
      RELEASE: 'WAITING_RELEASE_APPROVAL',
    };
    const target = waitingState[opts.kind];
    if (target && mc.missionStateAllowed(mission.state, target)) mission.state = target;
    this.touchMission(run, mission);
    this.record(run, 'CHECKPOINT_OPENED', {
      node: run.currentNode,
      message: `${checkpoint.id} [${opts.kind}] ${checkpoint.decisionRequired}`,
      data: { checkpoint },
    });
    return { run: this.persist(run), checkpoint };
  }

  /** Record the human answer. Only the user's decision closes a checkpoint. */
  resolveCheckpoint(
    id: string,
    opts: {
      runId?: string;
      action: 'approve' | 'reject' | 'modify' | 'cancel';
      note?: string;
      via?: 'cli' | 'board';
      /** Mission state to continue in; defaults per action. */
      nextState?: mc.MissionState;
    },
  ): { run: RunState; checkpoint: mc.Checkpoint } {
    const run = this.resolveRun(opts.runId);
    const mission = this.missionOf(run);
    const checkpoint = mission.checkpoints.find((c) => c.id === id);
    if (!checkpoint) {
      throw new sm.TransitionError(
        `no checkpoint "${id}" (pending: ${mc.pendingCheckpoints(mission).map((c) => c.id).join(', ') || 'none'})`,
      );
    }
    if (checkpoint.status !== 'PENDING') {
      throw new sm.TransitionError(`checkpoint ${id} is already ${checkpoint.status}`);
    }
    const statusByAction = {
      approve: 'APPROVED',
      reject: 'REJECTED',
      modify: 'MODIFIED',
      cancel: 'CANCELLED',
    } as const;
    if ((opts.action === 'reject' || opts.action === 'modify') && !opts.note?.trim()) {
      throw new sm.TransitionError(`"${opts.action}" needs --note "<what to change and why>"`);
    }
    checkpoint.status = statusByAction[opts.action];
    checkpoint.respondedAt = this.now();
    checkpoint.respondedVia = opts.via ?? 'cli';
    if (opts.note) checkpoint.response = opts.note.trim();

    const continueState: Partial<Record<mc.CheckpointKind, mc.MissionState>> = {
      PLAN: 'INVESTIGATING',
      INVESTIGATION: 'DESIGNING',
      ROOT_CAUSE: 'DESIGNING',
      ARCHITECTURE: 'READY_TO_IMPLEMENT',
      DESIGN: 'READY_TO_IMPLEMENT',
      HIGH_RISK: 'READY_TO_IMPLEMENT',
      CODE: 'VALIDATING',
      RELEASE: 'DELIVERING',
    };
    const reworkState: Partial<Record<mc.CheckpointKind, mc.MissionState>> = {
      PLAN: 'PLANNING',
      INVESTIGATION: 'INVESTIGATING',
      ROOT_CAUSE: 'INVESTIGATING',
      ARCHITECTURE: 'DESIGNING',
      DESIGN: 'DESIGNING',
      HIGH_RISK: 'DESIGNING',
      CODE: 'IMPLEMENTING',
      RELEASE: 'VALIDATING',
    };
    const next =
      opts.nextState ??
      (opts.action === 'approve' ? continueState[checkpoint.kind] : reworkState[checkpoint.kind]);
    if (next && mc.missionStateAllowed(mission.state, next)) mission.state = next;
    this.touchMission(run, mission);
    this.record(run, 'CHECKPOINT_RESOLVED', {
      node: run.currentNode,
      message: `${id} ${checkpoint.status}${checkpoint.response ? `: ${checkpoint.response}` : ''}`,
      data: { checkpointId: id, action: opts.action, via: checkpoint.respondedVia, missionState: mission.state },
    });
    return { run: this.persist(run), checkpoint };
  }

  /**
   * "Proceed Anyway": the user takes the listed blockers on knowingly. The waiver
   * is permanent provenance — it never reads as a mission that had no blockers.
   */
  acceptMissionRisk(opts: { runId?: string; reason: string; blockers?: string[] }): {
    run: RunState;
    accepted: string[];
  } {
    const run = this.resolveRun(opts.runId);
    if (!opts.reason.trim()) {
      throw new sm.TransitionError('accepting a blocker requires --reason "<why proceeding is acceptable>"');
    }
    const mission = this.missionOf(run);
    const current = mc.implementationReadiness(mission);
    const accepted = opts.blockers?.length ? opts.blockers : current.blockers;
    if (!accepted.length) throw new sm.TransitionError('there is nothing to accept: the mission has no blockers');
    mission.acceptances.push({ blockers: accepted, reason: opts.reason.trim(), at: this.now() });
    this.touchMission(run, mission);
    this.record(run, 'ACCEPTED_RISK', {
      node: run.currentNode,
      message: `${opts.reason.trim()} — accepted: ${accepted.join('; ')}`,
      data: { blockers: accepted },
    });
    return { run: this.persist(run), accepted };
  }

  setOffTrack(opts: {
    runId?: string;
    status: 'ON_TRACK' | 'OFF_TRACK';
    expectedScope?: string;
    actualScope?: string;
    reason?: string;
    recommendation?: string;
  }): RunState {
    const run = this.resolveRun(opts.runId);
    const mission = this.missionOf(run);
    const record: mc.OffTrackRecord = { status: opts.status, at: this.now() };
    for (const key of ['expectedScope', 'actualScope', 'reason', 'recommendation'] as const) {
      if (opts[key]) record[key] = opts[key]!;
    }
    mission.offTrack = record;
    this.touchMission(run, mission);
    this.record(run, 'OFF_TRACK', {
      node: run.currentNode,
      message: `${opts.status}${opts.reason ? `: ${opts.reason}` : ''}`,
      data: { offTrack: record },
    });
    return this.persist(run);
  }

  /** Context recovery: a summary the mission can continue from honestly. */
  recordContextSummary(opts: {
    runId?: string;
    summary?: string;
    coverage?: number;
    openQuestions?: string[];
    degraded?: boolean;
  }): RunState {
    const run = this.resolveRun(opts.runId);
    const mission = this.missionOf(run);
    const record: mc.ContextRecord = {
      openQuestions: opts.openQuestions ?? [],
      degraded: opts.degraded ?? false,
      at: this.now(),
    };
    if (opts.summary) record.summary = opts.summary;
    if (opts.coverage !== undefined) record.coverage = Math.round(opts.coverage);
    mission.context = record;
    this.touchMission(run, mission);
    this.record(run, 'CONTEXT_SUMMARY', {
      node: run.currentNode,
      message: record.degraded ? `context DEGRADED: ${record.summary ?? ''}` : record.summary ?? 'context summary',
      data: { context: record },
    });
    return this.persist(run);
  }

  recordScopeChange(opts: {
    runId?: string;
    previousScope: string;
    newScope: string;
    reason: string;
    addedTasks?: string[];
    removedTasks?: string[];
    riskChange?: string;
    workflowChange?: string;
  }): RunState {
    const run = this.resolveRun(opts.runId);
    this.assertOwnership(run, 'change its scope');
    if (!opts.reason.trim()) throw new sm.TransitionError('a scope change requires --reason');
    const mission = this.missionOf(run);
    const record: mc.ScopeChangeRecord = {
      previousScope: opts.previousScope,
      newScope: opts.newScope,
      reason: opts.reason.trim(),
      addedTasks: opts.addedTasks ?? [],
      removedTasks: opts.removedTasks ?? [],
      at: this.now(),
    };
    if (opts.riskChange) record.riskChange = opts.riskChange;
    if (opts.workflowChange) record.workflowChange = opts.workflowChange;
    mission.scopeChanges.push(record);
    if (mission.plan) mission.plan.scope = opts.newScope.split(/\s*[,;]\s*/).filter(Boolean);
    this.touchMission(run, mission);
    this.record(run, 'SCOPE_CHANGED', {
      node: run.currentNode,
      message: `${opts.previousScope} -> ${opts.newScope}: ${record.reason}`,
      data: { scopeChange: record },
    });
    return this.persist(run);
  }

  setDeliverable(opts: {
    runId?: string;
    name: string;
    required: boolean;
    reason?: string;
    status?: mc.Deliverable['status'];
    location?: string;
  }): RunState {
    const run = this.resolveRun(opts.runId);
    const mission = this.missionOf(run);
    const existing = mission.deliverables.find((d) => d.name === opts.name);
    const deliverable: mc.Deliverable = {
      name: opts.name,
      required: opts.required,
      status: opts.status ?? existing?.status ?? (opts.required ? 'PENDING' : 'SKIPPED'),
      updatedAt: this.now(),
    };
    const reason = opts.reason ?? existing?.reason;
    if (reason) deliverable.reason = reason;
    const location = opts.location ?? existing?.location;
    if (location) deliverable.location = location;
    if (existing) mission.deliverables[mission.deliverables.indexOf(existing)] = deliverable;
    else mission.deliverables.push(deliverable);
    this.touchMission(run, mission);
    this.record(run, 'DELIVERABLE_UPDATED', {
      node: run.currentNode,
      message: `${deliverable.name} required=${deliverable.required} ${deliverable.status}`,
      data: { deliverable },
    });
    return this.persist(run);
  }

  /** Current Action on the board. Cheap, so it can be honest. */
  setCurrentAction(action: string, opts: { runId?: string } = {}): RunState {
    const run = this.resolveRun(opts.runId);
    const mission = this.missionOf(run);
    mission.currentAction = action;
    mission.updatedAt = this.now();
    run.updatedAt = mission.updatedAt;
    run.lastActivityAt = mission.updatedAt;
    return this.persist(run);
  }

  /** Refuse to start implementation while the mission says it is not ready. */
  private assertImplementationReady(run: RunState, what: string): void {
    if (!run.mission) return;
    const readiness = mc.implementationReadiness(run.mission);
    if (readiness.ok) return;
    throw new sm.TransitionError(
      `${what} is refused; the mission is not ready:\n  - ${readiness.blockers.join('\n  - ')}\n` +
        `Resolve them, or take them on deliberately: cw mission accept-risk --reason "<why>"`,
    );
  }

  // ---- semantic transitions -------------------------------------------------

  /**
   * Promote a generic prompt or raise the workflow level without replacing the
   * task run. The run id, evidence directory, owner, runtime telemetry, and
   * event log stay intact; only the active topology is replaced and any
   * stricter gates start OPEN.
   */
  escalateRun(
    workflowId: string,
    opts: { runId?: string; reason: string; label?: string },
  ): RunState {
    const current = this.resolveRun(opts.runId);
    this.assertOwnership(current, 'escalate it');
    if (isTerminalRun(current.status)) {
      throw new sm.TransitionError(
        `run ${current.runId} is already ${current.status} and cannot be escalated`,
      );
    }
    if (!opts.reason.trim()) {
      throw new sm.TransitionError('cw run escalate requires --reason "<concrete finding>"');
    }

    const allowed: Record<string, string[]> = {
      'quick-fix': ['standard-change', 'bug-fix', 'feature-change'],
      'standard-change': ['bug-fix', 'feature-change'],
    };
    const permitted = current.workflow === 'generic'
      ? workflowId !== 'generic'
      : allowed[current.workflow]?.includes(workflowId) === true;
    if (!permitted) {
      const targets = current.workflow === 'generic'
        ? 'any concrete workflow'
        : allowed[current.workflow]?.join(', ') || '(none)';
      throw new sm.TransitionError(
        `cannot escalate ${current.workflow} -> ${workflowId}; allowed: ${targets}`,
      );
    }

    const previousWorkflow = current.workflow;
    const now = this.now();
    const next = sm.initialRunState(
      this.workflow(workflowId),
      current.runId,
      now,
      opts.label ?? current.label,
    );
    if (workflowId === 'feature-change' && next.nodes['freshness']) {
      next.nodes['freshness']!.status = 'SKIPPED';
      next.nodes['freshness']!.finishedAt = now;
    }
    next.startedAt = current.startedAt;
    next.ownerSessionId = current.ownerSessionId;
    next.runtime = { ...current.runtime };
    next.agents = { ...current.agents };
    next.artifacts = [...current.artifacts];
    if (current.invalidArtifacts?.length) next.invalidArtifacts = [...current.invalidArtifacts];
    if (current.lastRuntimeAt) next.lastRuntimeAt = current.lastRuntimeAt;
    // Escalation replaces the topology, never the mission: classification,
    // evidence, decisions and open checkpoints belong to the task, not the graph.
    if (current.mission) {
      next.mission = current.mission;
      if (next.mission.classification) next.mission.classification.topology = workflowId;
    }

    writeRun(this.paths, next);
    writeCurrentRunId(this.paths, next.runId);
    this.record(next, previousWorkflow === 'generic' ? 'RUN_ROUTED' : 'RUN_ESCALATED', {
      node: next.currentNode,
      message: `${previousWorkflow} -> ${workflowId}: ${opts.reason}`,
      data: { fromWorkflow: previousWorkflow, toWorkflow: workflowId },
    });
    return this.persist(next);
  }

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
    // UserPromptSubmit opens a lightweight generic run before a routed skill is
    // selected. Promote that same task in place so `cw run start <workflow>` is
    // compatible with the hook and never creates an abandoned shell run.
    if (
      !opts.force &&
      !opts.runId &&
      workflowId !== 'generic' &&
      blocking.length === 1 &&
      blocking[0]!.workflow === 'generic'
    ) {
      return this.escalateRun(workflowId, {
        runId: blocking[0]!.runId,
        reason: `classified active prompt as ${workflowId}`,
        ...(opts.label ? { label: opts.label } : {}),
      });
    }
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
    if (workflowId === 'feature-change' && run.nodes['freshness']) {
      run.nodes['freshness']!.status = 'SKIPPED';
      run.nodes['freshness']!.finishedAt = now;
    }
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
    this.syncUsageQuietly(run);
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
      this.assertFreshHandoffBeforeLeaving(run, run.currentNode, nodeId);
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
      // Entering the phase that changes the repository is the moment the mission
      // has to be ready: evidence, confidence and every open human checkpoint.
      if (mc.isImplementationNode(def, nodeId)) {
        this.assertImplementationReady(run, `entering "${nodeId}"`);
        const drift = this.specWarnings(run);
        if (drift.length) {
          this.record(run, 'SPEC_DRIFT', {
            node: nodeId,
            message: drift.join('; '),
            data: { warnings: drift },
          });
        }
      }
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
    this.syncMissionState(run, def);
    return this.persist(run);
  }

  /**
   * Keep the mission state honest about the phase the run is actually in. Never
   * while a checkpoint is pending: the board must keep saying it is waiting on the
   * user until the user answers.
   */
  private syncMissionState(run: RunState, def: WorkflowDefinition): void {
    const mission = run.mission;
    if (!mission) return;
    if (mc.TERMINAL_MISSION_STATES.includes(mission.state)) return;
    if (mission.state === 'PAUSED' || mc.pendingCheckpoints(mission).length) return;
    const implied = mc.missionStateForNode(def, run);
    if (!implied || implied === mission.state) return;
    if (!mc.missionStateAllowed(mission.state, implied)) return;
    const from = mission.state;
    mission.state = implied;
    mission.updatedAt = this.now();
    this.record(run, 'MISSION_STATE', {
      node: run.currentNode,
      message: `${from} -> ${implied} (followed phase "${run.currentNode}")`,
      data: { from, to: implied, derived: true },
    });
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
    this.assertFreshHandoffBeforeLeaving(run, target);
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
    this.assertFreshHandoffBeforeLeaving(run, nodeId);
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
    const missionBlockers = run.mission ? mc.missionCompletionBlockers(run.mission) : [];
    const reasons = [...check.reasons, ...missionBlockers];
    if (reasons.length) {
      throw new sm.TransitionError(
        `run ${run.runId} cannot be completed:\n  - ${reasons.join('\n  - ')}\n` +
          `A run that will not finish is retired, not completed: cw run abandon --message "<why>"`,
      );
    }
    sm.completeRun(def, run, this.now());
    if (run.mission) {
      run.mission.state = 'COMPLETED';
      run.mission.updatedAt = this.now();
      delete run.mission.currentAction;
    }
    // The transcript is complete exactly now, so this is the one moment the
    // run's token usage can be read in full.
    this.syncUsageQuietly(run);
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
    if (run.mission && !mc.TERMINAL_MISSION_STATES.includes(run.mission.state)) {
      run.mission.state = 'FAILED';
      run.mission.updatedAt = this.now();
    }
    const extra: Partial<WorkflowEvent> = { node: run.currentNode };
    if (opts.message) extra.message = opts.message;
    this.syncUsageQuietly(run);
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
