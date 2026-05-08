import { useState } from 'react';
import type { FunctionRecord, Session } from '@shared/types';
import { Icon } from '../../icons';
import { Toggle } from '../../ui/Toggle';

type Props = {
  svc: FunctionRecord;
  session: Session;
  onCloseDeployment?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
};

export function SettingsTab({ svc, session, onCloseDeployment, onDelete }: Props) {
  const [pending, setPending] = useState<'close' | 'delete' | null>(null);
  const hasActiveDeployment = svc.status === 'online' || svc.status === 'pending';

  const runWithLock = (kind: 'close' | 'delete', fn: () => void | Promise<void>) => async () => {
    if (pending) return;
    setPending(kind);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  const handleCloseDeployment = onCloseDeployment ? runWithLock('close', onCloseDeployment) : undefined;
  const handleDelete = onDelete ? runWithLock('delete', onDelete) : undefined;
  return (
    <div>
      <input className="input" placeholder="Filter settings..." style={{ marginBottom: 24 }} />

      <Section icon="keys" title="Authorization">
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 12 }}>
          Console API key used to create and update this service.
        </div>
        <div
          className="card"
          style={{
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--bg-elev-2)',
          }}
        >
          <Icon name="lock" size={14} color="var(--fg-muted)" />
          <span className="mono" style={{ fontSize: 12.5 }}>
            sk_console_…{(session.key || 'demo').slice(-4)}
          </span>
          <span className="pill pill-ok" style={{ padding: '2px 8px', fontSize: 10 }}>Active</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Last rotated 6 days ago</span>
          <button className="btn btn-ghost btn-sm">Re-authorize</button>
        </div>
      </Section>

      <Section icon="cube" title="Source">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Source image</div>
        <div
          className="card"
          style={{
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--bg-elev-2)',
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 6,
              background: 'var(--bg-elev-3)',
              border: '1px solid var(--line)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="box" size={13} />
          </span>
          <div>
            <div className="mono" style={{ fontSize: 12.5 }}>{svc.image}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
              Configure auto updates
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)' }}>
            <Icon name="edit" size={13} />
          </button>
          <button className="btn btn-ghost btn-sm">Disconnect</button>
        </div>
      </Section>

      <Section icon="network" title="Networking">
        <div className="eyebrow" style={{ marginBottom: 8 }}>Public networking</div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 10 }}>
          Access your application over HTTP with the following domains.
        </div>
        <div
          className="card"
          style={{
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--bg-elev-2)',
            marginBottom: 10,
          }}
        >
          <Icon name="globe" size={13} color="var(--fg-muted)" />
          <span className="mono" style={{ fontSize: 12.5 }}>{svc.subdomain}</span>
          <div style={{ flex: 1 }} />
          {(['copy', 'bolt', 'edit', 'trash'] as const).map((n) => (
            <button
              key={n}
              style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)' }}
            >
              <Icon name={n} size={12} />
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost btn-sm">
            <Icon name="plus" size={12} /> Custom domain
          </button>
          <button className="btn btn-ghost btn-sm">
            <Icon name="plus" size={12} /> TCP proxy
          </button>
        </div>

        <div className="eyebrow" style={{ marginTop: 22, marginBottom: 8 }}>Private networking</div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          Communicate with this service from within your Akash deployment group.
        </div>
      </Section>

      <Section icon="layers" title="Scale">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Kv label="Replicas" value="1" mono />
          <Kv label="vCPU per replica" value="0.5" mono />
          <Kv label="Memory" value="512 MiB" mono />
          <Kv label="GPU" value="none" mono />
        </div>
      </Section>

      <Section icon="coin" title="Pricing">
        <div className="card" style={{ padding: 14, background: 'var(--bg-elev-2)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <PricingTile
              label="Cost"
              value={
                <>
                  $0.17{' '}
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>/day</span>
                </>
              }
              sub="0.5 vCPU · 512 MiB"
            />
            <PricingTile label="Balance" value={<>$5.04</>} sub="credits remaining" />
            <PricingTile label="Runway" value={<>~30 d</>} sub="at current rate" />
          </div>
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: '1px solid var(--line)',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <button className="btn btn-primary btn-sm">Top up</button>
          </div>
        </div>
      </Section>

      <Section icon="play" title="Deploy">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Kv label="Auto-deploy" value="On push to main" />
          <Kv label="Healthcheck path" value="/api/health" mono />
          <Kv label="Restart policy" value="On failure" />
          <Kv label="Watchtower" value="Enabled" />
        </div>
      </Section>

      <Section icon="flag" title="Feature flags">
        <Toggle label="Persistent storage (beta)" checked={false} />
        <Toggle label="Audited providers only" checked={true} />
        <Toggle label="GPU pool eligible" checked={false} />
      </Section>

      <div className="section-row">
        <span
          className="section-icon"
          style={{ borderColor: 'rgba(255,41,3,0.4)', color: 'var(--accent-soft)' }}
        >
          <Icon name="trash" size={13} />
        </span>
        <div>
          <div className="section-title" style={{ marginBottom: 6, color: 'var(--accent-soft)' }}>
            Danger
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginBottom: 14, maxWidth: 540 }}>
            <strong>Close deployment</strong> tears down the lease on Akash but keeps the
            function record and version history — use this to stop paying for an
            active pod, or to redeploy onto the latest runner image. <strong>Delete
            function</strong> removes the function from your list (the lease is closed
            too).
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={handleCloseDeployment}
              disabled={!!pending || !handleCloseDeployment || !hasActiveDeployment}
              className="btn btn-subtle btn-sm"
              style={{ opacity: pending === 'close' ? 0.6 : 1 }}
              title={
                hasActiveDeployment
                  ? 'Close the Akash lease but keep the function'
                  : 'No active deployment to close'
              }
            >
              {pending === 'close' ? 'Closing…' : 'Close deployment'}
            </button>
            <button
              onClick={handleDelete}
              disabled={!!pending || !handleDelete}
              className="btn btn-danger btn-sm"
              style={{ opacity: pending === 'delete' ? 0.6 : 1 }}
            >
              {pending === 'delete' ? 'Deleting…' : 'Delete function'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="section-row">
      <span className="section-icon">
        <Icon name={icon} size={14} />
      </span>
      <div>
        <div className="section-title" style={{ marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Kv({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 13, color: 'var(--fg)' }}>
        {value}
      </div>
    </div>
  );
}

function PricingTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub: string;
}) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div
        className="mono"
        style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{sub}</div>
    </div>
  );
}
