import { useEffect } from 'react';
import { fetchRunDetail, fetchSnapshot, subscribe } from './api';
import { WorkflowGraph } from './graph/WorkflowGraph';
import { Header } from './panels/Header';
import { NodeDetail } from './panels/NodeDetail';
import { RunList } from './panels/RunList';
import { useMonitor } from './store';

export default function App() {
  const {
    snapshot,
    detail,
    selectedRunId,
    selectedNodeId,
    connection,
    now,
    error,
    setSnapshot,
    setDetail,
    selectRun,
    selectNode,
    setConnection,
    setError,
    tick,
  } = useMonitor();

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

  const run = snapshot?.runs.find((r) => r.runId === selectedRunId) ?? null;

  // Refetch the heavy per-run payload (events, artifacts) only when it changed.
  useEffect(() => {
    if (!run) return;
    if (detail?.run.runId === run.runId && detail.run.updatedAt === run.updatedAt) return;
    let cancelled = false;
    fetchRunDetail(run.runId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [run?.runId, run?.updatedAt, detail?.run.runId, detail?.run.updatedAt, setDetail, run]);

  if (!snapshot) {
    return (
      <div className="boot">
        <div>Connecting to the monitor server…</div>
        {error && <div className="boot__error">{error}</div>}
      </div>
    );
  }

  const workflow = run ? snapshot.workflows.find((w) => w.id === run.workflow) : undefined;

  return (
    <div className="app">
      <Header snapshot={snapshot} run={run} connection={connection} nowMs={now} />

      <div className="app__body">
        <RunList snapshot={snapshot} selectedRunId={selectedRunId} onSelect={selectRun} nowMs={now} />

        <main className="canvas">
          {run && workflow ? (
            <WorkflowGraph
              workflow={workflow}
              run={run}
              nowMs={now}
              stallThresholdSeconds={snapshot.stallThresholdSeconds}
              selectedNodeId={selectedNodeId}
              onSelectNode={selectNode}
            />
          ) : (
            <div className="empty empty--canvas">
              {snapshot.runs.length
                ? 'Select a run.'
                : `No runs in ${snapshot.runtimeDir}. Start one with /work (or choose /quick-fix, /feature-change, /bug-fix).`}
            </div>
          )}
        </main>

        {run && workflow && selectedNodeId && (
          <NodeDetail
            workflow={workflow}
            run={run}
            detail={detail}
            nodeId={selectedNodeId}
            nowMs={now}
            stallThresholdSeconds={snapshot.stallThresholdSeconds}
            onClose={() => selectNode(null)}
          />
        )}
      </div>
    </div>
  );
}
