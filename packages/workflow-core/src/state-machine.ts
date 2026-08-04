import type {
  GateProvenance,
  GateStatus,
  NodeState,
  RunState,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowNode,
} from './types.js';
import { MAX_TRANSITIONS, isTerminalRun } from './types.js';

export class TransitionError extends Error {}

/** The path actually taken. The monitor must not have to guess it. */
function recordTransition(run: RunState, from: string, to: string, now: string): void {
  if (from === to) return;
  const list = run.transitions ?? (run.transitions = []);
  list.push({ from, to, at: now });
  if (list.length > MAX_TRANSITIONS) list.splice(0, list.length - MAX_TRANSITIONS);
}

/** The last edge the run traversed, or undefined for a run that never moved. */
export function latestTransition(run: RunState) {
  return run.transitions?.at(-1);
}

function provenanceOf(run: RunState, gate: string): GateProvenance {
  const all = run.gateProvenance ?? (run.gateProvenance = {});
  const existing = all[gate];
  if (existing) return existing;
  const fresh: GateProvenance = {};
  all[gate] = fresh;
  return fresh;
}

export function gateProvenance(run: RunState, gate: string): GateProvenance | undefined {
  return run.gateProvenance?.[gate];
}

/** Artifacts a phase owns, after the loader normalised `artifact`/`artifacts`. */
export function artifactsOf(node: WorkflowNode | undefined): string[] {
  return node?.artifacts ?? [];
}

export function findNode(def: WorkflowDefinition, id: string) {
  return def.nodes.find((n) => n.id === id);
}

export function startNode(def: WorkflowDefinition) {
  return def.nodes.find((n) => n.kind === 'start') ?? def.nodes[0]!;
}

export function gatesOf(def: WorkflowDefinition): string[] {
  const gates = new Set<string>();
  for (const n of def.nodes) if (n.gate) gates.add(n.gate);
  return [...gates];
}

function gateSatisfied(when: string, gates: Record<string, GateStatus>): boolean {
  const negated = when.startsWith('!');
  const gate = negated ? when.slice(1) : when;
  const passed = gates[gate] === 'PASSED';
  return negated ? !passed : passed;
}

export function allowedEdges(def: WorkflowDefinition, run: RunState): WorkflowEdge[] {
  return def.edges.filter(
    (e) => e.from === run.currentNode && (!e.when || gateSatisfied(e.when, run.gates)),
  );
}

function emptyNodeState(): NodeState {
  return { status: 'PENDING', visits: 0 };
}

export function initialRunState(
  def: WorkflowDefinition,
  runId: string,
  now: string,
  label?: string,
): RunState {
  const nodes: Record<string, NodeState> = {};
  for (const n of def.nodes) {
    nodes[n.id] = n.defaultSkipped
      ? { status: 'SKIPPED', visits: 0, finishedAt: now }
      : emptyNodeState();
  }

  const gates: Record<string, GateStatus> = {};
  for (const g of gatesOf(def)) gates[g] = 'OPEN';

  const start = startNode(def);
  nodes[start.id] = { status: 'COMPLETED', startedAt: now, finishedAt: now, durationMs: 0, visits: 1 };

  const run: RunState = {
    runId,
    workflow: def.id,
    status: 'RUNNING',
    currentNode: start.id,
    startedAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastSemanticAt: now,
    nodes,
    gates,
    runtime: { claude: 'UNKNOWN', lastEventAt: now },
    agents: {},
    artifacts: [],
  };
  if (label) run.label = label;
  return run;
}

/** A semantic transition happened: both clocks move. */
function touch(run: RunState, now: string): void {
  run.updatedAt = now;
  run.lastActivityAt = now;
  run.lastSemanticAt = now;
}

/**
 * Is this transition allowed by the graph? Separated from `enterNode` so callers
 * can report an illegal edge before they report anything else — "no edge X -> Y"
 * is a different problem from "your evidence is missing", and conflating them
 * sends the reader after the wrong fix.
 */
export function checkEnter(
  def: WorkflowDefinition,
  run: RunState,
  nodeId: string,
): { ok: boolean; reason?: string } {
  if (!findNode(def, nodeId)) return { ok: false, reason: `workflow "${def.id}" has no node "${nodeId}"` };
  if (nodeId === run.currentNode) return { ok: true };
  const allowed = allowedEdges(def, run).map((e) => e.to);
  if (allowed.includes(nodeId)) return { ok: true };
  const blocked = def.edges.filter((e) => e.from === run.currentNode && e.to === nodeId);
  const reason = blocked.length
    ? `gate condition "${blocked[0]!.when}" is not satisfied`
    : `no edge ${run.currentNode} -> ${nodeId}`;
  return {
    ok: false,
    reason: `cannot enter "${nodeId}" from "${run.currentNode}": ${reason}. Allowed: ${allowed.join(', ') || '(none)'}`,
  };
}

