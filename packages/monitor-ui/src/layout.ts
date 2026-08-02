import type { WorkflowDefinition } from './types';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 96;
const RANK_GAP = 78;
const COLUMN_GAP = 40;

export interface Placed {
  id: string;
  x: number;
  y: number;
  rank: number;
}

/**
 * Layered top-down placement derived from the workflow definition. BFS from the
 * start node gives each node its first-reached rank, so review/retry back edges
 * do not distort the layout. Waiting nodes are parked in a side column next to
 * the gate they belong to.
 */
export function layout(def: WorkflowDefinition): Map<string, Placed> {
  const start = def.nodes.find((n) => n.kind === 'start')?.id ?? def.nodes[0]?.id;
  const rank = new Map<string, number>();
  if (start) rank.set(start, 0);

  const queue: string[] = start ? [start] : [];
  while (queue.length) {
    const current = queue.shift()!;
    const currentRank = rank.get(current)!;
    for (const edge of def.edges) {
      if (edge.from !== current || rank.has(edge.to)) continue;
      rank.set(edge.to, currentRank + 1);
      queue.push(edge.to);
    }
  }
  // Nodes unreachable from start still deserve a slot.
  let maxRank = Math.max(0, ...rank.values());
  for (const node of def.nodes) {
    if (!rank.has(node.id)) rank.set(node.id, ++maxRank);
  }

  const mainByRank = new Map<number, string[]>();
  const waiting: string[] = [];
  for (const node of def.nodes) {
    if (node.kind === 'waiting') {
      waiting.push(node.id);
      continue;
    }
    const r = rank.get(node.id)!;
    const bucket = mainByRank.get(r) ?? [];
    bucket.push(node.id);
    mainByRank.set(r, bucket);
  }

  const placed = new Map<string, Placed>();
  for (const [r, ids] of mainByRank) {
    const rowWidth = ids.length * NODE_WIDTH + (ids.length - 1) * COLUMN_GAP;
    ids.forEach((id, i) => {
      placed.set(id, {
        id,
        x: -rowWidth / 2 + i * (NODE_WIDTH + COLUMN_GAP),
        y: r * (NODE_HEIGHT + RANK_GAP),
        rank: r,
      });
    });
  }

  // Waiting node sits beside its gate owner, one rank down.
  for (const id of waiting) {
    const node = def.nodes.find((n) => n.id === id)!;
    const owner = def.nodes.find((n) => n.kind !== 'waiting' && n.gate === node.gate);
    const anchor = owner ? placed.get(owner.id) : undefined;
    const r = anchor ? anchor.rank : rank.get(id)!;
    placed.set(id, {
      id,
      x: (anchor?.x ?? 0) + NODE_WIDTH + COLUMN_GAP * 2,
      y: (anchor?.y ?? r * (NODE_HEIGHT + RANK_GAP)) + (NODE_HEIGHT + RANK_GAP) / 2,
      rank: r,
    });
  }

  return placed;
}
