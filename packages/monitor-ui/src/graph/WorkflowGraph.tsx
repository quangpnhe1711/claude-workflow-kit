import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { PhaseNode } from '../nodes/PhaseNode';
import { AgentNode } from '../nodes/AgentNode';
import { NODE_WIDTH, layout } from '../layout';
import { nodeStatusView } from '../derive';
import type { RunView, WorkflowDefinition } from '../types';

const nodeTypes = { phase: PhaseNode, agent: AgentNode };

function gateSatisfied(when: string, gates: RunView['gates']): boolean {
  const negated = when.startsWith('!');
  const passed = gates[negated ? when.slice(1) : when] === 'PASSED';
  return negated ? !passed : passed;
}

interface Props {
  workflow: WorkflowDefinition;
  run: RunView;
  nowMs: number;
  stallThresholdSeconds: number;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}

export function WorkflowGraph({
  workflow,
  run,
  nowMs,
  stallThresholdSeconds,
  selectedNodeId,
  onSelectNode,
}: Props) {
  const placement = useMemo(() => layout(workflow), [workflow]);

  const nodes: Node[] = useMemo(() => {
    const list: Node[] = workflow.nodes.map((node) => {
      const pos = placement.get(node.id) ?? { x: 0, y: 0 };
      return {
        id: node.id,
        type: 'phase',
        position: { x: pos.x, y: pos.y },
        data: {
          node,
          status: nodeStatusView(run, node.id, nowMs, stallThresholdSeconds),
          run,
          nowMs,
          selected: selectedNodeId === node.id,
        },
        draggable: false,
        selectable: true,
      };
    });

    // Running subagents branch off the phase that is currently active.
    const anchor = placement.get(run.currentNode);
    const running = Object.values(run.agents).filter((a) => a.status === 'RUNNING');
    running.forEach((agent, i) => {
      list.push({
        id: `agent:${agent.id}`,
        type: 'agent',
        position: {
          x: (anchor?.x ?? 0) + NODE_WIDTH + 60,
          y: (anchor?.y ?? 0) + i * 48,
        },
        data: { agent, nowMs },
        draggable: false,
        selectable: false,
      });
    });

    return list;
  }, [workflow, run, nowMs, stallThresholdSeconds, selectedNodeId, placement]);

  const edges: Edge[] = useMemo(() => {
    const list: Edge[] = workflow.edges.map((edge, i) => {
      const fromDone = run.nodes[edge.from]?.status === 'COMPLETED';
      const isActivePath = run.currentNode === edge.to && fromDone;
      const gateBlocked = edge.when ? !gateSatisfied(edge.when, run.gates) : false;

      return {
        id: `${edge.from}->${edge.to}-${i}`,
        source: edge.from,
        target: edge.to,
        label: edge.label ?? edge.when,
        animated: isActivePath || run.currentNode === edge.from,
        className: `wf-edge${isActivePath ? ' wf-edge--active' : ''}${gateBlocked ? ' wf-edge--gated' : ''}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        labelStyle: { fontSize: 10 },
      };
    });

    const anchor = run.currentNode;
    for (const agent of Object.values(run.agents)) {
      if (agent.status !== 'RUNNING') continue;
      list.push({
        id: `agent-edge:${agent.id}`,
        source: anchor,
        target: `agent:${agent.id}`,
        animated: true,
        className: 'wf-edge wf-edge--agent',
      });
    }
    return list;
  }, [workflow, run]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        if (!node.id.startsWith('agent:')) onSelectNode(node.id);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