/** `cw phase enter <node>` */
export function enterNode(
  def: WorkflowDefinition,
  run: RunState,
  nodeId: string,
  now: string,
  opts: { force?: boolean } = {},
): void {
  const node = findNode(def, nodeId);
  if (!node) throw new TransitionError(`workflow "${def.id}" has no node "${nodeId}"`);

  // Re-entering the phase already in progress is a retry, not a review loop.
  // Counting it would make the diagram claim visits that never happened.
  const existing = run.nodes[nodeId];
  if (nodeId === run.currentNode && existing && existing.status === 'ACTIVE') {
    touch(run, now);
    return;
  }

  if (!opts.force && nodeId !== run.currentNode) {
    const legal = checkEnter(def, run, nodeId);
    if (!legal.ok) throw new TransitionError(legal.reason!);
  }

  // A phase left ACTIVE, or a waiting node resumed through a legal edge, is
  // recorded as completed-by-transition. Gated waiting still cannot reach
  // implementation until its gate passes; gate-free L2 clarification needs no
  // artificial gate merely to settle the waiting node.
  const previous = run.nodes[run.currentNode];
  if (
    previous &&
    (previous.status === 'ACTIVE' || previous.status === 'WAITING_USER') &&
    run.currentNode !== nodeId
  ) {
    completeNodeState(previous, now);
  }

  const state = run.nodes[nodeId] ?? emptyNodeState();
  state.status = node.kind === 'waiting' ? 'WAITING_USER' : 'ACTIVE';
  state.startedAt = now;
  state.visits += 1;
  delete state.finishedAt;
  delete state.durationMs;
  delete state.error;
  run.nodes[nodeId] = state;

  recordTransition(run, run.currentNode, nodeId, now);
  run.currentNode = nodeId;
  run.status = node.kind === 'waiting' ? 'WAITING_USER' : 'RUNNING';
  touch(run, now);
}

function completeNodeState(state: NodeState, now: string): void {
  state.status = 'COMPLETED';
  state.finishedAt = now;
  if (state.startedAt) state.durationMs = Date.parse(now) - Date.parse(state.startedAt);
}

/** `cw phase complete [node]` */
export function completeNode(
  def: WorkflowDefinition,
  run: RunState,
  nodeId: string,
  now: string,
): void {
  const node = findNode(def, nodeId);
  if (node?.kind === 'waiting') {
    throw new TransitionError(
      `waiting node "${nodeId}" cannot be completed directly; resume through its declared edge` +
        `${node.gate ? ` or decide gate "${node.gate}"` : ''}`,
    );
  }
  const state = run.nodes[nodeId];
  if (!state) throw new TransitionError(`workflow "${def.id}" has no node "${nodeId}"`);
  completeNodeState(state, now);
  if (run.status === 'WAITING_USER' && run.currentNode === nodeId) run.status = 'RUNNING';
  touch(run, now);
}

/** `cw phase skip <node>` */
export function skipNode(def: WorkflowDefinition, run: RunState, nodeId: string, now: string): void {
  const node = findNode(def, nodeId);
  if (node?.kind === 'waiting') {
    throw new TransitionError(
      `waiting node "${nodeId}" cannot be skipped directly; resume through its declared edge` +
        `${node.gate ? ` or decide gate "${node.gate}"` : ''}`,
    );
  }
  const state = run.nodes[nodeId];
  if (!state) throw new TransitionError(`workflow "${def.id}" has no node "${nodeId}"`);
  state.status = 'SKIPPED';
  state.finishedAt = now;
  touch(run, now);
}

/** `cw phase fail <node> --message` */
export function failNode(
  def: WorkflowDefinition,
  run: RunState,
  nodeId: string,
  now: string,
  message?: string,
): void {
  const state = run.nodes[nodeId];
  if (!state) throw new TransitionError(`workflow "${def.id}" has no node "${nodeId}"`);
  state.status = 'FAILED';
  state.finishedAt = now;
  if (message) state.error = message;
  run.status = 'FAILED';
  if (message) run.error = message;
  run.finishedAt = now;
  settleLiveNodesAsFailed(run, now);
  touch(run, now);
}

