import { useState } from 'react';
import type { FunctionRecord } from '@shared/types';
import { Icon } from '../../icons';

export function VariablesTab({ svc }: { svc: FunctionRecord }) {
  const [showInjected, setShowInjected] = useState(false);

  const injected: [string, string][] = [
    ['PORT', '3000'],
    ['AKASH_SERVICE_NAME', svc.name],
    ['AKASH_PUBLIC_URL', `https://${svc.subdomain}`],
    ['AKASH_REGION', 'us-west'],
    ['AKASH_REPLICA_INDEX', '0'],
    ['AKASH_DEPLOYMENT_ID', 'dep_8f3a...c102'],
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 18,
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Service variables
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm">
            <Icon name="arrowRight" size={12} style={{ transform: 'rotate(90deg)' }} /> Shared variable
          </button>
          <button className="btn btn-ghost btn-sm">
            <span className="mono" style={{ fontSize: 11 }}>{'{ }'}</span> Raw editor
          </button>
          <button className="btn btn-primary btn-sm">
            <Icon name="plus" size={12} color="#0A0A0F" /> New variable
          </button>
        </div>
      </div>

      <div className="empty-state">
        <Icon name="cube" size={20} color="var(--fg-subtle)" />
        <div style={{ fontSize: 14, color: 'var(--fg)', marginTop: 4 }}>
          No environment variables yet.
        </div>
        <div style={{ fontSize: 13, maxWidth: 380 }}>
          Akash injects 6 variables automatically — expand below to see them.
        </div>
      </div>

      <button
        onClick={() => setShowInjected((v) => !v)}
        style={{
          marginTop: 18,
          width: '100%',
          textAlign: 'left',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'var(--fg)',
          cursor: 'pointer',
        }}
      >
        <Icon name={showInjected ? 'chevronDown' : 'chevronRight'} size={14} color="var(--fg-muted)" />
        <span style={{ fontSize: 13 }}>6 variables added by Akash</span>
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--fg-subtle)', marginLeft: 'auto' }}
        >
          PORT · AKASH_SERVICE_NAME · AKASH_PUBLIC_URL · …
        </span>
      </button>

      {showInjected && (
        <div
          className="fade-up"
          style={{
            marginTop: 8,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-elev-2)',
          }}
        >
          {injected.map(([k, v], i) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr 24px',
                padding: '10px 14px',
                borderTop: i ? '1px solid var(--line)' : 'none',
                alignItems: 'center',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ color: 'var(--fg)' }}>{k}</span>
              <span className="mono" style={{ color: 'var(--fg-muted)' }}>{v}</span>
              <Icon name="lock" size={12} color="var(--fg-subtle)" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
