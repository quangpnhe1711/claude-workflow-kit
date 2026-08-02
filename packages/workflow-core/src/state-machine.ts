import type {
  GateStatus,
  NodeState,
  RunState,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowEvent,
} from './types.js';

export class TransitionError extends Error {}

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
  for (const n of def.nodes) nodes[n.id] = emptyNodeState();

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
    nodes,
    gates,
    runtime: { claude: 'UNKNOWN', lastEventAt: now },
    agents: {},
    artifacts: [],
  };
  if (label) run.label = label;
  return run;
}

function touch(run: RunState, now: string): void {
  run.updatedAt = now;
  run.lastActivityAt = now;
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

  if (!opts.force && nodeId !== run.currentNode) {
    const allowed = allowedEdges(def, run).map((e) => e.to);
    if (!allowed.includes(nodeId)) {
      const blocked = def.edges.filter((e) => e.from === run.currentNode && e.to === nodeId);
      const reason = blocked.length
        ? `gate condition "${blocked[0]!.when}" is not satisfied`
        : `no edge ${run.currentNode} -> ${nodeId}`;
      throw new TransitionError(
        `cannot enter "${nodeId}" from "${run.currentNode}": ${reason}. Allowed: ${allowed.join(', ') || '(none)'}`,
      );
    }
  }

  // A phase left ACTIVE when the run moves on is recorded as completed-by-transition.
  const previous = run.nodes[run.currentNode];
  if (previous && previous.status === 'ACTIVE' && run.currentNode !== nodeId) {
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
  const state = run.nodes[nodeId];
  if (!state) throw new TransitionError(`workflow "${def.id}" has no node "${nodeId}"`);
  completeNodeState(state, now);
  if (run.status === 'WAITING_USER' && run.currentNode === nodeId) run.status = 'RUNNING';
  touch(run, now);
}

/** `cw phase skip <node>` */
export function skipNode(def: WorkflowDefinition, run: RunState, nodeId: string, now: string): void {
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
  touch(run, now);
}

function assertGate(def: WorkflowDefinition, gate: string): void {
  if (!gatesOf(def).includes(gate)) {
    throw new TransitionError(
      `workflow "${def.id}" has no gate "${gate}" (known: ${gatesOf(def).join(', ') || 'none'})`,
    );
  }
}

/** `cw gate wait <gate>` — the run is blocked on the user. */
export function waitGate(def: WorkflowDefinition, run: RunState, gate: string, now: string): void {
  assertGate(def, gate);
  run.gates[gate] = 'WAITING';
  for (const n of def.nodes) {
    if (n.kind !== 'waiting' || n.gate !== gate) continue;
    const state = run.nodes[n.id] ?? emptyNodeState();
    if (state.status !== 'WAITING_USER') state.visits += 1;
    state.status = 'WAITING_USER';
    state.startedAt = state.startedAt ?? now;
    run.nodes[n.id] = state;
    run.currentNode = n.id;
  }
  run.status = 'WAITING_USER';
  touch(run, now);
}

/** `cw gate pass <gate>` */
export function passGate(def: WorkflowDefinition, run: RunState, gate: string, now: string): void {
  assertGate(def, gate);
  run.gates[gate] = 'PASSED';
  for (const n of def.nodes) {
    if (n.kind !== 'waiting' || n.gate !== gate) continue;
    const state = run.nodes[n.id];
    if (!state) continue;
    state.status = state.visits > 0 ? 'COMPLETED' : 'SKIPPED';
    state.finishedAt = now;
  }
  // The gate owner regains focus so the next `phase enter` validates from it.
  const owner = def.nodes.find((n) => n.kind !== 'waiting' && n.gate === gate);
  if (owner && run.nodes[run.currentNode]?.status === 'COMPLETED' && findNode(def, run.currentNode)?.kind === 'waiting') {
    run.currentNode = owner.id;
  }
  if (run.status === 'WAITING_USER') run.status = 'RUNNING';
  touch(run, now);
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
  run.status = 'FAILED';
  if (message) run.error = message;
  run.finishedAt = now;
  touch(run, now);
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
    run.currentNode = end.id;
  }
  run.status = 'COMPLETED';
  run.finishedAt = now;
  run.runtime.claude = 'IDLE';
  touch(run, now);
}

export function failRun(run: RunState, now: string, message?: string): void {
  const current = run.nodes[run.currentNode];
  if (current && current.status === 'ACTIVE') {
    current.status = 'FAILED';
    current.finishedAt = now;
    if (message) current.error = message;
  }
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
  if (run.status === 'COMPLETED' || run.status === 'FAILED') return run.status;
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
  | 'POSSIBLY_STALLED';
