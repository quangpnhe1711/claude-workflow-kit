import type { EventType, MutationDecision, WorkflowEvent } from './types.js';
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
  tool_input?: Record<string, unknown>;
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

export interface HookResult {
  runId?: string;
  /** Present for PreToolUse. `allow` means "say nothing", never a forced allow. */
  mutation?: MutationDecision;
}

/**
 * Apply one Claude Code hook payload. Hooks must never break a session, so the
 * caller is expected to swallow errors and exit 0 regardless.
 */
export function applyHook(runtime: WorkflowRuntime, payload: ClaudeHookPayload): HookResult {
  const type = hookEventType(payload.hook_event_name);
  if (!type) return {};
  const data = hookPayloadToEvent(payload) ?? {};

  // Gate check happens before recording: a denied call never runs, so it must
  // not be reported as a tool that started.
  let mutation: MutationDecision | undefined;
  if (type === 'TOOL_START') {
    // The policy either ran or it did not, and "did not" is invisible to Claude
    // Code — a crashed hook reads exactly like an allow. Record which happened.
    try {
      mutation = runtime.checkMutation({
        toolName: payload.tool_name,
        toolInput: payload.tool_input,
        sessionId: payload.session_id,
      });
      runtime.recordPolicyEvaluation(true);
    } catch (error) {
      runtime.recordPolicyEvaluation(false, error);
      throw error;
    }
    if (mutation.decision === 'deny') return { mutation, ...(mutation.runId ? { runId: mutation.runId } : {}) };
  }

  // Only a prompt may open a generic run. A session merely starting must not:
  // that is what left one dead RUNNING run behind per Claude session.
  const autoStart = type === 'PROMPT_SUBMIT';
  const run = runtime.recordRuntimeEvent(type, data, { autoStart });

  // Observability: the tool payload exists here and nowhere else. It is
  // normalised to a path or a program name and then dropped — see telemetry.ts
  // for what is deliberately not persisted. A failure here must never surface,
  // because telemetry is not worth breaking a session over.
  const phase = type === 'TOOL_START' ? 'start' : type === 'TOOL_END' ? 'end' : type === 'TOOL_FAIL' ? 'fail' : undefined;
  if (run && phase) {
    try {
      runtime.recordObservations(run.runId, {
        phase,
        ...(payload.tool_name ? { toolName: payload.tool_name } : {}),
        ...(payload.tool_input ? { toolInput: payload.tool_input } : {}),
      });
    } catch {
      // telemetry is best-effort by design
    }
  }

  const result: HookResult = {};
  if (run) result.runId = run.runId;
  if (mutation) result.mutation = mutation;
  return result;
}
