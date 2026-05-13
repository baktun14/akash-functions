import { useEffect, useState } from 'react';
import type {
  FunctionRecord,
  FunctionVersionDetail,
  Session,
} from '@shared/types';
import { Icon } from '../../icons';
import { api } from '../../../lib/api';

type Props = {
  svc: FunctionRecord;
  session: Session;
  onCloseDeployment?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
};

// Formats the version's stored size strings for display: "512Mi" / "512 Mi"
// / "8GI" → "512 MiB" / "8 GiB". Tolerates whitespace and case variation
// because the preset CodeSamples store display-style "512 Mi" while the
// custom-resources form stores normalized "512Mi" — both end up in the DB.
function formatSize(value: string): string {
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt])i$/i);
  if (!m) return value;
  return `${m[1]} ${m[2]!.toUpperCase()}iB`;
}

function formatGpu(gpu: FunctionVersionDetail['resources']['gpu']): string {
  if (!gpu) return 'none';
  const count = gpu.units && gpu.units > 1 ? `${gpu.units}× ` : '';
  return `${count}${gpu.vendor} ${gpu.model}`;
}

export function SettingsTab({ svc, session, onCloseDeployment, onDelete }: Props) {
  const [pending, setPending] = useState<'close' | 'delete' | null>(null);
  const [version, setVersion] = useState<FunctionVersionDetail | null>(null);
  const hasActiveDeployment = svc.status === 'online' || svc.status === 'pending';

  useEffect(() => {
    let cancelled = false;
    api.getLatestVersion(svc.id).then(
      (v) => {
        if (!cancelled) setVersion(v);
      },
      // The version is best-effort — failing here just falls back to the
      // placeholders ("—"), the rest of Settings still renders.
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [svc.id]);

  const cpu = version?.resources.cpu;
  const memory = version?.resources.memory;
  const storage = version?.resources.storage;
  const gpu = version?.resources.gpu;
  const cpuLabel = cpu ? `${parseFloat(cpu) || cpu}` : '—';
  const memoryLabel = memory ? formatSize(memory) : '—';
  const storageLabel = storage ? formatSize(storage) : '—';
  const gpuLabel = version ? formatGpu(gpu) : '—';

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
          <div className="mono" style={{ fontSize: 12.5 }}>{svc.image}</div>
        </div>
      </Section>

      <Section icon="network" title="Networking">
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 10 }}>
          Access your application over HTTP with the following domain.
        </div>
        <div
          className="card"
          style={{
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--bg-elev-2)',
          }}
        >
          <Icon name="globe" size={13} color="var(--fg-muted)" />
          <span className="mono" style={{ fontSize: 12.5 }}>{svc.subdomain}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => navigator.clipboard?.writeText(svc.subdomain).catch(() => undefined)}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer' }}
            title="Copy URL"
          >
            <Icon name="copy" size={12} />
          </button>
        </div>
      </Section>

      <Section icon="layers" title="Scale">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Kv label="vCPU per replica" value={cpuLabel} mono />
          <Kv label="Memory" value={memoryLabel} mono />
          <Kv label="Storage" value={storageLabel} mono />
          <Kv label="GPU" value={gpuLabel} mono />
        </div>
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
