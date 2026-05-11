// TopBar — 56px, Beta pill, theme toggle, account popover, Akash Agent.

import { useState, type ReactElement } from 'react';
import type { Session } from '@shared/types';
import { Avatar, Icon } from '../icons';
import { useTheme } from '../../lib/theme';

type Props = {
  session: Session;
  expired: boolean;
  onDisconnect: () => void;
  onReconnect: () => void;
  onOpenAgent: () => void;
};

export function TopBar({
  session,
  expired,
  onDisconnect,
  onReconnect,
  onOpenAgent,
}: Props): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const { resolved, toggle } = useTheme();

  return (
    <div
      style={{
        height: 56,
        background: 'var(--bg)',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        position: 'relative',
        zIndex: 10,
        gap: 14,
      }}
    >
      <span
        className="pill"
        style={{
          padding: '3px 9px',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-muted)',
          borderColor: 'var(--line-strong)',
          background: 'transparent',
          fontWeight: 500,
        }}
      >
        Beta
      </span>

      <div style={{ flex: 1 }} />

      <button
        type="button"
        onClick={toggle}
        title={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        style={iconBtnStyle()}
      >
        <Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={15} />
      </button>

      {/* Account chip + popover */}
      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="pill"
          style={{
            padding: '4px 10px 4px 4px',
            gap: 8,
            borderColor: expired ? 'rgba(255,41,3,0.5)' : 'var(--line-strong)',
            background: 'var(--bg-elev-1)',
          }}
        >
          <Avatar initials={(session.email?.[0] || 'M').toUpperCase()} size={22} />
          {expired ? (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: 'var(--accent)',
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--accent-soft)' }}>Expired</span>
            </>
          ) : (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: 'var(--ok)',
                }}
              />
              <span style={{ fontSize: 12 }}>Connected</span>
            </>
          )}
          <Icon name="chevronDown" size={12} color="var(--fg-subtle)" />
        </button>

        {menuOpen && (
          <>
            <div
              onClick={() => setMenuOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 55 }}
            />
            <div className="popover">
              <div style={{ padding: '10px 10px 14px' }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>Console session</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{session.email}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  Workspace:{' '}
                  <span className="mono" style={{ color: 'var(--fg)' }}>{session.workspace}</span>
                </div>
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: 'var(--bg-elev-2)',
                    border: '1px solid var(--line)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                    sk_console_…{(session.key || '').slice(-4) || 'demo'}
                  </span>
                  {session.sample ? (
                    <span
                      className="pill"
                      style={{ padding: '2px 8px', fontSize: 10, borderColor: 'var(--line-strong)' }}
                    >
                      Sample
                    </span>
                  ) : (
                    <span className="pill pill-ok" style={{ padding: '2px 8px', fontSize: 10 }}>
                      Active
                    </span>
                  )}
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--line)', margin: '4px 0' }} />
              <div
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onReconnect();
                }}
              >
                <Icon name="refresh" size={14} /> Rotate key…
              </div>
              <div
                className="menu-item danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDisconnect();
                }}
              >
                <Icon name="x" size={14} /> Disconnect
              </div>
            </div>
          </>
        )}
      </div>

      <button
        onClick={onOpenAgent}
        className="btn btn-ghost btn-sm"
        style={{ gap: 6, borderRadius: 9999 }}
      >
        <Icon name="sparkles" size={13} color="var(--accent)" />
        <span>Akash Agent</span>
      </button>
    </div>
  );
}

function iconBtnStyle() {
  return {
    position: 'relative' as const,
    width: 32,
    height: 32,
    borderRadius: 9,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--fg-subtle)',
    border: '1px solid transparent',
    background: 'transparent',
    transition: 'background 120ms var(--ease-out), color 120ms',
  };
}

