import { useEffect } from 'react';
import { fetchApp, fetchSnapshot, markProjectOpened, subscribe } from './api';
import { nextSelectedRunId } from './graphModel';
import { ProjectProvider } from './project';
import { href, navigate, routeProjectId, switchProject, useRoute, type Route } from './router';
import { Dashboard } from './screens/Dashboard';
import { Launch } from './screens/Launch';
import { Projects } from './screens/Projects';
import { RunDetail } from './screens/RunDetail';
import { RunExplorer } from './screens/RunExplorer';
import { Settings } from './screens/Settings';
import { Skills } from './screens/Skills';
import { LiveRail } from './panels/LiveRail';
import { useMonitor } from './store';

export default function App() {
  const {
    app,
    projects,
    lastProjectId,
    snapshot,
    connection,
    now,
    error,
    setApp,
    setWorkspace,
    setSnapshot,
    clearSnapshot,
    setConnection,
    setError,
    tick,
  } = useMonitor();
  const route = useRoute();
  const projectId = routeProjectId(route);

  // What this build can do, read once. Without it the UI cannot know whether to
  // offer installing or launching at all.
  useEffect(() => {
    fetchApp()
      .then(setApp)
      .catch((e: Error) => setError(e.message));
  }, [setApp, setError]);

  // One stream for the whole app: workspace rows always, plus snapshots of the
  // project being viewed. Re-subscribing on a project switch is what stops the
  // previous project's frames from arriving after the user has moved on.
  useEffect(() => {
    clearSnapshot();
    if (projectId) {
      fetchSnapshot(projectId)
        .then(setSnapshot)
        .catch((e: Error) => setError(e.message));
      void markProjectOpened(projectId).catch(() => undefined);
    }
    const stop = subscribe(projectId, {
      onSnapshot: setSnapshot,
      onWorkspace: setWorkspace,
      onOpen: () => setConnection('live'),
      onError: () => setConnection('offline'),
    });
    const timer = window.setInterval(tick, 1000);
    return () => {
      stop();
      window.clearInterval(timer);
    };
  }, [projectId, clearSnapshot, setSnapshot, setWorkspace, setConnection, setError, tick]);

  // An empty hash lands on the project the user was last in; a workspace with
  // exactly one project skips the chooser entirely.
  useEffect(() => {
    if (route.name !== 'projects' || window.location.hash === '#/projects') return;
    if (!projects.length) return;
    const target = projects.find((p) => p.id === lastProjectId) ?? projects[0]!;
    navigate({ name: 'dashboard', projectId: target.id });
  }, [route.name, projects, lastProjectId]);

  // The run Claude is working in right now is the one worth opening first.
  useEffect(() => {
    if (route.name !== 'dashboard' || !snapshot || !projectId) return;
    if (!window.location.hash.endsWith('/dashboard')) return;
    const target = nextSelectedRunId(null, snapshot.runs, snapshot.currentRunId);
    if (target) navigate({ name: 'run', projectId, runId: target });
  }, [route.name, snapshot, projectId]);

  if (route.name === 'projects') {
    return (
      <div className="app">
        <Nav route={route} />
        <div className="app__body">
          <main className="screen">
            {error && <div className="detail__error screen__pad">{error}</div>}
            <Projects />
          </main>
        </div>
      </div>
    );
  }

  const known = projects.find((p) => p.id === projectId);
  if (projects.length && !known) {
    return (
      <div className="app">
        <Nav route={route} />
        <div className="app__body">
          <main className="screen screen__pad">
            <div className="detail__error">
              This link points at a project that is not registered any more.
            </div>
            <a className="btn" href={href({ name: 'projects' })}>
              Back to projects
            </a>
          </main>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot__pulse" />
        <div>{known ? `Opening ${known.name}…` : 'Connecting to the app server…'}</div>
        {error && <div className="boot__error">{error}</div>}
      </div>
    );
  }

  const withRail = route.name === 'run' || route.name === 'runs';

  return (
    <ProjectProvider projectId={projectId!}>
      <div className="app">
        <Nav route={route} />
        <div className={`app__body${withRail ? ' app__body--rail' : ''}`}>
          {withRail && (
            <LiveRail
              snapshot={snapshot}
              nowMs={now}
              activeRunId={route.name === 'run' ? route.runId : null}
            />
          )}
          <main className="screen">
            {route.name === 'run' ? (
              <RunDetail runId={route.runId} snapshot={snapshot} nowMs={now} />
            ) : route.name === 'runs' ? (
              <RunExplorer snapshot={snapshot} nowMs={now} />
            ) : route.name === 'skills' ? (
              <Skills snapshot={snapshot} />
            ) : route.name === 'launch' ? (
              <Launch snapshot={snapshot} nowMs={now} />
            ) : route.name === 'settings' ? (
              <Settings />
            ) : (
              <Dashboard snapshot={snapshot} nowMs={now} />
            )}
          </main>
        </div>
      </div>
    </ProjectProvider>
  );
}

/** Brand, project switcher, screen tabs and the connection state. */
function Nav({ route }: { route: Route }) {
  const { app, projects, snapshot, connection } = useMonitor();
  const projectId = routeProjectId(route);
  const current = projects.find((p) => p.id === projectId) ?? null;

  const waiting = snapshot
    ? snapshot.runs.reduce((sum, run) => sum + (run.missionSummary?.pendingCheckpoints ?? 0), 0)
    : (current?.pendingCheckpoints ?? 0);
  const active = snapshot
    ? snapshot.runs.filter((run) => run.derivedStatus === 'RUNNING').length
    : (current?.activeRuns ?? 0);

  const tab = (name: 'dashboard' | 'runs' | 'skills' | 'launch' | 'settings', label: string, badge?: number) => {
    if (!projectId) return null;
    const isActive = route.name === name || (name === 'runs' && route.name === 'run');
    return (
      <a className={`nav__tab${isActive ? ' is-active' : ''}`} href={href({ name, projectId })}>
        {label}
        {badge ? <span className="chip chip--count">{badge}</span> : null}
      </a>
    );
  };

  return (
    <nav className="nav">
      <a className="nav__brand" href={href({ name: 'projects' })}>
        <span className="nav__mark" />
        Workflow Kit
      </a>

      <select
        className="nav__project"
        value={projectId ?? ''}
        onChange={(event) => {
          const next = event.target.value;
          navigate(next ? switchProject(route, next) : { name: 'projects' });
        }}
        title={current?.path ?? 'Choose a project'}
      >
        {!projectId && <option value="">Projects…</option>}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
            {project.pendingCheckpoints ? ` (${project.pendingCheckpoints} waiting)` : ''}
          </option>
        ))}
        <option value="">Manage projects…</option>
      </select>

      <div className="nav__tabs">
        {tab('dashboard', 'Dashboard')}
        {tab('runs', 'Runs', waiting)}
        {tab('launch', 'Launch')}
        {tab('skills', 'Skills')}
        {tab('settings', 'Settings')}
      </div>

      <div className="nav__right">
        {active > 0 && (
          <span className="header__stat" title="Runs currently executing">
            <span className="dot claude-active" />
            {active} active
          </span>
        )}
        {app && !app.capabilities.launcher && (
          <span className="pill pill--warn" title={`Claude Code is not runnable: ${app.claude.detail}`}>
            no claude
          </span>
        )}
        {snapshot?.policyHealth && snapshot.policyHealth.status !== 'OK' && (
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
  );
}