function assertGate(def: WorkflowDefinition, gate: string): void {
  if (!gatesOf(def).includes(gate)) {
    throw new TransitionError(
      `workflow "${def.id}" has no gate "${gate}" (known: ${gatesOf(def).join(', ') || 'none'})`,
    );
  }
}

export interface GateWaitCheck {
  ok: boolean;
  reason?: string;
  /** The waiting node the run may legitimately park on. */
  node?: WorkflowNode;
}

/**
 * A waiting node is a place the run *walks into*, not a state it can be teleported
 * to. Parking a gate from the prompt or from an unrelated phase is how a run used
 * to reach WAITING_USER without the owning phase ever having done its work.
 */
export function checkGateWait(def: WorkflowDefinition, run: RunState, gate: string): GateWaitCheck {
  const owner = gateOwner(def, gate);
  const waiting = gateWaitingNodes(def, gate);
  if (!owner) return { ok: false, reason: `workflow "${def.id}" has no phase that owns gate "${gate}"` };
  if (!waiting.length) {
    return { ok: false, reason: `workflow "${def.id}" has no waiting node bound to gate "${gate}"` };
  }

  const already = waiting.find((n) => n.id === run.currentNode);
  if (already) return { ok: true, node: already };

  if (run.currentNode !== owner.id) {
    return {
      ok: false,
      reason:
        `gate "${gate}" can only be parked from its owning phase "${owner.id}" ` +
        `(current node is "${run.currentNode}"). Run: cw phase enter ${owner.id}`,
    };
  }

  const ownerState = run.nodes[owner.id];
  if (!ownerState || ownerState.visits < 1) {
    return { ok: false, reason: `phase "${owner.id}" has never been entered, so its gate cannot wait` };
  }

  const target = waiting.find((n) =>
    def.edges.some(
      (e) => e.from === owner.id && e.to === n.id && (!e.when || gateSatisfied(e.when, run.gates)),
    ),
  );
  if (!target) {
    return {
      ok: false,
      reason: `no open transition "${owner.id}" -> waiting node for gate "${gate}"`,
    };
  }
  return { ok: true, node: target };
}

/** `cw gate wait <gate>` — the run is blocked on the user. */
export function waitGate(def: WorkflowDefinition, run: RunState, gate: string, now: string): void {
  assertGate(def, gate);
  const check = checkGateWait(def, run, gate);
  if (!check.ok || !check.node) throw new TransitionError(check.reason ?? `cannot wait on gate "${gate}"`);

  const node = check.node;
  run.gates[gate] = 'WAITING';
  const state = run.nodes[node.id] ?? emptyNodeState();
  if (state.status !== 'WAITING_USER') state.visits += 1;
  state.status = 'WAITING_USER';
  state.startedAt = state.startedAt ?? now;
  run.nodes[node.id] = state;

  const owner = gateOwner(def, gate);
  const prov = provenanceOf(run, gate);
  prov.waitedAtNode = node.id;
  prov.waitedAt = now;
  if (owner) prov.ownerVisit = run.nodes[owner.id]?.visits ?? 0;

  recordTransition(run, run.currentNode, node.id, now);
  run.currentNode = node.id;
  run.status = 'WAITING_USER';
  touch(run, now);
}

/** The phase that owns a gate — the node that must be current to decide it. */
export function gateOwner(def: WorkflowDefinition, gate: string): WorkflowNode | undefined {
  return def.nodes.find((n) => n.kind !== 'waiting' && n.gate === gate);
}

/** Waiting nodes parked on a gate. Deciding from one of these is also legal. */
export function gateWaitingNodes(def: WorkflowDefinition, gate: string): WorkflowNode[] {
  return def.nodes.filter((n) => n.kind === 'waiting' && n.gate === gate);
}

export interface GatePassCheck {
  ok: boolean;
  reason?: string;
}

/**
 * A gate is a decision made *at* the phase that owns it, backed by the evidence
 * that phase is required to persist. Passing it from anywhere else, or with the
 * owner's artifacts missing, is what turned the "hard gate" into a formality.
 */
