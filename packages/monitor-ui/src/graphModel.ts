/**
 * Pure diagram model: workflow definition + run state -> what to draw.
 *
 * Kept free of React and React Flow so the rules that decide whether a node is
 * stale, whether an edge is live and whether an edge is gate-blocked can be
 * tested directly. The renderer only maps this to components.
 */
import { nodeStatusView } from './derive.js';
import type { NodeStatusView, RunView, WorkflowDefinition, WorkflowNode } from './types.js';

export interface GraphNodeModel {
  id: string;
  node: WorkflowNode;
  status: NodeStatusView;
  isCurrent: boolean;
  /** Artifacts this phase owns, and whether each is present in the run. */
  artifacts: Array<{ name: string; present: boolean }>;
}

export interface GraphEdgeModel {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** The edge the run just traversed into the current node. */
  isActivePath: boolean;
  /** Its `when` condition is not satisfied: this route is closed right now. */
  gateBlocked: boolean;
  animated: boolean;
}

export interface GraphAgentModel {
  id: string;
  name: string;
  startedAt: string;
  anchor: string;
}

export interface GraphModel {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  agents: GraphAgentModel[];
}

export function gateSatisfied(when: string, gates: RunView['gates']): boolean {
  const negated = when.startsWith('!');
  const passed = gates[negated ? when.slice(1) : when] === 'PASSED';
  return negated ? !passed : passed;
}

export function buildGraphModel(
  workflow: WorkflowDefinition,
  run: RunView,
  nowMs: number,
  stallThresholdSeconds: number,
): GraphModel {
  const nodes: GraphNodeModel[] = workflow.nodes.map((node) => ({
    id: node.id,
    node,
    status: nodeStatusView(run, node.id, nowMs, stallThresholdSeconds),
    isCurrent: run.currentNode === node.id,
    artifacts: (node.artifacts ?? []).map((name) => ({
      name,
      present: run.artifacts.includes(name),
    })),
  }));

  // The path actually taken comes from the transition log, not from guesswork.
  // Inferring it from "predecessor completed and target is current" lit up every
  // edge of a review loop at once, and kept animating after the run had ended.
  const last = run.transitions?.at(-1);
  const terminal = ['COMPLETED', 'FAILED', 'ABANDONED'].includes(run.status);

  const edges: GraphEdgeModel[] = workflow.edges.map((edge, i) => {
    const isActivePath = Boolean(last && last.from === edge.from && last.to === edge.to);
    const gateBlocked = edge.when ? !gateSatisfied(edge.when, run.gates) : false;
    const model: GraphEdgeModel = {
      id: `${edge.from}->${edge.to}-${i}`,
      from: edge.from,
      to: edge.to,
      isActivePath,
      gateBlocked,
      // A closed route must not look live, and a finished run has no live route.
      animated: isActivePath && !gateBlocked && !terminal,
    };
    const label = edge.label ?? edge.when;
    if (label) model.label = label;
    return model;
  });

  const agents: GraphAgentModel[] = Object.values(run.agents)
    .filter((a) => a.status === 'RUNNING')
    .map((a) => ({ id: a.id, name: a.name, startedAt: a.startedAt, anchor: run.currentNode }));

  return { nodes, edges, agents };
}

/**
 * Follow the active run until the user picks one explicitly, and keep their
 * choice while it still exists.
 */
export function nextSelectedRunId(
  currentSelection: string | null,
  runs: Array<{ runId: string }>,
  currentRunId: string | null,
): string | null {
  if (currentSelection && runs.some((r) => r.runId === currentSelection)) return currentSelection;
  return currentRunId ?? runs[0]?.runId ?? null;
}
