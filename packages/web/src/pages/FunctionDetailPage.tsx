import { type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { FunctionRecord } from '@shared/types';
import { ServicePanel } from '../components/service-panel/ServicePanel';
import { useLayout } from '../App';
import { api } from '../lib/api';

export function FunctionDetailPage(): ReactElement {
  const { id } = useParams<{ id: string }>();
  const { services, session, setLocal, refresh } = useLayout();
  const navigate = useNavigate();

  const svc = services.find((s) => s.id === id);

  // Redeploy = clone to a new function. Push it into local state so the new
  // detail page renders before the next list-poll tick lands.
  const handleRedeploy = (next: FunctionRecord) => {
    setLocal((cur) => [next, ...cur.filter((s) => s.id !== next.id)]);
    refresh().catch(() => undefined);
    navigate(`/functions/${next.id}`);
  };

  // Close deployment = tear down the Akash lease but keep the function record
  // and its version history. After this the user can Save & Deploy onto the
  // current runner image (e.g. to migrate off a 1.x pod onto 2.x hot-reload).
  const handleCloseDeployment = async () => {
    if (!id) return;
    if (!confirm('Close this deployment on Akash? The function and its code stay; only the running pod is torn down.')) {
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
      navigate('/functions');
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

  return (
    <ServicePanel
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
