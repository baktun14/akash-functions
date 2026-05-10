// Collapsible panel listing every HTTP route the server detected in the
// function's source code. Sits below the root URL bar on the Deployments tab
// so multi-route APIs aren't hidden behind the snippet builder further down.

import { useState } from 'react';
import type { FunctionRoute } from '@shared/types';
import { Icon } from '../icons';
import { hasPathParam } from './routes';

const BODY_ID = 'routes-panel-body';

export function RoutesPanel({ url, routes }: { url: string; routes: FunctionRoute[] }) {
  const [expanded, setExpanded] = useState(false);
  const baseUrl = url.replace(/\/$/, '');
  const summary = routes.map((r) => `${r.method} ${r.path}`).join(' · ');

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={BODY_ID}
        style={{
          width: '100%',
          textAlign: 'left',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'var(--fg)',
          cursor: 'pointer',
        }}
      >
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          size={14}
          color="var(--fg-muted)"
        />
        <span style={{ fontSize: 13 }}>
          {routes.length} {routes.length === 1 ? 'route' : 'routes'} detected in your code
        </span>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--fg-subtle)',
            marginLeft: 'auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
          title={summary}
        >
          {summary}
        </span>
      </button>

      {expanded && (
        <div
          id={BODY_ID}
          className="fade-up scroll"
          style={{
            marginTop: 8,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-elev-2)',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {routes.map((r, i) => (
            <RouteRow key={`${r.method}-${r.path}-${i}`} route={r} baseUrl={baseUrl} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function RouteRow({
  route,
  baseUrl,
  first,
}: {
  route: FunctionRoute;
  baseUrl: string;
  first: boolean;
}) {
  const fullUrl = `${baseUrl}${route.path}`;
  const canOpen = route.method === 'GET' && !hasPathParam(route.path);

  const onCopy = () => {
    navigator.clipboard?.writeText(fullUrl).catch(() => undefined);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '52px 1fr auto',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderTop: first ? 'none' : '1px solid var(--line)',
      }}
    >
      <span className="pill pill-mono pill-ghost" style={{ justifySelf: 'start' }}>
        {route.method}
      </span>
      <div style={{ minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 12.5,
            color: 'var(--fg)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={route.path}
        >
          {route.path}
        </div>
        {route.description && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-muted)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={route.description}
          >
            {route.description}
          </div>
        )}
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy ${route.method} ${route.path} URL`}
          title="Copy URL"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--fg-muted)',
            padding: 4,
            display: 'inline-flex',
            cursor: 'pointer',
          }}
        >
          <Icon name="copy" size={13} />
        </button>
        {canOpen && (
          <a
            href={fullUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${route.path} in new tab`}
            title="Open in new tab"
            style={{
              color: 'var(--fg-muted)',
              padding: 4,
              display: 'inline-flex',
            }}
          >
            <Icon name="external" size={13} />
          </a>
        )}
      </div>
    </div>
  );
}
