/**
 * Events -> a line a human reads.
 *
 * The event union grows (a new phase of the kit adds types, a future runtime
 * adds usage), so this never switches exhaustively: an unknown type is rendered
 * from its own name rather than dropped or crashing the timeline.
 */
import type { WorkflowEvent } from './types.js';

export type EventTone = 'ok' | 'warn' | 'fail' | 'info' | 'muted';

export interface EventLine {
  /** Short semantic label: "Read file", "Gate passed". */
  label: string;
  /** The specific thing it happened to, when there is one. */
  detail?: string;
  tone: EventTone;
  /** True when the label came from the fallback, not from a known type. */
  generic: boolean;
}

const KNOWN: Partial<Record<string, { label: string; tone: EventTone }>> = {
  RUN_STARTED: { label: 'Run started', tone: 'info' },
  RUN_ROUTED: { label: 'Run routed', tone: 'info' },
  RUN_ESCALATED: { label: 'Run escalated', tone: 'warn' },
  RUN_COMPLETED: { label: 'Run completed', tone: 'ok' },
  RUN_FAILED: { label: 'Run failed', tone: 'fail' },
  RUN_ABANDONED: { label: 'Run abandoned', tone: 'warn' },
  NODE_ENTER: { label: 'Phase started', tone: 'info' },
  NODE_COMPLETE: { label: 'Phase completed', tone: 'ok' },
  NODE_SKIP: { label: 'Phase skipped', tone: 'muted' },
  NODE_FAIL: { label: 'Phase failed', tone: 'fail' },
  GATE_WAIT: { label: 'Waiting on gate', tone: 'warn' },
  GATE_PASS: { label: 'Gate passed', tone: 'ok' },
  GATE_FAIL: { label: 'Gate failed', tone: 'fail' },
  GATE_OVERRIDE: { label: 'Gate overridden', tone: 'warn' },
  MUTATION_DENIED: { label: 'Write denied', tone: 'warn' },
  ARTIFACT: { label: 'Artifact written', tone: 'ok' },
  NOTE: { label: 'Note', tone: 'muted' },
  FILE_READ: { label: 'Read', tone: 'muted' },
  FILE_CHANGED: { label: 'Changed', tone: 'ok' },
  COMMAND_STARTED: { label: 'Ran', tone: 'info' },
  COMMAND_COMPLETED: { label: 'Command finished', tone: 'muted' },
  COMMAND_FAILED: { label: 'Command failed', tone: 'fail' },
  TEST_STARTED: { label: 'Tests started', tone: 'info' },
  TEST_PASSED: { label: 'Tests passed', tone: 'ok' },
  TEST_FAILED: { label: 'Tests failed', tone: 'fail' },
  USAGE_RECORDED: { label: 'Usage recorded', tone: 'muted' },
  TOOL_START: { label: 'Tool', tone: 'muted' },
  TOOL_END: { label: 'Tool finished', tone: 'muted' },
  TOOL_FAIL: { label: 'Tool failed', tone: 'fail' },
  SUBAGENT_START: { label: 'Subagent started', tone: 'info' },
  SUBAGENT_STOP: { label: 'Subagent finished', tone: 'muted' },
  SESSION_START: { label: 'Session started', tone: 'muted' },
  SESSION_END: { label: 'Session ended', tone: 'muted' },
  PROMPT_SUBMIT: { label: 'Prompt', tone: 'info' },
  TURN_COMPLETE: { label: 'Turn complete', tone: 'muted' },
  TURN_FAILED: { label: 'Turn failed', tone: 'fail' },
  MISSION_CLASSIFIED: { label: 'Mission classified', tone: 'info' },
  MISSION_PLANNED: { label: 'Mission planned', tone: 'info' },
  MISSION_STATE: { label: 'Mission state', tone: 'muted' },
  MISSION_PAUSED: { label: 'Mission paused', tone: 'warn' },
  MISSION_RESUMED: { label: 'Mission resumed', tone: 'info' },
  MISSION_CANCELLED: { label: 'Mission cancelled', tone: 'warn' },
  CHECKPOINT_OPENED: { label: 'Checkpoint opened', tone: 'warn' },
  CHECKPOINT_RESOLVED: { label: 'Checkpoint answered', tone: 'ok' },
  DECISION_RECORDED: { label: 'Decision recorded', tone: 'ok' },
  RISK_RECORDED: { label: 'Risk recorded', tone: 'warn' },
  RISK_ESCALATED: { label: 'Risk escalated', tone: 'fail' },
  ACCEPTED_RISK: { label: 'Risk accepted', tone: 'warn' },
  OFF_TRACK: { label: 'Off track', tone: 'warn' },
  SCOPE_CHANGED: { label: 'Scope changed', tone: 'warn' },
  TASK_ADDED: { label: 'Task added', tone: 'muted' },
  TASK_UPDATED: { label: 'Task updated', tone: 'muted' },
  CONFIDENCE_UPDATED: { label: 'Confidence updated', tone: 'muted' },
  EVIDENCE_UPDATED: { label: 'Evidence updated', tone: 'muted' },
  DELIVERABLE_UPDATED: { label: 'Deliverable updated', tone: 'muted' },
  SPEC_DRIFT: { label: 'Spec drift', tone: 'warn' },
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** "CUSTOM_FUTURE_EVENT" -> "Custom future event". Never empty. */
export function humaniseType(type: string): string {
  const words = String(type ?? '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return 'Event';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function describeEvent(event: WorkflowEvent): EventLine {
  const known = KNOWN[event.type];
  const detail =
    str(event.data?.['path']) ??
    str(event.data?.['executable']) ??
    str(event.artifact) ??
    str(event.gate) ??
    str(event.message) ??
    str(event.node) ??
    str(event.tool);

  const line: EventLine = {
    label: known?.label ?? humaniseType(event.type),
    tone: known?.tone ?? 'info',
    generic: !known,
  };
  if (detail) line.detail = detail.length > 160 ? `${detail.slice(0, 157)}…` : detail;
  return line;
}

/** Events worth showing in the "what is Claude doing" feed. */
const NOISE = new Set(['TOOL_END', 'COMMAND_COMPLETED', 'TURN_COMPLETE', 'SESSION_START', 'MISSION_STATE']);

export function isActivityEvent(event: WorkflowEvent): boolean {
  return !NOISE.has(event.type);
}
