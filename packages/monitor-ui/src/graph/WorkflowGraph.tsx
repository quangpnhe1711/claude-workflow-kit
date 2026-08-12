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
import { buildGraphModel } from '../graphModel';
import type { RunRollup, RunView, WorkflowDefinition } from '../types';

const nodeTypes = { phase: PhaseNode, agent: AgentNode };

interface Props {
  workflow: WorkflowDefinition;
  run: RunView;
  nowMs: number;
  stallThresholdSeconds: number;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  /** Per-step counts. Absent means "not measured", never "zero". */
  rollup?: RunRollup | null;
}

export function WorkflowGraph({
  workflow,
  run,
  nowMs,
  stallThresholdSeconds,
  selectedNodeId,
  onSelectNode,
  rollup,
}: Props) {
  const placement = useMemo(() => layout(workflow), [workflow]);
  const model = useMemo(
    () => buildGraphModel(workflow, run, nowMs, stallThresholdSeconds),
    [workflow, run, nowMs, stallThresholdSeconds],
  );

  const nodes: Node[] = useMemo(() => {
    const list: Node[] = model.nodes.map((item) => {
      const pos = placement.get(item.id) ?? { x: 0, y: 0 };
      return {
        id: item.id,
        type: 'phase',
        position: { x: pos.x, y: pos.y },
        data: {
          node: item.node,
          status: item.status,
          artifacts: item.artifacts,
          run,
          nowMs,
          selected: selectedNodeId === item.id,
          step: rollup?.steps[item.id],
        },
        draggable: false,
        selectable: true,
      };
    });

    // Running subagents branch off the phase that is currently active.
    model.agents.forEach((agent, i) => {
      const anchor = placement.get(agent.anchor);
      list.push({
        id: `agent:${agent.id}`,
        type: 'agent',
        position: { x: (anchor?.x ?? 0) + NODE_WIDTH + 60, y: (anchor?.y ?? 0) + i * 48 },
        data: { agent: run.agents[agent.id], nowMs },
        draggable: false,
        selectable: false,
      });
    });

    return list;
  }, [model, run, nowMs, selectedNodeId, placement, rollup]);

  const edges: Edge[] = useMemo(() => {
    const list: Edge[] = model.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      label: edge.label,
      animated: edge.animated,
      className: `wf-edge${edge.isActivePath ? ' wf-edge--active' : ''}${edge.gateBlocked ? ' wf-edge--gated' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      labelStyle: { fontSize: 10 },
    }));

    for (const agent of model.agents) {
      list.push({
        id: `agent-edge:${agent.id}`,
        source: agent.anchor,
        target: `agent:${agent.id}`,
        animated: true,
        className: 'wf-edge wf-edge--agent',
      });
    }
    return list;
  }, [model]);

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
