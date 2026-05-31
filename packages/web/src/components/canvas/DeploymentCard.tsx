import { Link } from 'react-router-dom';
import type { FunctionRecord, ServiceStatus } from '@shared/types';
import { ensureHttpScheme } from '../../lib/url';
import { jobTone } from '../run-panel/runStatus';
import { FnLogo, StatusDot } from '../icons';

type Props = {
  svc: FunctionRecord;
};

const STATUS_TONE: Record<ServiceStatus, { color: string; label: string }> = {
  online:   { color: 'var(--ok)',                label: 'Online' },
  pending:  { color: 'var(--warn, #f5a524)',     label: 'Deploying' },
  waiting:  { color: 'var(--warn, #f5a524)',     label: 'Waiting for capacity' },
  degraded: { color: 'var(--warn, #f5a524)',     label: 'Degraded' },
  offline:  { color: 'var(--err, #e5484d)',      label: 'Failed' },
  idle:     { color: 'var(--fg-subtle, #777)',   label: 'Not deployed' },
};

export function DeploymentCard({ svc }: Props) {
  const isJob = svc.kind === 'python-job';
  const tone = isJob ? jobTone(svc) : STATUS_TONE[svc.status];
  // Suppress the ingress URL for python-jobs — runs have no public endpoint.
  const url = !isJob && svc.ingressUrl ? ensureHttpScheme(svc.ingressUrl) : null;

  return (
    <Link
      to={`/functions/${svc.id}`}
      className="svc-node"
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
        textDecoration: 'none',
        color: 'inherit',
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
            }}
          >
            {svc.name}
          </div>
          {url && (
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
              {url}
            </div>
          )}
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
          <StatusDot color={tone.color} />
          <span
            style={{
              fontSize: 12,
              color: tone.color,
              fontWeight: 500,
            }}
          >
            {tone.label}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          {isJob ? 'GPU run' : '1 replica'}
        </span>
      </div>
    </Link>
  );
}