export function checkGatePass(
  def: WorkflowDefinition,
  run: RunState,
  gate: string,
  validArtifacts: string[],
): GatePassCheck {
  const owner = gateOwner(def, gate);
  if (!owner) return { ok: true };

  const waitingIds = gateWaitingNodes(def, gate).map((n) => n.id);
  if (![owner.id, ...waitingIds].includes(run.currentNode)) {
    return {
      ok: false,
      reason: `gate "${gate}" is decided at "${owner.id}" (current node is "${run.currentNode}"). Run: cw phase enter ${owner.id}`,
    };
  }

  // Deciding from a waiting node is legal only if the run actually waited there.
  if (waitingIds.includes(run.currentNode)) {
    const prov = gateProvenance(run, gate);
    if (prov?.waitedAtNode !== run.currentNode) {
      return {
        ok: false,
        reason:
          `gate "${gate}" cannot be decided from "${run.currentNode}": the run did not reach that ` +
          `waiting node through "${owner.id}". Run: cw phase enter ${owner.id}`,
      };
    }
  }

  const ownerState = run.nodes[owner.id];
  if (!ownerState || ownerState.visits < 1) {
    return { ok: false, reason: `gate "${gate}" is decided at "${owner.id}", which has never been entered` };
  }

  const missing = artifactsOf(owner).filter((a) => !validArtifacts.includes(a));
  if (missing.length) {
    return {
      ok: false,
      reason: `gate "${gate}" requires evidence from "${owner.id}": missing or unusable ${missing.join(', ')} in the run directory`,
    };
  }
  return { ok: true };
}

/** `cw gate pass <gate>` */
export function passGate(
  def: WorkflowDefinition,
  run: RunState,
  gate: string,
  now: string,
  opts: { overrideReason?: string } = {},
): void {
  assertGate(def, gate);
  run.gates[gate] = 'PASSED';
  const prov = provenanceOf(run, gate);
  prov.decidedAtNode = run.currentNode;
  prov.decidedAt = now;
  prov.ownerVisit = run.nodes[gateOwner(def, gate)?.id ?? '']?.visits ?? 0;
  if (opts.overrideReason) prov.overrideReason = opts.overrideReason;
  else delete prov.overrideReason;
  for (const n of def.nodes) {
    if (n.kind !== 'waiting' || n.gate !== gate) continue;
    const state = run.nodes[n.id];
    if (!state) continue;
    state.status = state.visits > 0 ? 'COMPLETED' : 'SKIPPED';
    state.finishedAt = now;
  }
  // The gate owner regains focus so the next `phase enter` validates from it.
  const owner = gateOwner(def, gate);
  if (owner && run.nodes[run.currentNode]?.status === 'COMPLETED' && findNode(def, run.currentNode)?.kind === 'waiting') {
    recordTransition(run, run.currentNode, owner.id, now);
    run.currentNode = owner.id;
  }
  if (run.status === 'WAITING_USER') run.status = 'RUNNING';
  touch(run, now);
}

/**
 * A failed run has no live phase anywhere (MON-03). A node left ACTIVE — or a
 * waiting node still asking the user a question — under a FAILED header is a
 * diagram that contradicts its own header.
 */
function settleLiveNodesAsFailed(run: RunState, now: string, message?: string): void {
  for (const [id, state] of Object.entries(run.nodes)) {
    if (state.status !== 'ACTIVE' && state.status !== 'WAITING_USER') continue;
    state.status = 'FAILED';
    state.finishedAt = now;
    if (message && id === run.currentNode) state.error = message;
  }
}

/** `cw gate fail <gate> --message` */
export function failGate(
  def: WorkflowDefinition,
  run: RunState,
  gate: string,
  now: string,
  message?: string,
): void {
  assertGate(def, gate);
  run.gates[gate] = 'FAILED';
  const prov = provenanceOf(run, gate);
  prov.decidedAtNode = run.currentNode;
  prov.decidedAt = now;
  settleLiveNodesAsFailed(run, now, message);
  run.status = 'FAILED';
  if (message) run.error = message;
  run.finishedAt = now;
  touch(run, now);
}

export interface RunCompleteCheck {
  ok: boolean;
  /** Every reason the run is not finishable, not just the first. */
  reasons: string[];
}

/**
 * `COMPLETED` is a claim that the workflow ran, so it has to be checked rather
 * than asserted. A terminal status must never be reachable as a shortcut around
 * gates, artifacts or an open question to the user — that is what `run abandon`
 * is for, and ABANDONED never reads as success.
 */
