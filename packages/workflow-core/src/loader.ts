import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Workflows shipped with the package (`dist/` -> `../workflows`). */
export const builtinWorkflowDir = join(here, '..', 'workflows');

export class WorkflowDefinitionError extends Error {}

function asString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new WorkflowDefinitionError(`${where} must be a non-empty string`);
  }
  return v;
}

export function parseWorkflow(source: string, origin: string): WorkflowDefinition {
  const raw = parseYaml(source) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') {
    throw new WorkflowDefinitionError(`${origin}: not a workflow object`);
  }

  const id = asString(raw['id'], `${origin}: id`);
  const label = typeof raw['label'] === 'string' ? raw['label'] : id;

  const rawNodes = raw['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new WorkflowDefinitionError(`${origin}: nodes must be a non-empty list`);
  }

  const nodes: WorkflowNode[] = rawNodes.map((n, i) => {
    const o = n as Record<string, unknown>;
    const nodeId = asString(o['id'], `${origin}: nodes[${i}].id`);
    return {
      id: nodeId,
      label: typeof o['label'] === 'string' ? o['label'] : nodeId,
      kind: (o['kind'] as WorkflowNode['kind']) ?? 'phase',
      description: o['description'] as string | undefined,
      gate: o['gate'] as string | undefined,
      skill: o['skill'] as string | undefined,
      agent: o['agent'] as string | undefined,
      artifact: o['artifact'] as string | undefined,
    };
  });

  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new WorkflowDefinitionError(`${origin}: duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!['start', 'phase', 'waiting', 'end'].includes(n.kind)) {
      throw new WorkflowDefinitionError(`${origin}: node "${n.id}" has unknown kind "${n.kind}"`);
    }
    if (n.kind === 'waiting' && !n.gate) {
      throw new WorkflowDefinitionError(`${origin}: waiting node "${n.id}" must declare a gate`);
    }
  }

  const rawEdges = Array.isArray(raw['edges']) ? raw['edges'] : [];
  const edges: WorkflowEdge[] = rawEdges.map((e, i) => {
    const o = e as Record<string, unknown>;
    const from = asString(o['from'], `${origin}: edges[${i}].from`);
    const to = asString(o['to'], `${origin}: edges[${i}].to`);
    if (!ids.has(from)) throw new WorkflowDefinitionError(`${origin}: edge ${i} from unknown node "${from}"`);
    if (!ids.has(to)) throw new WorkflowDefinitionError(`${origin}: edge ${i} to unknown node "${to}"`);
    const edge: WorkflowEdge = { from, to };
    if (typeof o['when'] === 'string') edge.when = o['when'];
    if (typeof o['label'] === 'string') edge.label = o['label'];
    return edge;
  });

  for (const e of edges) {
    if (!e.when) continue;
    const gate = e.when.startsWith('!') ? e.when.slice(1) : e.when;
    const declared = nodes.some((n) => n.gate === gate);
    if (!declared) {
      throw new WorkflowDefinitionError(
        `${origin}: edge ${e.from}->${e.to} references gate "${gate}" that no node declares`,
      );
    }
  }

  const def: WorkflowDefinition = { id, label, nodes, edges };
  if (typeof raw['description'] === 'string') def.description = raw['description'];
  return def;
}

function loadDir(dir: string): Map<string, WorkflowDefinition> {
  const out = new Map<string, WorkflowDefinition>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    const ext = extname(file);
    if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') continue;
    const full = join(dir, file);
    const def = parseWorkflow(readFileSync(full, 'utf8'), basename(full));
    out.set(def.id, def);
  }
  return out;
}

/**
 * Built-in workflows, overridden by any definition with the same id found in
 * `<runtimeDir>/workflows/`. Project overrides win.
 */
export function loadWorkflows(runtimeDir?: string): Map<string, WorkflowDefinition> {
  const all = loadDir(builtinWorkflowDir);
  if (runtimeDir) {
    for (const [id, def] of loadDir(join(runtimeDir, 'workflows'))) all.set(id, def);
  }
  return all;
}

export function loadWorkflow(id: string, runtimeDir?: string): WorkflowDefinition {
  const def = loadWorkflows(runtimeDir).get(id);
  if (!def) {
    const known = [...loadWorkflows(runtimeDir).keys()].join(', ');
    throw new WorkflowDefinitionError(`unknown workflow "${id}" (known: ${known})`);
  }
  return def;
}
