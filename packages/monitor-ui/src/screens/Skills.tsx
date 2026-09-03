import { useEffect, useState } from 'react';
import { fetchAnalytics } from '../api';
import { useProjectId } from '../project';
import { formatDuration } from '../derive';
import type { Analytics, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot;
}

/**
 * Skills and the workflows they run inside.
 *
 * There is no skill registry in the kit — a skill is named by the phase that
 * declares it — so identity and stats are derived from the workflow definitions
 * and the runs that actually entered those phases. A skill nobody has run yet
 * shows no statistics rather than zeroes.
 */
export function Skills({ snapshot }: Props) {
  const projectId = useProjectId();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAnalytics(projectId)
      .then((next) => {
        if (!cancelled) setAnalytics(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const statOf = (skill: string) => analytics?.skills.find((s) => s.skill === skill);

  return (
    <div className="screen__pad">
      <div className="screen__head">
        <h1>Skills</h1>
        <span className="dim">declared by the installed workflows</span>
      </div>

      {snapshot.workflows.map((workflow) => {
        const phases = workflow.nodes.filter((node) => node.kind === 'phase' || node.kind === 'waiting');
        const stat = analytics?.workflows.find((w) => w.workflow === workflow.id);
        return (
          <section className="panel" key={workflow.id}>
            <div className="panel__head">
              <div>
                <div className="panel__name">{workflow.label}</div>
                <div className="dim mono">{workflow.id}</div>
              </div>
              <div className="panel__stats dim">
                {stat ? (
                  <>
                    {stat.runs} run{stat.runs === 1 ? '' : 's'} ·{' '}
                    {stat.successRate === null ? 'N/A' : `${Math.round(stat.successRate * 100)}% success`} ·{' '}
                    {formatDuration(stat.averageDurationMs ?? undefined)} avg · tokens N/A
                  </>
                ) : (
                  'never run'
                )}
              </div>
            </div>

            {workflow.description && <p className="dim">{workflow.description}</p>}

            <div className="chain">
              {phases.map((node, i) => (
                <span key={node.id} className="chain__step">
                  <span className={`chain__label${node.gate ? ' chain__label--gate' : ''}`} title={node.description ?? ''}>
                    {node.label}
                    {node.gate && <span className="gate">{node.gate}</span>}
                  </span>
                  {i < phases.length - 1 && <span className="chain__arrow">→</span>}
                </span>
              ))}
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Phase</th>
                  <th className="num">Runs</th>
                  <th className="num">Success</th>
                  <th className="num">Average</th>
                </tr>
              </thead>
              <tbody>
                {phases
                  .filter((node) => node.skill)
                  .map((node) => {
                    const stats = statOf(node.skill!);
                    return (
                      <tr key={node.id}>
                        <td className="mono">{node.skill}</td>
                        <td>{node.label}</td>
                        <td className="num">{stats?.runs ?? 0}</td>
                        <td className="num">
                          {stats?.successRate === undefined || stats.successRate === null
                            ? 'N/A'
                            : `${Math.round(stats.successRate * 100)}%`}
                        </td>
                        <td className="num">{formatDuration(stats?.averageDurationMs ?? undefined)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
