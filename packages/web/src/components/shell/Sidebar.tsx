// Akash Functions sidebar — 232px, akash·red dot wordmark, Deploy CTA, nav.

import type { ReactElement } from 'react';
import { AkashSign, Icon } from '../icons';

type ViewId = 'deployments' | 'templates' | 'logs' | 'keys' | 'usage' | 'docs' | 'support';

type NavItem = { id: ViewId; label: string; icon: string };

const MAIN: NavItem[] = [
  { id: 'deployments', label: 'Functions',  icon: 'fn' },
  { id: 'templates',   label: 'Templates',  icon: 'fileLines' },
  { id: 'logs',        label: 'Logs',       icon: 'activity' },
  { id: 'keys',        label: 'API keys',   icon: 'keys' },
  { id: 'usage',       label: 'Usage',      icon: 'coin' },
];

const BOTTOM: NavItem[] = [
  { id: 'docs',    label: 'Documentation', icon: 'book' },
  { id: 'support', label: 'Support',       icon: 'headset' },
];

type Props = {
  active: ViewId;
  onSelect: (id: ViewId) => void;
  onDeploy: () => void;
};

export function Sidebar({ active, onSelect, onDeploy }: Props): ReactElement {
  return (
    <aside
      style={{
        width: 232,
        flexShrink: 0,
        background: 'var(--bg)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        padding: '14px 12px 12px',
      }}
    >
      <a
        href="#"
        onClick={(e) => e.preventDefault()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 6px 16px',
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        <AkashSign size={16} color="var(--accent)" />
        <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
          akash
          <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}> functions</span>
        </span>
      </a>

      <button
        onClick={onDeploy}
        className="btn btn-ghost"
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '10px 14px',
          borderRadius: 10,
          background: 'var(--bg-elev-2)',
          borderColor: 'var(--line-strong)',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Icon name="rocket" size={14} />
        <span style={{ fontWeight: 600 }}>Deploy</span>
      </button>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
        {MAIN.map((it) => (
          <Item key={it.id} it={it} active={active === it.id} onSelect={onSelect} />
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 8 }}>
        {BOTTOM.map((it) => (
          <Item key={it.id} it={it} active={active === it.id} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

function Item({
  it,
  active,
  onSelect,
}: {
  it: NavItem;
  active: boolean;
  onSelect: (id: ViewId) => void;
}): ReactElement {
  return (
    <button
      onClick={() => onSelect(it.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '9px 12px',
        borderRadius: 8,
        background: active ? 'var(--bg-elev-3)' : 'transparent',
        border: 'none',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        cursor: 'pointer',
        fontSize: 13.5,
        fontWeight: active ? 600 : 500,
        textAlign: 'left',
        transition: 'background 120ms var(--ease-out), color 120ms',
      }}
    >
      <Icon name={it.icon} size={16} />
      <span>{it.label}</span>
    </button>
  );
}
