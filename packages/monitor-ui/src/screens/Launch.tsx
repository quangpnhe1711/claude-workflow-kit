import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { fetchTaskOutput, fetchTasks, startTask, stopTask } from '../api';
import { ago, elapsed } from '../derive';
import { useProjectId } from '../project';
import { href } from '../router';
import { useMonitor } from '../store';
import type { LaunchMode, Snapshot, TaskRecord } from '../types';

interface Props {
  snapshot: Snapshot;
  nowMs: number;
}

const MODES: { id: LaunchMode; label: string; detail: string; unsafe: boolean }[] = [
  {
    id: 'plan',
    label: 'Plan',
    detail: 'Reads the repository and proposes a plan. Cannot edit anything.',
    unsafe: false,
  },
  {
    id: 'default',
    label: 'Ask',
    detail:
      'Asks before each write — but nobody is at the terminal to answer, so the session stops there.',
    unsafe: false,
  },
  {
    id: 'acceptEdits',
    label: 'Edit files',
    detail: 'Writes files in this repository without asking. Commands still prompt.',
    unsafe: true,
  },
  {
    id: 'bypassPermissions',
    label: 'Full access',
    detail: 'Writes files and runs commands without asking. Use only in a repository you can restore.',
    unsafe: true,
  },
];

/**
 * Start a Claude Code session in this project and watch it work.
 *
 * The session is a real one: it runs the installed skills and hooks, so what
 * appears here also appears in the monitor as a run. This screen adds nothing to
 * the workflow — it only saves opening a terminal.
 */
