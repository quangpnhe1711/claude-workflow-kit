import { useEffect, useState } from 'react';
import { fetchEvents } from '../api';
import { clock } from '../derive';
import { describeEvent } from '../eventText';
import type { WorkflowEvent } from '../types';

interface Props {
  runId: string;
  /** Newest events, already delivered with the run detail. */
  tail: WorkflowEvent[];
  eventBytes: number;
}

const PAGE = 200;

/**
 * The event timeline.
 *
 * `events.jsonl` is append-only and unbounded, so the default view is the tail
 * that arrived with the run detail. Full history is paged in from a byte cursor
 * on request — the run that has been going for two hours must not cost two hours
 * of JSON to open.
 */
export function Timeline({ runId, tail, eventBytes }: Props) {
  const [full, setFull] = useState(false);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching runs drops any history that was paged in for the previous one.
  useEffect(() => {
    setFull(false);
    setEvents([]);
    setCursor(0);
    setMore(false);
    setError(null);
  }, [runId]);

  const load = async (after: number): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchEvents(runId, after, PAGE);
      setEvents((current) => (after === 0 ? page.events : [...current, ...page.events]));
      setCursor(page.cursor);
      setMore(page.hasMore);
      setFull(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };

  const shown = full ? events : tail;

  return (
    <section className="timeline">
      <div className="timeline__head">
        <span className="panel__subtitle">Event timeline</span>
        <span className="dim">
          {full ? `${events.length} events from the start` : `latest ${tail.length}`}
          {eventBytes > 0 && ` · ${(eventBytes / 1024).toFixed(0)} KB of history`}
        </span>
        <div className="seg">
          <button
            type="button"
            className={`seg__btn${full ? '' : ' is-active'}`}
            onClick={() => setFull(false)}
          >
            Latest
          </button>
          <button
            type="button"
            className={`seg__btn${full ? ' is-active' : ''}`}
            disabled={loading}
            onClick={() => void load(0)}
          >
            Full history
          </button>
        </div>
      </div>

      {error && <div className="detail__error">{error}</div>}

      <ol className="timeline__list">
        {shown.map((event, i) => {
          const line = describeEvent(event);
          return (
            <li key={`${event.ts}-${i}`} className={`timeline__row tone-${line.tone}`}>
              <span className="timeline__time mono">{clock(event.ts)}</span>
              <span className="timeline__type mono">{event.type}</span>
              <span className="timeline__label">
                {line.label}
                {line.generic && <span className="chip" title="Event type unknown to this UI build">new</span>}
              </span>
              <span className="timeline__detail mono dim">{line.detail ?? ''}</span>
              {event.node && <span className="chip">{event.node}</span>}
            </li>
          );
        })}
      </ol>

      {shown.length === 0 && <div className="empty">No events recorded for this run yet.</div>}

      {full && more && (
        <button type="button" className="btn" disabled={loading} onClick={() => void load(cursor)}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
