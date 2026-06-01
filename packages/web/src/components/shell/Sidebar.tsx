// Akash Functions sidebar — 232px, akash·red dot wordmark, nav.

import type { ReactElement } from 'react';
import { AkashSign, Icon } from '../icons';

type ViewId = 'deployments' | 'jobs' | 'templates' | 'logs' | 'keys' | 'usage' | 'docs' | 'support';

type NavItem = { id: ViewId; label: string; icon: string };

const MAIN: NavItem[] = [
  { id: 'deployments', label: 'Functions',  icon: 'fn' },
  { id: 'jobs',        label: 'Jobs',       icon: 'bolt' },
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
};

export function Sidebar({ active, onSelect }: Props): ReactElement {
  return (
    <aside
      style={{
        width: 232,
        flexShrink: 0,
        background: 'var(--bg)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        padding: '0 14px 14px',
      }}
    >
      <a
        href="#"
        onClick={(e) => e.preventDefault()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 56,
          padding: '0 6px',
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

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 18 }}>
        {MAIN.map((it) => (
          <Item key={it.id} it={it} active={active === it.id} onSelect={onSelect} />
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8 }}>
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
