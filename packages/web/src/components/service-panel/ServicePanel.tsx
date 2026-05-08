// Service detail — full-page view with breadcrumb, animated tab underline, 5 tabs.

import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { FunctionRecord, ServiceStatus, Session } from '@shared/types';
import { api } from '../../lib/api';
import { FnLogo, Icon } from '../icons';
import { DeploymentsTab } from './tabs/DeploymentsTab';
import { SourceCodeTab } from './tabs/SourceCodeTab';
import { HistoryTab } from './tabs/HistoryTab';
import { VariablesTab } from './tabs/VariablesTab';
import { MetricsTab } from './tabs/MetricsTab';
import { SettingsTab } from './tabs/SettingsTab';

const TABS = ['Deployments', 'Source Code', 'History', 'Variables', 'Metrics', 'Settings'] as const;
type TabName = (typeof TABS)[number];

const STATUS_TONE: Record<ServiceStatus, { color: string; label: string }> = {
  online:   { color: 'var(--ok)',              label: 'Online' },
  pending:  { color: 'var(--warn, #f5a524)',   label: 'Deploying' },
  degraded: { color: 'var(--warn, #f5a524)',   label: 'Degraded' },
  offline:  { color: 'var(--err, #e5484d)',    label: 'Failed' },
  idle:     { color: 'var(--fg-subtle, #777)', label: 'Not deployed' },
};

type Props = {
  svc: FunctionRecord;
  session: Session;
  onClose: () => void;
  onRedeploy?: (next: FunctionRecord) => void;
  onCloseDeployment?: () => void;
  onDelete?: () => void;
};

export function ServicePanel({
  svc,
  session,
  onClose,
  onRedeploy,
  onCloseDeployment,
  onDelete,
}: Props): ReactElement {
  const [tab, setTab] = useState<TabName>('Deployments');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [underline, setUnderline] = useState({ left: 0, width: 0 });
  const [redeploying, setRedeploying] = useState(false);
  const tone = STATUS_TONE[svc.status] ?? STATUS_TONE.pending;

  const externalUrl = svc.subdomain.startsWith('http')
    ? svc.subdomain
    : `https://${svc.subdomain}`;

  const redeploy = async () => {
    if (redeploying) return;
    setRedeploying(true);
    try {
      // Clone-and-deploy: 1 function = 1 deployment, so this creates a new
      // function from the same source. Parent navigates to the new fn.
      const next = await api.cloneAndDeploy(svc.id);
      onRedeploy?.(next);
    } catch (err) {
      console.error('redeploy failed', err);
    } finally {
      setRedeploying(false);
    }
  };

  useLayoutEffect(() => {
    const el = tabRefs.current[tab];
    if (el) setUnderline({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab]);

  return (
    <div
      className="page-in"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '18px 36px 0',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12.5,
            color: 'var(--fg-muted)',
            marginBottom: 14,
          }}
        >
          <button onClick={onClose} className="btn btn-ghost btn-sm" style={{ padding: '4px 10px', gap: 6 }}>
            <Icon name="arrowLeft" size={12} /> Back
          </button>
          <span style={{ color: 'var(--fg-subtle)' }}>/</span>
          <span style={{ color: 'var(--fg-muted)' }}>Functions</span>
          <span style={{ color: 'var(--fg-subtle)' }}>/</span>
          <span className="mono" style={{ color: 'var(--fg)' }}>{svc.name}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <FnLogo size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              {svc.name}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: tone.color,
                  fontWeight: 500,
                }}
              >
                <span
                  className="status-dot status-dot-online"
                  style={{ background: tone.color }}
                />
                {tone.label}
              </span>
            </h1>
            <div className="mono" style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4 }}>
              {svc.subdomain}
            </div>
          </div>
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-subtle btn-sm"
            style={{ gap: 6, textDecoration: 'none' }}
          >
            <Icon name="external" size={12} /> Open URL
          </a>
          <button
            onClick={redeploy}
            disabled={redeploying}
            className="btn btn-subtle btn-sm"
            style={{ gap: 6, opacity: redeploying ? 0.6 : 1 }}
          >
            <Icon name={redeploying ? 'box' : 'play'} size={11} />
            {redeploying ? 'Redeploying…' : 'Redeploy'}
          </button>
        </div>

        <div style={{ position: 'relative', display: 'flex', gap: 30 }}>
          {TABS.map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              onClick={() => setTab(t)}
              style={{
                padding: '10px 0',
                border: 'none',
                background: 'transparent',
                color: tab === t ? 'var(--fg)' : 'var(--fg-muted)',
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: '-0.005em',
                transition: 'color 160ms',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
          <div className="tab-underline" style={underline} />
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '32px 36px 80px' }}>
        <div key={tab} className="fade-up" style={{ maxWidth: 1100, margin: '0 auto' }}>
          {tab === 'Deployments' && <DeploymentsTab svc={svc} />}
          {tab === 'Source Code' && <SourceCodeTab svc={svc} />}
          {tab === 'History' && <HistoryTab svc={svc} />}
          {tab === 'Variables' && <VariablesTab svc={svc} />}
          {tab === 'Metrics' && <MetricsTab />}
          {tab === 'Settings' && (
            <SettingsTab
              svc={svc}
              session={session}
              onCloseDeployment={onCloseDeployment}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
