/**
 * Mission Board actions — the write half of the monitor.
 *
 * The board exists so the user can steer a run without typing `cw` commands, so
 * every action here maps to exactly one runtime call and carries the same
 * requirements: a rejection needs a note, a cancellation needs a reason, and
 * accepting a blocker is recorded as the user's decision. Nothing here can pass a
 * gate, complete a run, or approve a checkpoint on the user's behalf.
 */
import { WorkflowRuntime, type MissionState } from '@claude-workflow-kit/workflow-core';
import { buildRunDetail, type RunDetail } from './snapshot.js';
import { HttpError } from './http.js';

/** A board action the runtime refused, or one the request did not describe fully. */
export class ActionError extends HttpError {}

export interface ActionRequest {
  action: string;
  checkpointId?: string;
  note?: string;
  reason?: string;
  taskId?: string;
  /** For add-to-scope: the new scope, comma separated. */
  scope?: string;
  state?: string;
}

export const BOARD_ACTIONS = [
  'checkpoint.approve',
  'checkpoint.reject',
  'checkpoint.modify',
  'checkpoint.cancel',
  'checkpoint.request-evidence',
  'mission.pause',
  'mission.resume',
  'mission.cancel',
  'mission.accept-risk',
  'mission.return-to-scope',
  'mission.add-to-scope',
  'mission.state',
  'task.skip',
] as const;

function required(value: string | undefined, what: string): string {
  const text = value?.trim();
  if (!text) throw new ActionError(`"${what}" is required for this action`);
  return text;
}

function checkpointOf(runtime: WorkflowRuntime, runId: string, request: ActionRequest): string {
  if (request.checkpointId?.trim()) return request.checkpointId.trim();
  const pending = runtime.mission(runId)?.checkpoints.filter((c) => c.status === 'PENDING') ?? [];
  if (pending.length === 1) return pending[0]!.id;
  throw new ActionError(
    pending.length
      ? `several checkpoints are pending (${pending.map((c) => c.id).join(', ')}); name one with "checkpointId"`
      : 'no checkpoint is pending on this run',
  );
}

/** Apply one board action and return the refreshed run detail. */
export function applyBoardAction(
  runtime: WorkflowRuntime,
  runId: string,
  request: ActionRequest,
): RunDetail {
  const action = request.action?.trim();
  if (!action) throw new ActionError('"action" is required');

  switch (action) {
    case 'checkpoint.approve':
    case 'checkpoint.reject':
    case 'checkpoint.modify':
    case 'checkpoint.cancel': {
      const verb = action.split('.')[1] as 'approve' | 'reject' | 'modify' | 'cancel';
      const opts: Parameters<WorkflowRuntime['resolveCheckpoint']>[1] = {
        action: verb,
        runId,
        via: 'board',
      };
      if (request.note?.trim()) opts.note = request.note.trim();
      runtime.resolveCheckpoint(checkpointOf(runtime, runId, request), opts);
      break;
    }

    // "Request More Evidence" is a rejection with a stated gap, not a third
    // outcome: the mission goes back to investigating with the question recorded.
    case 'checkpoint.request-evidence': {
      runtime.resolveCheckpoint(checkpointOf(runtime, runId, request), {
        action: 'reject',
        runId,
        via: 'board',
        note: `more evidence required: ${required(request.note, 'note')}`,
      });
      break;
    }

    case 'mission.pause': {
      const opts: Parameters<WorkflowRuntime['pauseMission']>[0] = { runId };
      if (request.reason?.trim()) opts.reason = request.reason.trim();
      runtime.pauseMission(opts);
      break;
    }

    case 'mission.resume':
      runtime.resumeMission({ runId });
      break;

    case 'mission.cancel':
      runtime.cancelMission({ runId, reason: required(request.reason, 'reason') });
      break;

    case 'mission.accept-risk':
      runtime.acceptMissionRisk({ runId, reason: required(request.reason, 'reason') });
      break;

    case 'mission.return-to-scope':
      runtime.setOffTrack({
        runId,
        status: 'ON_TRACK',
        ...(request.note?.trim() ? { reason: request.note.trim() } : {}),
      });
      break;

    case 'mission.add-to-scope': {
      const mission = runtime.mission(runId);
      runtime.recordScopeChange({
        runId,
        previousScope: mission?.plan?.scope.join(', ') ?? '(unrecorded)',
        newScope: required(request.scope, 'scope'),
        reason: required(request.reason ?? request.note, 'reason'),
      });
      runtime.setOffTrack({ runId, status: 'ON_TRACK', reason: 'scope was widened on purpose' });
      break;
    }

    case 'mission.state':
      runtime.setMissionState(required(request.state, 'state') as MissionState, { runId });
      break;

    case 'task.skip':
      runtime.updateMissionTask(required(request.taskId, 'taskId'), 'SKIPPED', {
        runId,
        ...(request.note?.trim() ? { message: request.note.trim() } : {}),
      });
      break;

    default:
      throw new ActionError(
        `unknown action "${action}" (known: ${BOARD_ACTIONS.join(', ')})`,
        404,
      );
  }

  // A cancelled mission retires the run; the caller still gets its final state.
  return buildRunDetail(runtime, runId);
}
