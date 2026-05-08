import type { FunctionRecord } from '@shared/types';
import { FnLogo, StatusDot } from '../icons';

type Props = {
  svc: FunctionRecord;
  selected: boolean;
  onClick: () => void;
};

export function DeploymentCard({ svc, selected, onClick }: Props) {
  const online = svc.status === 'online';
  return (
    <button
      onClick={onClick}
      className={`svc-node ${selected ? 'selected' : ''}`}
      style={{
        position: 'relative',
        textAlign: 'left',
        cursor: 'pointer',
        padding: 16,
        background: 'var(--bg-elev-1)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        transition: 'border-color 120ms var(--ease-out), background 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <FnLogo size={36} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              textDecoration: 'none',
            }}
          >
            {svc.name}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--fg-subtle)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {svc.subdomain}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 12,
          borderTop: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot color={online ? 'var(--ok)' : 'var(--warn)'} />
          <span
            style={{
              fontSize: 12,
              color: online ? 'var(--ok)' : 'var(--warn)',
              textTransform: 'capitalize',
              fontWeight: 500,
            }}
          >
            {svc.status}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          1 replica
        </span>
      </div>
    </button>
  );
}
