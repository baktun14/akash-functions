// Templates browser — full-page catalog of starter functions.

import { useMemo, useState } from 'react';
import type { Template, TemplateCategory } from '@shared/types';
import { Icon } from '../icons';
import { TEMPLATES, TEMPLATE_CATEGORIES } from '../../data/templates';
import { TemplateCard } from './TemplateCard';

type Props = {
  onUseTemplate: (t: Template) => void;
};

export function TemplatesPage({ onUseTemplate }: Props) {
  const [filter, setFilter] = useState<TemplateCategory>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return TEMPLATES.filter((t) => {
      if (filter !== 'all' && t.cat !== filter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !t.name.toLowerCase().includes(q) &&
          !t.desc.toLowerCase().includes(q) &&
          !t.tags.some((tag) => tag.toLowerCase().includes(q))
        ) {
          return false;
        }
      }
      return true;
    });
  }, [filter, query]);

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
          maxWidth: 1280,
          margin: '0 auto 22px',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em' }}>Templates</div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>
            {TEMPLATES.length} starters · production-ready, deploy in one click
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--bg-elev-1)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '8px 12px',
            width: 280,
          }}
        >
          <Icon name="search" size={13} color="var(--fg-subtle)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: 'var(--fg)',
              fontSize: 13,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--fg-subtle)',
                cursor: 'pointer',
                padding: 0,
                display: 'flex',
              }}
              title="Clear"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto 22px',
          display: 'flex',
          gap: 4,
          flexWrap: 'wrap',
        }}
      >
        {TEMPLATE_CATEGORIES.map((c) => {
          const isActive = filter === c.id;
          const count = c.id === 'all' ? TEMPLATES.length : TEMPLATES.filter((t) => t.cat === c.id).length;
          return (
            <button
              key={c.id}
              onClick={() => setFilter(c.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 14px',
                borderRadius: 9999,
                background: isActive ? 'var(--bg-elev-3)' : 'transparent',
                border: '1px solid ' + (isActive ? 'var(--line-strong)' : 'var(--line)'),
                color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
                cursor: 'pointer',
                transition: 'all 120ms var(--ease-out)',
              }}
            >
              {c.label}
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: isActive ? 'var(--fg-subtle)' : 'var(--fg-faint)',
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length > 0 ? (
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 14,
          }}
        >
          {filtered.map((t) => (
            <TemplateCard key={t.id} t={t} onUse={() => onUseTemplate(t)} />
          ))}
        </div>
      ) : (
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            padding: '60px 0',
            textAlign: 'center',
            color: 'var(--fg-muted)',
          }}
        >
          <div style={{ fontSize: 14, marginBottom: 6 }}>No templates match "{query}"</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            Try a different keyword, or describe what you need in the Deploy builder.
          </div>
        </div>
      )}
    </div>
  );
}
