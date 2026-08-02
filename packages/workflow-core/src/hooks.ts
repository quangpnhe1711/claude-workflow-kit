import type { EventType, WorkflowEvent } from './types.js';
import type { WorkflowRuntime } from './runtime.js';

/**
 * Claude Code hook payload. Field names vary slightly between hook events and
 * Claude Code versions, so everything is read defensively.
 */
export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  agent_id?: string;
  subagent_type?: string;
  agent_type?: string;
  prompt?: string;
  task_id?: string;
  description?: string;
  error?: string;
  tool_response?: { success?: boolean; error?: unknown } | unknown;
  [key: string]: unknown;
}

const HOOK_TO_EVENT: Record<string, EventType> = {
  SessionStart: 'SESSION_START',
  SessionEnd: 'SESSION_END',
  UserPromptSubmit: 'PROMPT_SUBMIT',
  PreToolUse: 'TOOL_START',
  PostToolUse: 'TOOL_END',
  PostToolUseFailure: 'TOOL_FAIL',
  SubagentStart: 'SUBAGENT_START',
  SubagentStop: 'SUBAGENT_STOP',
  TaskCreated: 'TASK_CREATED',
  TaskCompleted: 'TASK_COMPLETED',
  Stop: 'TURN_COMPLETE',
  StopFailure: 'TURN_FAILED',
};

export function hookEventType(hookName: string | undefined): EventType | undefined {
  if (!hookName) return undefined;
  return HOOK_TO_EVENT[hookName];
}

export function hookPayloadToEvent(payload: ClaudeHookPayload): Partial<WorkflowEvent> | undefined {
  const type = hookEventType(payload.hook_event_name);
  if (!type) return undefined;

  const out: Partial<WorkflowEvent> = { };
  if (payload.session_id) out.sessionId = payload.session_id;
  if (payload.tool_name) out.tool = payload.tool_name;

  const agentName = payload.subagent_type ?? payload.agent_type;
  if (agentName) out.agent = agentName;
  if (payload.agent_id) out.agentId = payload.agent_id;

  if (type === 'PROMPT_SUBMIT' && typeof payload.prompt === 'string') {
    out.message = payload.prompt.slice(0, 200);
  }
  if (typeof payload.description === 'string') out.message = payload.description.slice(0, 200);
  if (typeof payload.error === 'string') out.message = payload.error.slice(0, 500);

  return out;
}

/**
 * Apply one Claude Code hook payload. Hooks must never break a session, so the
 * caller is expected to swallow errors and exit 0 regardless.
 */
export function applyHook(runtime: WorkflowRuntime, payload: ClaudeHookPayload): string | undefined {
  const type = hookEventType(payload.hook_event_name);
  if (!type) return undefined;
  const data = hookPayloadToEvent(payload) ?? {};
  // Only a prompt may open a generic run; a stray tool call must not.
  const autoStart = type === 'PROMPT_SUBMIT' || type === 'SESSION_START';
  const run = runtime.recordRuntimeEvent(type, data, { autoStart });
  return run?.runId;
}
