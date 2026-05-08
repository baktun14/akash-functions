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

  // Delete = close lease (if any) + tombstone function.
  const handleDelete = async () => {
    if (!id) return;
    if (!confirm('Close this deployment? This will tear it down on Akash and remove the function.')) {
      return;
    }
    try {
      await api.remove(id);
      setLocal((cur) => cur.filter((s) => s.id !== id));
      navigate('/functions');
    } catch (err) {
      alert(`Failed to close deployment: ${(err as Error).message}`);
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
      onDelete={handleDelete}
    />
  );
}