export function checkRunComplete(
  def: WorkflowDefinition,
  run: RunState,
  validArtifacts: string[],
): RunCompleteCheck {
  const reasons: string[] = [];

  const openGates = gatesOf(def).filter((g) => run.gates[g] !== 'PASSED');
  if (openGates.length) {
    reasons.push(`gate(s) not passed: ${openGates.map((g) => `${g}=${run.gates[g] ?? 'OPEN'}`).join(', ')}`);
  }

  const waiting = def.nodes.filter((n) => run.nodes[n.id]?.status === 'WAITING_USER');
  if (waiting.length) {
    reasons.push(`still waiting on the user at: ${waiting.map((n) => n.id).join(', ')}`);
  }
  if (run.status === 'WAITING_USER') reasons.push('run status is WAITING_USER');

  const unfinished = def.nodes.filter((n) => {
    if (n.kind !== 'phase') return false;
    const status = run.nodes[n.id]?.status ?? 'PENDING';
    if (status === 'COMPLETED' || status === 'SKIPPED') return false;
    // The phase the run is standing in is completed by finishing the run.
    return !(status === 'ACTIVE' && n.id === run.currentNode);
  });
  if (unfinished.length) {
    reasons.push(
      `phase(s) neither completed nor skipped: ${unfinished
        .map((n) => `${n.id}=${run.nodes[n.id]?.status ?? 'PENDING'}`)
        .join(', ')}`,
    );
  }

  const end = def.nodes.find((n) => n.kind === 'end');
  if (end && run.currentNode !== end.id) {
    const canReachEnd = def.edges.some((e) => e.from === run.currentNode && e.to === end.id);
    if (!canReachEnd) {
      reasons.push(
        `current node "${run.currentNode}" is not "${end.id}" and has no edge to it — the workflow is not at its end`,
      );
    }
  }

  const missing: string[] = [];
  for (const node of def.nodes) {
    const status = run.nodes[node.id]?.status ?? 'PENDING';
    if (status === 'SKIPPED' || status === 'PENDING') continue;
    for (const artifact of artifactsOf(node)) {
      if (!validArtifacts.includes(artifact)) missing.push(`${artifact} (${node.id})`);
    }
  }
  if (missing.length) reasons.push(`missing or unusable required artifact(s): ${missing.join(', ')}`);

  return { ok: reasons.length === 0, reasons };
}

export function completeRun(def: WorkflowDefinition, run: RunState, now: string): void {
  const current = run.nodes[run.currentNode];
  if (current && (current.status === 'ACTIVE' || current.status === 'WAITING_USER')) {
    completeNodeState(current, now);
  }
  const end = def.nodes.find((n) => n.kind === 'end');
  if (end) {
    const state = run.nodes[end.id] ?? emptyNodeState();
    state.status = 'COMPLETED';
    state.startedAt = state.startedAt ?? now;
    state.finishedAt = now;
    state.visits += 1;
    run.nodes[end.id] = state;
    recordTransition(run, run.currentNode, end.id, now);
    run.currentNode = end.id;
  }
  run.status = 'COMPLETED';
  run.finishedAt = now;
  run.runtime.claude = 'IDLE';
  touch(run, now);
}

/**
 * Retire a run that will never finish, without pretending it failed or
 * succeeded. Used when the user deliberately starts a different run.
 */
export function abandonRun(run: RunState, now: string, message?: string): void {
  const current = run.nodes[run.currentNode];
  if (current && (current.status === 'ACTIVE' || current.status === 'WAITING_USER')) {
    current.status = 'SKIPPED';
    current.finishedAt = now;
  }
  run.status = 'ABANDONED';
  if (message) run.error = message;
  run.finishedAt = now;
  run.runtime.claude = 'IDLE';
  touch(run, now);
}

export function failRun(run: RunState, now: string, message?: string): void {
  settleLiveNodesAsFailed(run, now, message);
  run.status = 'FAILED';
  if (message) run.error = message;
  run.finishedAt = now;
  touch(run, now);
}

/**
 * Apply a runtime (hook-sourced) event. Never changes the semantic phase —
 * that is the whole point of keeping the two layers apart.
 */
