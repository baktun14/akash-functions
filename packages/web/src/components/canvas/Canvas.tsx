// Functions list view — grid of DeploymentCard. Cards are <Link> to detail.

import type { FunctionRecord } from '@shared/types';
import { DeploymentCard } from './DeploymentCard';

type Props = {
  services: FunctionRecord[];
};

export function Canvas({ services }: Props) {
  const activeCount = services.filter((s) => s.status === 'online' || s.status === 'pending').length;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg)',
        overflow: 'auto',
        padding: '28px 32px 80px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          maxWidth: 1280,
          margin: '0 auto 20px',
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em' }}>Functions</div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>
            {activeCount} active · production
          </div>
        </div>
      </div>

      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 14,
        }}
      >
        {services.map((s) => (
          <DeploymentCard key={s.id} svc={s} />
        ))}
      </div>
    </div>
  );
}
