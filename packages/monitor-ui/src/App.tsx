import { useEffect } from 'react';
import { fetchSnapshot, subscribe } from './api';
import { nextSelectedRunId } from './graphModel';
import { href, navigate, useRoute } from './router';
import { Dashboard } from './screens/Dashboard';
import { RunDetail } from './screens/RunDetail';
import { RunExplorer } from './screens/RunExplorer';
import { Skills } from './screens/Skills';
import { LiveRail } from './panels/LiveRail';
import { useMonitor } from './store';

export default function App() {
  const { snapshot, connection, now, error, setSnapshot, setConnection, setError, tick } = useMonitor();
  const route = useRoute();

  // Live updates: SSE for state, a local 1s tick so "5s ago" and STALE move
  // even when the server has nothing new to send.
  useEffect(() => {
    fetchSnapshot().then(setSnapshot).catch((e: Error) => setError(e.message));
    const stop = subscribe({
      onSnapshot: setSnapshot,
      onOpen: () => setConnection('live'),
      onError: () => setConnection('offline'),
    });
    const timer = window.setInterval(tick, 1000);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [setSnapshot, setConnection, setError, tick]);

  // An empty hash lands on the run the user is most likely to want: the one
  // Claude is working in right now.
  useEffect(() => {
    if (route.name !== 'dashboard' || window.location.hash) return;
    if (!snapshot) return;
    const target = nextSelectedRunId(null, snapshot.runs, snapshot.currentRunId);
    if (target) navigate({ name: 'run', runId: target });
  }, [route.name, snapshot]);

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot__pulse" />
        <div>Connecting to the monitor server…</div>
        {error && <div className="boot__error">{error}</div>}
      </div>
    );
  }

  const waiting = snapshot.runs.reduce((sum, run) => sum + (run.missionSummary?.pendingCheckpoints ?? 0), 0);
  const active = snapshot.runs.filter((run) => run.derivedStatus === 'RUNNING').length;
  const withRail = route.name === 'run' || route.name === 'runs';

  const tab = (name: 'dashboard' | 'runs' | 'skills', label: string, badge?: number) => (
    <a
      className={`nav__tab${route.name === name || (name === 'runs' && route.name === 'run') ? ' is-active' : ''}`}
      href={href(name === 'runs' ? { name: 'runs' } : name === 'skills' ? { name: 'skills' } : { name: 'dashboard' })}
    >
      {label}
      {badge ? <span className="chip chip--count">{badge}</span> : null}
    </a>
  );

  return (
    <div className="app">
      <nav className="nav">
        <a className="nav__brand" href={href({ name: 'dashboard' })}>
          <span className="nav__mark" />
          Workflow Kit
        </a>
        <div className="nav__tabs">
          {tab('dashboard', 'Dashboard')}
          {tab('runs', 'Runs', waiting)}
          {tab('skills', 'Skills')}
        </div>
        <div className="nav__right">
          {active > 0 && (
            <span className="header__stat" title="Runs currently executing">
              <span className="dot claude-active" />
              {active} active
            </span>
          )}
          {snapshot.policyHealth && snapshot.policyHealth.status !== 'OK' && (
            <span
              className={`pill pill--policy_${snapshot.policyHealth.status.toLowerCase()}`}
              title={
                snapshot.policyHealth.status === 'DEGRADED'
                  ? `The PreToolUse gate policy failed and is failing open: ${snapshot.policyHealth.lastError ?? ''}`
                  : 'Gate enforcement is switched off in config.json (enforceGates=false).'
              }
            >
              policy {snapshot.policyHealth.status.toLowerCase()}
            </span>
          )}
          <span className={`conn conn--${connection}`} title={`Monitor stream: ${connection}`}>
            <span className={`dot ${connection === 'live' ? 'claude-active' : 'claude-idle'}`} />
            {connection}
          </span>
        </div>
      </nav>

      <div className={`app__body${withRail ? ' app__body--rail' : ''}`}>
        {withRail && <LiveRail snapshot={snapshot} nowMs={now} activeRunId={route.name === 'run' ? route.runId : null} />}

        <main className="screen">
          {route.name === 'run' ? (
            <RunDetail runId={route.runId} snapshot={snapshot} nowMs={now} />
          ) : route.name === 'runs' ? (
            <RunExplorer snapshot={snapshot} nowMs={now} />
          ) : route.name === 'skills' ? (
            <Skills snapshot={snapshot} />
          ) : (
            <Dashboard snapshot={snapshot} nowMs={now} />
          )}
        </main>
      </div>
    </div>
  );
}