export function applyRuntimeEvent(run: RunState, event: WorkflowEvent): void {
  const rt = run.runtime;
  rt.lastEventAt = event.ts;
  if (event.sessionId) rt.sessionId = event.sessionId;
  run.lastRuntimeAt = event.ts;

  switch (event.type) {
    case 'SESSION_START':
    case 'PROMPT_SUBMIT':
    case 'TASK_CREATED':
    case 'TASK_COMPLETED':
      rt.claude = 'ACTIVE';
      break;
    case 'TOOL_START':
      rt.claude = 'TOOL_RUNNING';
      rt.tool = event.tool;
      rt.toolStatus = 'RUNNING';
      break;
    case 'TOOL_END':
      rt.claude = run.agents && Object.values(run.agents).some((a) => a.status === 'RUNNING')
        ? 'SUBAGENT_RUNNING'
        : 'ACTIVE';
      rt.tool = event.tool ?? rt.tool;
      rt.toolStatus = 'OK';
      break;
    case 'TOOL_FAIL':
      rt.claude = 'ACTIVE';
      rt.tool = event.tool ?? rt.tool;
      rt.toolStatus = 'FAILED';
      break;
    case 'SUBAGENT_START': {
      const id = event.agentId ?? event.agent ?? 'agent';
      run.agents[id] = {
        id,
        name: event.agent ?? id,
        status: 'RUNNING',
        startedAt: event.ts,
      };
      rt.claude = 'SUBAGENT_RUNNING';
      rt.agent = event.agent ?? id;
      break;
    }
    case 'SUBAGENT_STOP': {
      const id = event.agentId ?? event.agent ?? 'agent';
      const existing = run.agents[id];
      if (existing) {
        existing.status = 'STOPPED';
        existing.finishedAt = event.ts;
      }
      rt.claude = Object.values(run.agents).some((a) => a.status === 'RUNNING')
        ? 'SUBAGENT_RUNNING'
        : 'ACTIVE';
      delete rt.agent;
      break;
    }
    case 'TURN_COMPLETE':
      rt.claude = run.status === 'WAITING_USER' ? 'IDLE' : 'STOPPED';
      delete rt.agent;
      break;
    case 'TURN_FAILED':
      rt.claude = 'FAILED';
      break;
    case 'SESSION_END':
      rt.claude = 'IDLE';
      break;
    default:
      break;
  }

  run.updatedAt = event.ts;
  run.lastActivityAt = event.ts;
}

/**
 * Derived display status. A run that stopped reporting is POSSIBLY_STALLED,
 * never FAILED — we do not claim Claude is dead.
 */
export function derivedRunStatus(
  run: RunState,
  stallThresholdSeconds: number,
  now = new Date().toISOString(),
): RunStatusView {
  if (isTerminalRun(run.status)) return run.status as RunStatusView;
  if (run.status === 'WAITING_USER') return 'WAITING_USER';
  const idleMs = Date.parse(now) - Date.parse(run.lastActivityAt);
  if (idleMs > stallThresholdSeconds * 1000) return 'POSSIBLY_STALLED';
  return 'RUNNING';
}

export type RunStatusView =
  | 'RUNNING'
  | 'WAITING_USER'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABANDONED'
  | 'POSSIBLY_STALLED';

export type SemanticView = 'OK' | 'SEMANTIC_LAG';

/**
 * Runtime states in which Claude is demonstrably doing something. Semantic lag
 * is only meaningful against one of these: an IDLE, STOPPED, FAILED or UNKNOWN
 * session is not "working without reporting", it is simply not working.
 */
export const WORKING_CLAUDE_STATUSES = ['ACTIVE', 'TOOL_RUNNING', 'SUBAGENT_RUNNING'] as const;

/**
 * Claude is demonstrably working (runtime events keep arriving) but no phase
 * transition has been emitted for a long time — the diagram is behind reality.
 * This is the failure mode of a model-emitted state machine, so it is reported
 * rather than guessed away. Never FAILED, never a phase change.
 */
export function derivedSemanticStatus(
  run: RunState,
  semanticLagThresholdSeconds: number,
  now = new Date().toISOString(),
): SemanticView {
  if (isTerminalRun(run.status)) return 'OK';
  if (run.status === 'WAITING_USER') return 'OK';
  if (!run.lastRuntimeAt) return 'OK';
  // Only a working session can be "ahead of the diagram".
  if (!(WORKING_CLAUDE_STATUSES as readonly string[]).includes(run.runtime.claude)) return 'OK';
  const nowMs = Date.parse(now);
  // Only meaningful while runtime activity is fresh; otherwise it is a stall,
  // which POSSIBLY_STALLED already reports.
  const runtimeIdleMs = nowMs - Date.parse(run.lastRuntimeAt);
  if (runtimeIdleMs > semanticLagThresholdSeconds * 1000) return 'OK';
  const semanticIdleMs = nowMs - Date.parse(run.lastSemanticAt ?? run.startedAt);
  return semanticIdleMs > semanticLagThresholdSeconds * 1000 ? 'SEMANTIC_LAG' : 'OK';
}
