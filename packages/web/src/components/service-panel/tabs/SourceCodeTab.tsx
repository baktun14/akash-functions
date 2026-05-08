import { Icon } from '../../icons';

const LINES: ([string, string][])[] = [
  [['c', '// index.tsx (Bun v1.3 runtime)']],
  [['k', 'import'], ['p', ' { '], ['v', 'Hono'], ['p', ' } '], ['k', 'from'], ['s', ' "hono@4"'], ['p', ';']],
  [['k', 'import'], ['p', ' { '], ['v', 'cors'], ['p', ' } '], ['k', 'from'], ['s', ' "hono/cors"'], ['p', ';']],
  [],
  [['k', 'const'], ['v', ' app '], ['p', '= '], ['k', 'new'], ['t', ' Hono'], ['p', '();']],
  [],
  [['v', 'app'], ['p', '.'], ['f', 'use'], ['p', '('], ['s', '"/*"'], ['p', ', '], ['f', 'cors'], ['p', '());']],
  [['v', 'app'], ['p', '.'], ['f', 'get'], ['p', '('], ['s', '"/"'], ['p', ', ('], ['v', 'c'], ['p', ') => '], ['v', 'c'], ['p', '.'], ['f', 'text'], ['p', '('], ['s', '"Hello world!"'], ['p', '));']],
  [['v', 'app'], ['p', '.'], ['f', 'get'], ['p', '('], ['s', '"/api/health"'], ['p', ', ('], ['v', 'c'], ['p', ') => '], ['v', 'c'], ['p', '.'], ['f', 'json'], ['p', '({ '], ['v', 'status'], ['p', ': '], ['s', '"ok"'], ['p', ' }));']],
  [],
  [['t', 'Bun'], ['p', '.'], ['f', 'serve'], ['p', '({']],
  [['p', '  '], ['v', 'port'], ['p', ': '], ['v', 'import'], ['p', '.'], ['v', 'meta'], ['p', '.'], ['v', 'env'], ['p', '.'], ['v', 'PORT'], ['p', ' ?? '], ['n', '3000'], ['p', ',']],
  [['p', '  '], ['v', 'fetch'], ['p', ': '], ['v', 'app'], ['p', '.'], ['v', 'fetch'], ['p', ',']],
  [['p', '});']],
];

export function SourceCodeTab() {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          marginBottom: 12,
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          fontSize: 13,
        }}
      >
        <Icon name="file" size={14} color="var(--fg-muted)" />
        <span className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
          index.tsx
        </span>
        <span style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>
          · Bun v1.3 runtime · read-only
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-subtle btn-sm">
          <Icon name="edit" size={12} /> Edit in builder
        </button>
      </div>
      <div className="card" style={{ padding: '16px 18px', background: '#08080B', overflow: 'auto' }}>
        <div className="code-block">
          {LINES.map((toks, i) => (
            <div key={i}>
              <span className="ln">{i + 1}</span>
              {toks.length === 0
                ? ' '
                : toks.map((t, j) => (
                    <span key={j} className={`tok-${t[0]}`}>
                      {t[1]}
                    </span>
                  ))}
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          marginTop: 14,
          padding: 12,
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          fontSize: 12.5,
          color: 'var(--fg-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Icon name="info" size={13} />
        Bundled with{' '}
        <span className="mono" style={{ color: 'var(--fg)' }}>
          bun build --target=bun
        </span>
        , served by{' '}
        <span className="mono" style={{ color: 'var(--fg)' }}>
          Bun.serve
        </span>
        .
      </div>
    </div>
  );
}
