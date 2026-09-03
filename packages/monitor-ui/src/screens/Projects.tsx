import { useEffect, useState } from 'react';
import {
  addProject,
  fetchDoctor,
  fetchWorkspaceAnalytics,
  installProject,
  removeProject,
} from '../api';
import { ago } from '../derive';
import { href, navigate } from '../router';
import { useMonitor } from '../store';
import type { DoctorCheck, InstallOutcome, ProjectSummary, WorkspaceAnalytics } from '../types';

/**
 * The workspace: every project the app knows about, and the two operations that
 * used to require the terminal — installing the kit into a repository, and
 * asking `doctor` whether that worked.
 *
 * "Remove" unregisters and nothing more. The kit stays installed in the
 * repository, because a list of projects is the app's opinion and the contents
 * of someone's repository are not.
 */
export function Projects() {
  const { projects, app } = useMonitor();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('');
  const [runInstall, setRunInstall] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ project: string; install?: InstallOutcome } | null>(null);
  const [checks, setChecks] = useState<{ projectId: string; checks: DoctorCheck[] } | null>(null);
  const [rollup, setRollup] = useState<WorkspaceAnalytics | null>(null);

  // Recomputed whenever the registry changes shape, which is the only time these
  // totals can move without a run also moving.
  const registrySignature = projects.map((p) => `${p.id}:${p.totalRuns}`).join(',');
  useEffect(() => {
    let cancelled = false;
    fetchWorkspaceAnalytics()
      .then((next) => !cancelled && setRollup(next))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [registrySignature]);

  const provisioning = app?.capabilities.provisioning ?? false;
  const presets = app?.presets ?? [];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await addProject({
        path: path.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(runInstall && provisioning
          ? { install: { mode: 'init' as const, ...(preset ? { preset } : {}) } }
          : {}),
      });
      setOutcome({ project: result.project.name, ...(result.install ? { install: result.install } : {}) });
      setPath('');
      setName('');
      navigate({ name: 'dashboard', projectId: result.project.id });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen__pad">
      <div className="screen__head">
        <h1>Projects</h1>
        <span className="dim">
          {projects.length} registered{app ? ` · ${app.workspaceFile}` : ''}
        </span>
      </div>

      <section className="panel">
        <div className="panel__head">
          <div className="panel__name">Add a project</div>
          <span className="dim">the directory stays where it is; only a pointer is stored</span>
        </div>
        <form className="form" onSubmit={submit}>
          <label className="form__row">
            <span className="form__label">Path</span>
            <input
              className="input mono"
              value={path}
              placeholder="/path/to/repository"
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <label className="form__row">
            <span className="form__label">Name</span>
            <input
              className="input"
              value={name}
              placeholder="(defaults to the directory name)"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {provisioning ? (
            <>
              <label className="form__row form__row--check">
                <input
                  type="checkbox"
                  checked={runInstall}
                  onChange={(e) => setRunInstall(e.target.checked)}
                />
                <span>
                  Install the kit here (skills, agents, hooks, <code>CLAUDE.md</code> block)
                </span>
              </label>
              {runInstall && (
                <label className="form__row">
                  <span className="form__label">Preset</span>
                  <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
                    <option value="">default</option>
                    {presets.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ) : (
            <p className="dim">
              This build has no installer attached, so projects can be watched but not installed.
              Run the app through the <code>claude-workflow-kit</code> CLI to enable that.
            </p>
          )}
          <div className="form__actions">
            <button className="btn btn--primary" disabled={busy || !path.trim()} type="submit">
              {busy ? 'Working…' : 'Add project'}
            </button>
          </div>
        </form>

        {error && <div className="detail__error">{error}</div>}
        {outcome && (
          <div className="notice">
            Added <strong>{outcome.project}</strong>
            {outcome.install ? ` · ${outcome.install.written.length} files written` : ''}
            {outcome.install?.conflicts.length
              ? ` · ${outcome.install.conflicts.length} preserved conflict(s)`
              : ''}
          </div>
        )}
      </section>

      {rollup && rollup.totals.totalRuns > 0 && (
        <section className="panel">
          <div className="panel__head">
            <div className="panel__name">Across every project</div>
            <span className="dim">
              {rollup.totals.installed} of {rollup.totals.projects} installed
            </span>
          </div>
          <div className="metrics">
            <Metric label="Runs" value={String(rollup.totals.totalRuns)} />
            <Metric label="Active" value={String(rollup.totals.active)} />
            <Metric label="Blocked" value={String(rollup.totals.blocked)} />
            <Metric
              label="Success"
              value={
                rollup.totals.successRate === null
                  ? 'N/A'
                  : `${Math.round(rollup.totals.successRate * 100)}%`
              }
            />
            <Metric
              label="Tokens"
              value={
                rollup.totals.totalTokens === null
                  ? 'N/A'
                  : rollup.totals.totalTokens.toLocaleString()
              }
            />
          </div>
          <table className="table table--tight">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Runs</th>
                <th className="num">Active</th>
                <th className="num">Completed</th>
                <th className="num">Failed</th>
                <th className="num">Success</th>
              </tr>
            </thead>
            <tbody>
              {rollup.projects.map((row) => (
                <tr key={row.id}>
                  <td>
                    <a className="table__link" href={href({ name: 'dashboard', projectId: row.id })}>
                      {row.name}
                    </a>
                    {row.error && <div className="dim">{row.error}</div>}
                  </td>
                  <td className="num">{row.totalRuns}</td>
                  <td className="num">{row.active}</td>
                  <td className="num">{row.completed}</td>
                  <td className="num">{row.failed}</td>
                  <td className="num">
                    {row.successRate === null ? 'N/A' : `${Math.round(row.successRate * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {projects.length === 0 ? (
        <section className="panel">
          <p className="dim">
            No projects yet. Add the repository you want Claude Code to work in — the app watches its
            <code> .ai-workflow</code> directory from there.
          </p>
        </section>
      ) : (
        <div className="cards">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              busy={busy}
              provisioning={provisioning}
              checks={checks?.projectId === project.id ? checks.checks : null}
              onDoctor={() => act(async () => setChecks(await fetchDoctor(project.id)))}
              onUpdate={() => act(() => installProject(project.id, { mode: 'update' }))}
              onInstall={() => act(() => installProject(project.id, { mode: 'init' }))}
              onRemove={() => act(() => removeProject(project.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric__value">{value}</div>
      <div className="metric__label">{label}</div>
    </div>
  );
}

interface CardProps {
  project: ProjectSummary;
  busy: boolean;
  provisioning: boolean;
  checks: DoctorCheck[] | null;
  onDoctor: () => void;
  onInstall: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}

function ProjectCard({
  project,
  busy,
  provisioning,
  checks,
  onDoctor,
  onInstall,
  onUpdate,
  onRemove,
}: CardProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className={`card${project.available ? '' : ' card--muted'}`}>
      <div className="card__head">
        <a className="card__title" href={href({ name: 'dashboard', projectId: project.id })}>
          {project.name}
        </a>
        <div className="card__pills">
          {!project.available && <span className="pill pill--fail">missing</span>}
          {project.available && !project.installed && <span className="pill pill--warn">not installed</span>}
          {project.pendingCheckpoints > 0 && (
            <span className="chip chip--count" title="checkpoints waiting for a decision">
              {project.pendingCheckpoints} waiting
            </span>
          )}
        </div>
      </div>
      <div className="dim mono card__path">{project.path}</div>

      <div className="card__stats dim">
        {project.installed ? (
          <>
            {project.activeRuns} active · {project.waitingRuns} waiting · {project.totalRuns} total
            {project.preset ? ` · preset ${project.preset}` : ''}
            {project.lastActivityAt ? ` · last activity ${ago(project.lastActivityAt, Date.now())}` : ''}
          </>
        ) : (
          project.error ?? 'the kit has not been installed in this directory yet'
        )}
      </div>

      <div className="card__actions">
        <a className="btn" href={href({ name: 'dashboard', projectId: project.id })}>
          Open
        </a>
        {provisioning && project.available && (
          <>
            <button className="btn" disabled={busy} onClick={onDoctor}>
              Doctor
            </button>
            {project.installed ? (
              <button className="btn" disabled={busy} onClick={onUpdate}>
                Update
              </button>
            ) : (
              <button className="btn" disabled={busy} onClick={onInstall}>
                Install
              </button>
            )}
          </>
        )}
        {confirming ? (
          <>
            <button className="btn btn--danger" disabled={busy} onClick={onRemove}>
              Really unregister
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setConfirming(true)}>
            Remove
          </button>
        )}
      </div>

      {checks && (
        <table className="table table--tight">
          <tbody>
            {checks.map((check) => (
              <tr key={check.name}>
                <td className={`check check--${check.status}`}>{check.status}</td>
                <td>{check.name}</td>
                <td className="dim mono">{check.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
