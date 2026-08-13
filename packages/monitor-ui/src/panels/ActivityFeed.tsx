import { useState } from 'react';
import { clock } from '../derive';
import { describeEvent, isActivityEvent } from '../eventText';
import type { RunView, WorkflowEvent } from '../types';

interface Props {
  run: RunView;
  events: WorkflowEvent[];
  nowMs: number;
}

/**
 * What Claude is doing, in words.
 *
 * The primary view is semantic — "Read src/a.ts", "Gate passed" — because a
 * stream of raw JSON is a log file, not an interface. The raw payload is one
 * click away for the moments when the summary is not enough.
 */
export function ActivityFeed({ run, events, nowMs }: Props) {
  const [raw, setRaw] = useState(false);
  const live = ['RUNNING', 'WAITING_USER'].includes(run.derivedStatus);
  const recent = events.filter(isActivityEvent).slice(-60).reverse();

  return (
    <section className="activity">
      <div className="activity__head">
        <div className="activity__status">
          {live ? (
            <>
              <span className={`dot claude-${run.runtime.claude.toLowerCase()}`} />
              <span>
                {run.derivedStatus === 'WAITING_USER'
                  ? 'Waiting for you'
                  : run.runtime.claude === 'TOOL_RUNNING'
                    ? `Running ${run.runtime.tool ?? 'a tool'}`
                    : run.runtime.claude.replace('_', ' ').toLowerCase()}
              </span>
            </>
          ) : (
            <span className="dim">Run finished — this is the recorded activity.</span>
          )}
        </div>
        <div className="seg">
          <button type="button" className={`seg__btn${raw ? '' : ' is-active'}`} onClick={() => setRaw(false)}>
            Semantic
          </button>
          <button type="button" className={`seg__btn${raw ? ' is-active' : ''}`} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      </div>

      {recent.length === 0 && <div className="empty">No activity recorded yet.</div>}

      {raw ? (
        <pre className="activity__raw">
          {recent.map((event) => JSON.stringify(event)).join('\n') || '—'}
        </pre>
      ) : (
        <ul className="activity__list">
          {recent.map((event, i) => {
            const line = describeEvent(event);
            return (
              <li key={`${event.ts}-${i}`} className={`activity__item tone-${line.tone}`}>
                <span className="activity__time mono">{clock(event.ts)}</span>
                <span className="activity__label">{line.label}</span>
                {line.detail && <span className="activity__detail mono">{line.detail}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {live && (
        <div className="activity__foot dim">
          streaming · {Math.max(0, Math.round((nowMs - Date.parse(run.lastActivityAt)) / 1000))}s since last event
        </div>
      )}
    </section>
  );
}
