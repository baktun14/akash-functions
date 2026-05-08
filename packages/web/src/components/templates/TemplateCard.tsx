import { useState } from 'react';
import type { Template } from '@shared/types';
import { Icon } from '../icons';

type Props = {
  t: Template;
  onUse: () => void;
};

export function TemplateCard({ t, onUse }: Props) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        background: 'var(--bg-elev-1)',
        border: '1px solid ' + (hover ? 'var(--line-bold)' : 'var(--line)'),
        borderRadius: 12,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        transition: 'border-color 120ms var(--ease-out), background 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: 'var(--bg-elev-3)',
            border: '1px solid var(--line-strong)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--fg)',
            flexShrink: 0,
          }}
        >
          <Icon name={t.icon} size={15} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {t.name}
            </div>
            {t.akashml && (
              <span
                style={{
                  padding: '1px 6px',
                  fontSize: 9,
                  letterSpacing: '0.06em',
                  borderRadius: 9999,
                  border: '1px solid rgba(255,41,3,0.4)',
                  color: 'var(--accent-soft)',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                AkashML
              </span>
            )}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
            {t.runtime}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
          textWrap: 'pretty',
          minHeight: 38,
        }}
      >
        {t.desc}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {t.tags.map((tag) => (
            <span
              key={tag}
              className="mono"
              style={{
                fontSize: 10.5,
                color: 'var(--fg-subtle)',
                padding: '2px 7px',
                borderRadius: 9999,
                background: 'var(--bg-elev-2)',
                border: '1px solid var(--line)',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
        <button
          onClick={onUse}
          className="btn btn-ghost btn-sm"
          style={{
            gap: 6,
            padding: '6px 10px',
            flexShrink: 0,
            opacity: hover ? 1 : 0.85,
          }}
        >
          Use
          <Icon name="arrowUp" size={11} style={{ transform: 'rotate(90deg)' }} />
        </button>
      </div>
    </div>
  );
}
