// Service detail — full-page view with breadcrumb, animated tab underline, 5 tabs.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { FunctionRecord, ServiceStatus, Session } from '@shared/types';
import { api } from '../../lib/api';
import { useReachable } from '../../lib/useReachable';
import { sessionDeploys } from '../../lib/sessionDeploys';
import { ensureHttpScheme } from '../../lib/url';
import { FnLogo, Icon } from '../icons';
import { AsyncButton } from '../ui/AsyncButton';
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
  onRename?: (name: string) => void | Promise<void>;
};

export function ServicePanel({
  svc,
  session,
  onClose,
  onRedeploy,
  onCloseDeployment,
  onDelete,
  onRename,
}: Props): ReactElement {
  const [tab, setTab] = useState<TabName>('Deployments');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [underline, setUnderline] = useState({ left: 0, width: 0 });
  const [redeploying, setRedeploying] = useState(false);
  const [editingName, setEditingName] = useState(svc.name);
  const [renaming, setRenaming] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Akash flips state='live' before the provider's nginx is actually serving,
  // so until the server-side probe says reachable we keep the function in the
  // "Deploying" tone — otherwise the pill goes green while clicking the URL
  // still 503s. Only probe when a deploy was initiated this session; for
  // already-live functions loaded from the server we trust `svc.status`.
  const ingressReachable = useReachable(svc.id, svc.status === 'online' && sessionDeploys.was(svc.id));
  const effectiveStatus: ServiceStatus =
    svc.status === 'online' && !ingressReachable ? 'pending' : svc.status;
  const tone = STATUS_TONE[effectiveStatus] ?? STATUS_TONE.pending;

  useEffect(() => {
    setEditingName(svc.name);
  }, [svc.name]);

  const commitName = async () => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      setEditingName(svc.name);
      return;
    }
    if (trimmed === svc.name) {
      setEditingName(svc.name);
      return;
    }
    if (!onRename || renaming) return;
    setRenaming(true);
    try {
      await onRename(trimmed);
    } finally {
      setRenaming(false);
    }
  };

  const cancelName = () => {
    setEditingName(svc.name);
    nameInputRef.current?.blur();
  };

  const externalUrl = ensureHttpScheme(svc.subdomain);

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
        // No explicit zIndex: a non-auto value here would make this element a
        // stacking context, which would trap any descendant .modal-shell at
        // this layer and let the TopBar (zIndex 10) paint above the scrim.
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
              <input
                ref={nameInputRef}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    nameInputRef.current?.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelName();
                  }
                }}
                maxLength={60}
                spellCheck={false}
                aria-label="Function name"
                disabled={!onRename || renaming}
                size={Math.max(editingName.length, 8)}
                className="service-name-input"
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  background: 'transparent',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  padding: '2px 6px',
                  margin: '-2px -6px',
                  outline: 'none',
                  fontFamily: 'inherit',
                  minWidth: 0,
                  opacity: renaming ? 0.6 : 1,
                }}
              />
              {renaming && (
                <Icon
                  name="spinner"
                  size={14}
                  className="spin"
                  color="var(--fg-muted)"
                />
              )}
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
          </div>
          {effectiveStatus === 'online' && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-subtle btn-sm"
              style={{ gap: 6, textDecoration: 'none' }}
            >
              <Icon name="external" size={12} /> Open URL
            </a>
          )}
          {effectiveStatus !== 'pending' && (
            <AsyncButton
              onClick={redeploy}
              loading={redeploying}
              loadingText="Redeploying…"
              className="btn btn-subtle btn-sm"
              style={{ gap: 6, opacity: redeploying ? 0.6 : 1 }}
            >
              <Icon name="play" size={11} />
              Redeploy
            </AsyncButton>
          )}
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
