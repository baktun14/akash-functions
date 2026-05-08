// "Use this function" — language tabs with copy-pasteable snippets.

import { useState } from 'react';
import type { FunctionRecord } from '@shared/types';
import { Icon } from '../icons';
import { SnippetBlock } from './SnippetBlock';

type Lang = 'curl' | 'js' | 'python' | 'sdk';

const LANG_TABS: { id: Lang; label: string }[] = [
  { id: 'curl',   label: 'cURL' },
  { id: 'js',     label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'sdk',    label: 'SDK' },
];

export function UseThisFunction({ svc }: { svc: FunctionRecord }) {
  const [tab, setTab] = useState<Lang>('curl');
  const url = `https://${svc.subdomain}`;

  const samples: Record<Lang, string[][]> = {
    curl: [
      ['c', '# Hit the root endpoint'],
      ['cmd', 'curl', ' ', 'arg', url],
      [],
      ['c', '# Health check (returns JSON)'],
      ['cmd', 'curl', ' ', 'arg', `${url}/api/health`],
      [],
      ['c', '# POST with JSON body'],
      [
        'cmd', 'curl', ' ', 'flag', '-X', ' ', 'arg', 'POST', ' ', 'arg', url,
        ' \\\n  ', 'flag', '-H', ' ', 'arg', '"Content-Type: application/json"',
        ' \\\n  ', 'flag', '-d', ' ', 'arg', `'{"name":"world"}'`,
      ],
    ],
    js: [
      ['c', '// fetch from any JS runtime'],
      ['k', 'const', 'p', ' ', 'v', 'res', 'p', ' = ', 'k', 'await', 'p', ' ', 'f', 'fetch', 'p', '(', 's', `"${url}/api/health"`, 'p', ');'],
      [],
      ['k', 'const', 'p', ' ', 'v', 'data', 'p', ' = ', 'k', 'await', 'p', ' ', 'v', 'res', 'p', '.', 'f', 'json', 'p', '();'],
      ['v', 'console', 'p', '.', 'f', 'log', 'p', '(', 'v', 'data', 'p', '); ', 'c', '// { status: "ok" }'],
    ],
    python: [
      ['c', '# pip install requests'],
      ['k', 'import', 'p', ' ', 'v', 'requests'],
      [],
      ['v', 'r', 'p', ' = ', 'v', 'requests', 'p', '.', 'f', 'get', 'p', '(', 's', `"${url}/api/health"`, 'p', ')'],
      ['f', 'print', 'p', '(', 'v', 'r', 'p', '.', 'f', 'json', 'p', '())  ', 'c', '# {"status": "ok"}'],
    ],
    sdk: [
      ['c', '// npm install @akash/functions'],
      ['k', 'import', 'p', ' { ', 'v', 'AkashFunctions', 'p', ' } ', 'k', 'from', 'p', ' ', 's', '"@akash/functions"', 'p', ';'],
      [],
      ['k', 'const', 'p', ' ', 'v', 'fn', 'p', ' = ', 'k', 'new', 'p', ' ', 't', 'AkashFunctions', 'p', '(', 's', `"${svc.name}"`, 'p', ');'],
      ['k', 'const', 'p', ' ', 'v', 'out', 'p', ' = ', 'k', 'await', 'p', ' ', 'v', 'fn', 'p', '.', 'f', 'invoke', 'p', '({ ', 'v', 'name', 'p', ': ', 's', '"world"', 'p', ' });'],
    ],
  };

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Use this function
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
          Hit the URL from anywhere — no auth required by default.
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          marginBottom: 10,
          width: 'fit-content',
        }}
      >
        {LANG_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              background: tab === t.id ? 'var(--bg-elev-4)' : 'transparent',
              color: tab === t.id ? 'var(--fg)' : 'var(--fg-muted)',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <SnippetBlock tokens={samples[tab]} />

      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <TipCard
          icon="globe"
          title="Public URL"
          body="Reachable over HTTPS from any client. Cold start under 200ms."
        />
        <TipCard
          icon="lock"
          title="Add auth"
          body="Set AUTH_TOKEN in Variables and check it in your handler."
        />
        <TipCard
          icon="bolt"
          title="Custom domain"
          body="Point a CNAME to your *.akash-functions.io subdomain."
        />
      </div>
    </div>
  );
}

function TipCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="card" style={{ padding: 14, background: 'var(--bg-elev-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Icon name={icon} size={13} color="var(--fg-muted)" />
        <div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}