export function Launch({ snapshot, nowMs }: Props) {
  const projectId = useProjectId();
  const { app } = useMonitor();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<LaunchMode>('plan');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const launcherReady = app?.capabilities.launcher ?? false;
  const chosen = MODES.find((m) => m.id === mode)!;

  const refresh = useCallback(async () => {
    try {
      const result = await fetchTasks(projectId);
      setTasks(result.tasks);
      return result.tasks;
    } catch (failure) {
      setError((failure as Error).message);
      return [];
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while something is actually running. A finished list is static,
  // and the SSE snapshot already covers the run the session opened.
  const anyRunning = tasks.some((task) => task.status === 'RUNNING');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [anyRunning, refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { task } = await startTask(projectId, {
        prompt: prompt.trim(),
        mode,
        ...(chosen.unsafe ? { confirmUnsafe: true } : {}),
      });
      setPrompt('');
      setOpenTaskId(task.id);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen__pad">
      <div className="screen__head">
        <h1>Start a task</h1>
        <span className="dim mono">{snapshot.projectRoot}</span>
      </div>

      {!launcherReady && (
        <div className="notice notice--warn">
          Claude Code is not runnable from here
          {app?.claude.bin ? ` as “${app.claude.bin}”` : ''}
          {app?.claude.detail ? `: ${app.claude.detail}` : ''}. Install it, or point{' '}
          <code>CW_CLAUDE_BIN</code> at it, and restart the app.
        </div>
      )}

      <section className="panel">
        <form className="form" onSubmit={submit}>
          <textarea
            className="input input--area"
            rows={4}
            value={prompt}
            disabled={!launcherReady}
            placeholder="What should Claude Code do in this repository?"
            onChange={(e) => setPrompt(e.target.value)}
          />

          <div className="modes">
            {MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`mode${mode === option.id ? ' is-active' : ''}${option.unsafe ? ' mode--unsafe' : ''}`}
                onClick={() => {
                  setMode(option.id);
                  setAcknowledged(false);
                }}
                disabled={!launcherReady}
              >
                <span className="mode__label">{option.label}</span>
                <span className="mode__detail">{option.detail}</span>
              </button>
            ))}
          </div>

          {chosen.unsafe && (
            <label className="form__row form__row--check danger">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I understand this session can change <strong>{snapshot.projectRoot}</strong> without
                asking me first.
              </span>
            </label>
          )}

          <div className="form__actions">
            <button
              className="btn btn--primary"
              type="submit"
              disabled={!launcherReady || busy || !prompt.trim() || (chosen.unsafe && !acknowledged)}
            >
              {busy ? 'Starting…' : `Start in ${chosen.label} mode`}
            </button>
          </div>
        </form>
        {error && <div className="detail__error">{error}</div>}
      </section>

      <section className="panel">
        <div className="panel__head">
          <div className="panel__name">Sessions</div>
          <span className="dim">started from this app</span>
        </div>
        {tasks.length === 0 ? (
          <p className="dim">Nothing started here yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Run</th>
                <th className="num">Elapsed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                // A task renders as two rows when its output is open, so the key
                // belongs on the fragment rather than on either row.
                <Fragment key={task.id}>
                  <tr>
                    <td>
                      <button
                        className="table__link"
                        onClick={() => setOpenTaskId(openTaskId === task.id ? null : task.id)}
                      >
                        {task.prompt.length > 60 ? `${task.prompt.slice(0, 60)}…` : task.prompt}
                      </button>
                      <div className="dim mono">{ago(task.startedAt, nowMs)}</div>
                    </td>
                    <td className="mono">{task.mode}</td>
                    <td>
                      <span className={`pill pill--task_${task.status.toLowerCase()}`}>{task.status}</span>
                      {task.error && <div className="dim">{task.error}</div>}
                    </td>
                    <td className="mono">
                      {task.runId ? (
                        <a
                          className="table__link"
                          href={href({ name: 'run', projectId, runId: task.runId })}
                        >
                          {task.runId}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">{elapsed(task.startedAt, task.endedAt, nowMs)}</td>
                    <td>
                      {task.status === 'RUNNING' && (
                        <button
                          className="btn btn--danger"
                          onClick={() =>
                            void stopTask(projectId, task.id)
                              .then(refresh)
                              .catch((f: Error) => setError(f.message))
                          }
                        >
                          Stop
                        </button>
                      )}
                    </td>
                  </tr>
                  {openTaskId === task.id && (
                    <tr>
                      <td colSpan={6}>
                        <TaskOutput projectId={projectId} task={task} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/**
 * The session's own stream, read from a byte cursor so a long run costs one
 * page per poll rather than the whole log. Claude Code emits one JSON object
 * per line; anything that does not parse is shown as-is rather than dropped.
 */
function TaskOutput({ projectId, task }: { projectId: string; task: TaskRecord }) {
  const [lines, setLines] = useState<string[]>([]);
  const cursor = useRef(0);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    cursor.current = 0;
    setLines([]);

    const pull = async () => {
      try {
        const page = await fetchTaskOutput(projectId, task.id, cursor.current);
        if (cancelled || !page.text) return page.done;
        cursor.current = page.cursor;
        setLines((previous) => [
          ...previous,
          ...page.text.split('\n').filter(Boolean).map(describeStreamLine),
        ]);
        return page.done;
      } catch {
        return true;
      }
    };

    void pull();
    if (task.status !== 'RUNNING') return () => undefined;
    const timer = window.setInterval(() => void pull(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, task.id, task.status]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines.length]);

  return (
    <div className="output" ref={box}>
      {lines.length === 0 ? (
        <div className="dim">no output yet</div>
      ) : (
        lines.map((line, i) => (
          <div className="output__line mono" key={i}>
            {line}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * One line of `--output-format stream-json`, summarised.
 *
 * These are Claude Code's own session messages, not workflow events, so they are
 * formatted here rather than through `eventText` — the two vocabularies would
 * only be confusing if merged. An unrecognised shape is shown verbatim rather
 * than dropped: an unreadable line is still evidence that something happened.
 */
function describeStreamLine(line: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }

  switch (parsed?.type) {
    case 'system':
      return `· session ${parsed.subtype ?? 'event'}${parsed.model ? ` (${parsed.model})` : ''}`;
    case 'assistant':
    case 'user': {
      const content = parsed.message?.content;
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return `· ${parsed.type}`;
      return content
        .map((block: any) => {
          if (block?.type === 'text') return block.text;
          if (block?.type === 'tool_use') return `→ ${block.name}`;
          if (block?.type === 'tool_result') return `← result${block.is_error ? ' (error)' : ''}`;
          return `· ${block?.type ?? 'block'}`;
        })
        .join(' · ');
    }
    case 'result':
      return parsed.subtype === 'success'
        ? `✓ ${parsed.result ?? 'finished'}`
        : `✗ ${parsed.subtype ?? 'failed'}: ${parsed.error ?? parsed.result ?? ''}`;
    default:
      return line;
  }
}
