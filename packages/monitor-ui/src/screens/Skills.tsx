import { useEffect, useState } from 'react';
import { fetchSkill, fetchSkills } from '../api';
import { formatDuration } from '../derive';
import { Markdown } from '../panels/Markdown';
import type { SkillGuide, SkillGuideEntry, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot;
}

/**
 * The guide.
 *
 * Every word here is read from the `SKILL.md` files installed in this project —
 * the same files Claude Code reads. Written documentation would drift from the
 * installed skills within a release; this cannot, because it *is* them.
 */
export function Skills({ snapshot }: Props) {
  const [guide, setGuide] = useState<SkillGuide | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillGuideEntry | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSkills()
      .then(setGuide)
      .catch((failure: Error) => setError(failure.message));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetchSkill(selected)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (error) {
    return (
      <div className="screen__pad">
        <div className="detail__error">{error}</div>
      </div>
    );
  }

  const skills = guide?.skills ?? [];
  const text = query.trim().toLowerCase();
  const match = (skill: SkillGuideEntry) =>
    !text || `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(text);
  const commands = skills.filter((s) => s.entry && match(s));
  const steps = skills.filter((s) => !s.entry && match(s));

  return (
    <div className="guide">
      <aside className="guide__list">
        <input
          className="input"
          type="search"
          placeholder="Search skills…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <button
          type="button"
          className={`guide__item${selected === null ? ' is-selected' : ''}`}
          onClick={() => setSelected(null)}
        >
          <span className="guide__name">Getting started</span>
          <span className="guide__hint">how the kit is driven</span>
        </button>

        <div className="panel__title">Commands you type</div>
        {commands.map((skill) => (
          <button
            key={skill.name}
            type="button"
            className={`guide__item${selected === skill.name ? ' is-selected' : ''}`}
            onClick={() => setSelected(skill.name)}
          >
            <span className="guide__name mono">/{skill.name}</span>
            <span className="guide__hint">{skill.description?.split('.')[0]}</span>
          </button>
        ))}
        {commands.length === 0 && <div className="empty">No entry skills match.</div>}

        <div className="panel__title">Steps that run inside</div>
        {steps.map((skill) => (
          <button
            key={skill.name}
            type="button"
            className={`guide__item${selected === skill.name ? ' is-selected' : ''}`}
            onClick={() => setSelected(skill.name)}
          >
            <span className="guide__name mono">{skill.name}</span>
            <span className="guide__hint">{skill.description?.split('.')[0]}</span>
          </button>
        ))}
      </aside>

      <div className="guide__body">
        {selected === null ? (
          <GettingStarted guide={guide} snapshot={snapshot} />
        ) : !detail ? (
          <div className="skeleton skeleton--block" />
        ) : (
          <SkillGuideView skill={detail} />
        )}
      </div>
    </div>
  );
}

function SkillGuideView({ skill }: { skill: SkillGuideEntry }) {
  return (
    <article className="screen__pad">
      <div className="screen__head">
        <h1 className="mono">
          {skill.entry ? `/${skill.name}` : skill.name}
        </h1>
        {skill.effort && <span className="chip">effort {skill.effort}</span>}
        {!skill.entry && (
          <span className="chip" title="Invoked by another skill, not typed by you.">
            step skill
          </span>
        )}
      </div>

      {skill.description && <p className="guide__lede">{skill.description}</p>}

      <section className="panel">
        <div className="panel__subtitle">How to run it</div>
        {skill.entry ? (
          <>
            <pre className="md__code">
              <code>
                /{skill.name}
                {skill.argumentHint ? ` ${skill.argumentHint}` : ''}
              </code>
            </pre>
            <p className="dim">Type this in Claude Code. The run appears in the monitor as it starts.</p>
          </>
        ) : (
          <p className="dim">
            You do not invoke this one. It runs inside a workflow phase
            {skill.usedBy.length > 0 && (
              <>
                {' '}
                — {skill.usedBy.map((use) => `${use.workflowLabel} · ${use.nodeLabel}`).join(', ')}
              </>
            )}
            .
          </p>
        )}

        <dl className="detail__grid">
          {skill.usedBy.length > 0 && (
            <>
              <dt>Runs in</dt>
              <dd>
                {skill.usedBy.map((use) => (
                  <div key={`${use.workflow}:${use.node}`}>
                    {use.workflowLabel} · {use.nodeLabel}
                    {use.gate && <span className="gate"> {use.gate}</span>}
                  </div>
                ))}
              </dd>
            </>
          )}
          <dt>Used by</dt>
          <dd>
            {skill.runs > 0 ? (
              <>
                {skill.runs} run{skill.runs === 1 ? '' : 's'}
                {skill.successRate !== null && ` · ${Math.round(skill.successRate * 100)}% success`}
                {skill.averageDurationMs !== null && ` · ${formatDuration(skill.averageDurationMs)} average`}
              </>
            ) : (
              <span className="dim">never run in this project</span>
            )}
          </dd>
          <dt>Source</dt>
          <dd className="mono dim">{skill.file}</dd>
        </dl>
      </section>

      {skill.outline.length > 0 && (
        <section className="panel">
          <div className="panel__subtitle">What it does, in order</div>
          <ol className="guide__outline">
            {skill.outline.map((heading) => (
              <li key={heading}>{heading}</li>
            ))}
          </ol>
        </section>
      )}

      <details className="group" open>
        <summary>
          Full instructions
          <span className="group__count">{(skill.bytes / 1024).toFixed(1)} KB</span>
        </summary>
        <div className="group__body">
          <Markdown source={skill.body} />
        </div>
      </details>
    </article>
  );
}

/**
 * The one thing a new user needs: what to type, what happens, and where to
 * answer when the workflow stops and asks.
 */
function GettingStarted({ guide, snapshot }: { guide: SkillGuide | null; snapshot: Snapshot }) {
  const entries = (guide?.skills ?? []).filter((s) => s.entry);
  return (
    <article className="screen__pad">
      <div className="screen__head">
        <h1>Getting started</h1>
        <span className="dim mono">{snapshot.projectRoot}</span>
      </div>

      {guide && entries.length === 0 && (
        <div className="empty empty--panel">
          <strong>No skills are installed in this project.</strong>
          <div className="empty__hint">
            Install them with <code>claude-workflow-kit init</code>. The guide reads{' '}
            <span className="mono">{guide.skillsDir}</span>.
          </div>
        </div>
      )}

      <section className="panel">
        <div className="panel__subtitle">1 · Hand over a task</div>
        <p>
          Type one of these in Claude Code. If you are not sure which, use <code>/work</code> — it
          classifies the task and picks the shortest safe path for you.
        </p>
        <div className="chain">
          {entries.map((skill) => (
            <span key={skill.name} className="chain__step">
              <span className="chain__label mono">/{skill.name}</span>
            </span>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel__subtitle">2 · Watch it work</div>
        <p>
          The run appears under <strong>Runs</strong>. The diagram is the workflow it chose; the
          activity feed is what Claude is doing right now; the timeline is everything that happened.
          A phase that changed files says so on the node.
        </p>
      </section>

      <section className="panel">
        <div className="panel__subtitle">3 · Answer when it stops</div>
        <p>
          A hard gate or a checkpoint denies repository writes until you answer — that is the point
          of the kit, not a bug. Open the run and use the <strong>Governance</strong> panel:
          approve, reject with a note, ask for more evidence, or accept the blockers deliberately.
          Every answer is recorded with its reason.
        </p>
      </section>

      <section className="panel">
        <div className="panel__subtitle">Same thing from the terminal</div>
        <pre className="md__code">
          <code>{[
            'cw status                    # where the run is',
            'cw board                     # the mission board as text',
            'cw checkpoint resolve CP-001 --action approve',
            'cw rollup                    # what this run has done',
            'cw usage sync                # token usage for the run',
            'cw run abandon --message "…" # retire a run honestly',
          ].join('\n')}</code>
        </pre>
      </section>
    </article>
  );
}
