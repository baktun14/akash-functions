// "Use this function" — language tabs with copy-pasteable snippets.
//
// Snippets are derived from the function's declared routes (an opt-in
// `akash.json` manifest parsed by the server) when available. Without a
// manifest we fall back to a single `GET /` example, which is always safe
// because the runner serves user code at root.

import { useState } from 'react';
import type { FunctionRecord, FunctionRoute, RouteMethod } from '@shared/types';
import { Icon } from '../icons';
import { SnippetBlock, type SnippetLang } from './SnippetBlock';

type Lang = 'curl' | 'js' | 'python';

const LANG_TABS: { id: Lang; label: string; snippetLang: SnippetLang }[] = [
  { id: 'curl',   label: 'cURL',       snippetLang: 'shell'  },
  { id: 'js',     label: 'JavaScript', snippetLang: 'js'     },
  { id: 'python', label: 'Python',     snippetLang: 'python' },
];

const DEFAULT_ROUTES: FunctionRoute[] = [{ method: 'GET', path: '/' }];

export function UseThisFunction({
  svc,
  url: urlOverride,
  routes,
}: {
  svc: FunctionRecord;
  url?: string;
  routes?: FunctionRoute[];
}) {
  const [tab, setTab] = useState<Lang>('curl');
  // Prefer the live ingress URL passed in by the parent. The function record's
  // subdomain may still be the placeholder while the list query catches up.
  const url = (urlOverride ?? `https://${svc.subdomain}`).replace(/\/$/, '');
  const effectiveRoutes = routes && routes.length > 0 ? routes : DEFAULT_ROUTES;

  const samples = buildSamples(url, effectiveRoutes);
  const activeTab = LANG_TABS.find((t) => t.id === tab)!;

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

      <SnippetBlock code={samples[tab]} lang={activeTab.snippetLang} />

      {!routes?.length && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--fg-muted)' }}>
          Your function defines its own routes — this shows the root path. Add
          an{' '}
          <code className="mono" style={{ fontSize: 11.5, color: 'var(--fg)' }}>
            akash.json
          </code>{' '}
          to your source to declare more.
        </div>
      )}

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

// ─── snippet builders ──────────────────────────────────────────────────────

function buildSamples(url: string, routes: FunctionRoute[]): Record<Lang, string> {
  return {
    curl:   buildShellSamples(url, routes),
    js:     buildJsSamples(url, routes),
    python: buildPythonSamples(url, routes),
  };
}

// `:id` and `{id}` placeholders get replaced in the rendered URL with a
// concrete value, with an inline comment so users know to swap it. Real client
// code obviously needs the real value.
function concretePath(p: string): { url: string; hadParam: boolean } {
  let hadParam = false;
  const replaced = p.replace(/(:[a-zA-Z_][a-zA-Z0-9_]*|\{[^}]+\})/g, () => {
    hadParam = true;
    return '123';
  });
  return { url: replaced, hadParam };
}

function paramHint(originalPath: string): string {
  const m = originalPath.match(/(:[a-zA-Z_][a-zA-Z0-9_]*|\{[^}]+\})/);
  return m ? `  # replace ${m[0]}` : '';
}

function commentHeader(route: FunctionRoute, marker: '#' | '//'): string {
  const desc = route.description ? `  — ${route.description}` : '';
  return `${marker} ${route.method} ${route.path}${desc}`;
}

function bodyJson(route: FunctionRoute): string {
  if (route.body === undefined) return '{"name":"world"}';
  return JSON.stringify(route.body);
}

function methodHasBody(m: RouteMethod): boolean {
  return m === 'POST' || m === 'PUT' || m === 'PATCH';
}

function buildShellSamples(url: string, routes: FunctionRoute[]): string {
  return routes
    .map((r) => {
      const { url: pathUrl } = concretePath(r.path);
      const fullUrl = pathUrl === '/' ? url : `${url}${pathUrl}`;
      const hint = paramHint(r.path);
      const header = commentHeader(r, '#');

      if (methodHasBody(r.method)) {
        return [
          header,
          `curl -X ${r.method} ${fullUrl}${hint} \\`,
          `  -H 'Content-Type: application/json' \\`,
          `  -d '${bodyJson(r)}'`,
        ].join('\n');
      }
      // Default GET form skips the explicit -X for the cleanest copy-paste.
      const verb = r.method === 'GET' ? 'curl' : `curl -X ${r.method}`;
      return `${header}\n${verb} ${fullUrl}${hint}`;
    })
    .join('\n\n');
}

function buildJsSamples(url: string, routes: FunctionRoute[]): string {
  const blocks = routes.map((r, i) => {
    const { url: pathUrl } = concretePath(r.path);
    const fullUrl = pathUrl === '/' ? url : `${url}${pathUrl}`;
    const hint = paramHint(r.path).replace('# ', '// ');
    const header = commentHeader(r, '//');
    const v = `r${i + 1}`;

    if (methodHasBody(r.method)) {
      return [
        header,
        `const ${v} = await fetch("${fullUrl}", {${hint}`,
        `  method: "${r.method}",`,
        `  headers: { "Content-Type": "application/json" },`,
        `  body: JSON.stringify(${bodyJson(r)}),`,
        `});`,
        `console.log(await ${v}.text());`,
      ].join('\n');
    }

    const opts = r.method === 'GET' ? '' : `, { method: "${r.method}" }`;
    return [
      header,
      `const ${v} = await fetch("${fullUrl}"${opts});${hint}`,
      `console.log(await ${v}.text());`,
    ].join('\n');
  });
  return blocks.join('\n\n');
}

function buildPythonSamples(url: string, routes: FunctionRoute[]): string {
  const blocks = routes.map((r) => {
    const { url: pathUrl } = concretePath(r.path);
    const fullUrl = pathUrl === '/' ? url : `${url}${pathUrl}`;
    const hint = paramHint(r.path);
    const header = commentHeader(r, '#');

    if (methodHasBody(r.method)) {
      return [
        header,
        `r = requests.${r.method.toLowerCase()}(${hint}`,
        `    "${fullUrl}",`,
        `    json=${bodyJson(r).replace(/"/g, "'")},`,
        `)`,
        `print(r.text)`,
      ].join('\n');
    }
    return [
      header,
      `r = requests.${r.method.toLowerCase()}("${fullUrl}")${hint}`,
      `print(r.text)`,
    ].join('\n');
  });
  return ['# pip install requests', 'import requests', '', ...blocks].join('\n');
}
