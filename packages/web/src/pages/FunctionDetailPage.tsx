import { type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { FunctionRecord, RunRecord } from '@shared/types';
import { ServicePanel } from '../components/service-panel/ServicePanel';
import { RunPanel } from '../components/run-panel/RunPanel';
import { applyRerun } from '../components/run-panel/runStatus';
import { useLayout } from '../App';
import { api } from '../lib/api';
import { sessionDeploys } from '../lib/sessionDeploys';

export function FunctionDetailPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const { services, session, setLocal, refresh, versionRev } = useLayout();
  const navigate = useNavigate();

  const svc = services.find((s) => s.id === id);

  // Redeploy = clone to a new function. Push it into local state so the new
  // detail page renders before the next list-poll tick lands.
  const handleRedeploy = (next: FunctionRecord) => {
    setLocal((cur) => [next, ...cur.filter((s) => s.id !== next.id)]);
    sessionDeploys.mark(next.id);
    refresh().catch(() => undefined);
    navigate(`/functions/${next.id}`);
  };

  // "Run again" from the RunPanel: optimistically reflect the new run on the
  // shared list row (clear the old outcome, mark it in-flight) so the Jobs list
  // updates immediately, then refresh for authoritative state. No navigation —
  // the user stays in the RunPanel watching the new run stream.
  const handleRunStarted = (run: RunRecord) => {
    if (!id) return;
    setLocal((cur) => cur.map((s) => (s.id === id ? applyRerun(s, run) : s)));
    sessionDeploys.mark(id);
    refresh().catch(() => undefined);
  };

  // Close deployment = tear down the Akash lease but keep the function record
  // and its version history. After this the user can Save & Deploy onto the
  // current runner image (e.g. to migrate off a 1.x pod onto 2.x hot-reload).
  const handleCloseDeployment = async () => {
    if (!id) return;
    // A waiting deployment holds no lease yet — stopping it just ends the wait.
    const msg =
      svc?.status === 'waiting'
        ? 'Stop waiting for capacity? No lease has been acquired yet; the function and its code stay.'
        : 'Close this deployment on Akash? The function and its code stay; only the running pod is torn down.';
    if (!confirm(msg)) {
      return;
    }
    try {
      await api.closeDeployment(id);
      setLocal((cur) =>
        cur.map((s) =>
          s.id === id ? { ...s, status: 'idle', latestDeploymentId: undefined } : s
        )
      );
      refresh().catch(() => undefined);
    } catch (err) {
      alert(`Failed to close deployment: ${(err as Error).message}`);
    }
  };

  const handleRename = async (name: string) => {
    if (!id) return;
    const prev = svc;
    if (!prev) return;
    setLocal((cur) => cur.map((s) => (s.id === id ? { ...s, name } : s)));
    try {
      await api.rename(id, name);
      refresh().catch(() => undefined);
    } catch (err) {
      setLocal((cur) => cur.map((s) => (s.id === id ? prev : s)));
      alert(`Failed to rename function: ${(err as Error).message}`);
    }
  };

  // Delete = close lease (if any) + tombstone function. Removes it from the list.
  const handleDelete = async () => {
    if (!id) return;
    if (!confirm('Delete this function? This closes the deployment on Akash and removes the function from your list. Code history is retained server-side.')) {
      return;
    }
    try {
      await api.remove(id);
      setLocal((cur) => cur.filter((s) => s.id !== id));
      sessionDeploys.clear(id);
      navigate(svc?.kind === 'python-job' ? '/jobs' : '/functions');
    } catch (err) {
      alert(`Failed to delete function: ${(err as Error).message}`);
    }
  };

  if (!svc) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 8,
          color: 'var(--fg-muted)',
        }}
      >
        <div className="eyebrow">Loading function…</div>
        <div style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>
          If this persists, the function may not exist.
        </div>
        <button
          onClick={() => navigate('/functions')}
          className="btn btn-subtle btn-sm"
          style={{ marginTop: 12 }}
        >
          Back to functions
        </button>
      </div>
    );
  }

  // Python-job functions are a distinct product: ephemeral GPU runs with live
  // log streaming and an exit code — RunPanel, not ServicePanel (D6). Keyed on
  // svc.id like ServicePanel so tab state resets on function change.
  if (svc.kind === 'python-job') {
    return (
      <RunPanel
        key={svc.id}
        svc={svc}
        session={session}
        reloadSignal={versionRev}
        onClose={() => navigate('/jobs')}
        onCloseDeployment={handleCloseDeployment}
        onDelete={handleDelete}
        onRename={handleRename}
        onRunStarted={handleRunStarted}
      />
    );
  }

  return (
    <ServicePanel
      // Remount on function change so the in-panel tab state resets to the
      // default (Deployments). Without this, navigating between functions
      // (create, redeploy, list-click) leaves the previously-active tab
      // selected on the new function — confusing because the user just landed
      // on a different deployment and expects to see its status.
      key={svc.id}
      svc={svc}
      session={session}
      onClose={() => navigate('/functions')}
      onRedeploy={handleRedeploy}
      onCloseDeployment={handleCloseDeployment}
      onDelete={handleDelete}
      onRename={handleRename}
    />
  );
}
