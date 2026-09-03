import { useEffect, useState } from 'react';
import { fetchConfig, fetchDoctor, patchConfig } from '../api';
import { useProjectId } from '../project';
import { useMonitor } from '../store';
import type { ConfigView, DoctorCheck } from '../types';

/**
 * The project's `config.json`, and whether the installation is healthy.
 *
 * Only the keys the server marks editable are shown as fields. The rest —
 * chiefly the lists that tell the PreToolUse policy what counts as a write —
 * are read-only here on purpose: a form that can empty `mutationTools` is a form
 * that can switch off gate enforcement by accident. They are shown anyway, so
 * the file is never a mystery.
 */
export function Settings() {
  const projectId = useProjectId();
  const { projects } = useMonitor();
  const project = projects.find((p) => p.id === projectId);

  const [view, setView] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setDraft({});
    fetchConfig(projectId)
      .then((next) => {
        if (cancelled) return;
        setView(next);
      })
      .catch((failure: Error) => !cancelled && setError(failure.message));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error && !view) {
    return (
      <div className="screen__pad">
        <div className="detail__error">{error}</div>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="screen__pad">
        <div className="skeleton skeleton--head" />
        <div className="skeleton skeleton--block" />
      </div>
    );
  }

  const config = view.config as Record<string, unknown>;
  const value = (key: string) => (key in draft ? draft[key] : config[key]);
  const changed = Object.keys(draft).filter((key) => draft[key] !== config[key]);

  const set = (key: string, next: unknown) => {
    setSaved(false);
    setDraft((previous) => ({ ...previous, [key]: next }));
  };

  async function save() {
    if (!changed.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of changed) patch[key] = draft[key];
      setView(await patchConfig(projectId, patch));
      setDraft({});
      setSaved(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const number = (key: string, label: string, hint: string) => (
    <label className="form__row" key={key}>
      <span className="form__label">{label}</span>
      <input
        className="input input--number"
        type="number"
        min={1}
        value={String(value(key) ?? '')}
        onChange={(e) => set(key, Number(e.target.value))}
      />
      <span className="dim form__hint">{hint}</span>
    </label>
  );

  const toggle = (key: string, label: string, hint: string) => (
    <label className="form__row form__row--check" key={key}>
      <input type="checkbox" checked={Boolean(value(key))} onChange={(e) => set(key, e.target.checked)} />
      <span>
        {label} <span className="dim">— {hint}</span>
      </span>
    </label>
  );

  return (
    <div className="screen__pad">
      <div className="screen__head">
        <h1>Settings</h1>
        <span className="dim mono">{view.file}</span>
      </div>

      {!view.exists && (
        <div className="notice notice--warn">
          The kit is not installed in this project yet, so these are the defaults. Install it from
          the Projects screen before saving.
        </div>
      )}

      <section className="panel">
        <div className="panel__head">
          <div className="panel__name">Workflow behaviour</div>
          <span className="dim">{project?.path}</span>
        </div>
        <div className="form">
          {number('stallThresholdSeconds', 'Stall threshold', 'seconds of silence before a run reads as possibly stalled')}
          {number(
            'semanticLagThresholdSeconds',
            'Semantic lag threshold',
            'seconds of activity with no phase change before the diagram is called out as behind',
          )}
          {number('monitorPort', 'Monitor port', 'port used by `cw monitor` for this project')}
          {toggle('autoGenericRun', 'Open a generic run automatically', 'when a prompt arrives with no run active')}
          {toggle(
            'enforceGates',
            'Enforce gates',
            'deny writes while a controlled run has an unpassed gate or an unanswered checkpoint',
          )}
          <label className="form__row">
            <span className="form__label">Analysis report directory</span>
            <input
              className="input mono"
              value={String(value('analysisReportDir') ?? '')}
              onChange={(e) => set('analysisReportDir', e.target.value)}
            />
          </label>

          <div className="form__actions">
            <button className="btn btn--primary" disabled={!changed.length || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : changed.length ? `Save ${changed.length} change(s)` : 'Saved'}
            </button>
            {changed.length > 0 && (
              <button className="btn" onClick={() => setDraft({})}>
                Discard
              </button>
            )}
            {saved && <span className="dim">written to config.json</span>}
          </div>
          {error && <div className="detail__error">{error}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div className="panel__name">Read-only here</div>
          <span className="dim">changed by the installer, or by editing the file directly</span>
        </div>
        <table className="table table--tight">
          <tbody>
            {Object.entries(config)
              .filter(([key]) => !view.editable.includes(key))
              .map(([key, raw]) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td className="dim mono">
                    {Array.isArray(raw) ? raw.join(', ') : String(raw ?? '—')}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div className="panel__name">Installation health</div>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void fetchDoctor(projectId)
                .then((result) => setChecks(result.checks))
                .catch((failure: Error) => setError(failure.message))
            }
          >
            Run doctor
          </button>
        </div>
        {checks ? (
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
        ) : (
          <p className="dim">Not checked yet.</p>
        )}
      </section>
    </div>
  );
}
