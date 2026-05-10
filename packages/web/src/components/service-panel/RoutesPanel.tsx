// Collapsible panel listing every HTTP route the server detected in the
// function's source code. Sits below the root URL bar on the Deployments tab
// so multi-route APIs aren't hidden behind the snippet builder further down.
// Each row exposes a Public/Protected toggle that writes to the function's
// protected-routes set; the runner picks up the change on its next poll.

import { useState } from 'react';
import type { FunctionRoute, ProtectedRouteKey } from '@shared/types';
import { Icon } from '../icons';
import { hasPathParam } from './routes';

const BODY_ID = 'routes-panel-body';

export function routeKeyOf(r: { method: string; path: string }): ProtectedRouteKey {
  return `${r.method.toUpperCase()} ${r.path}`;
}

type Props = {
  url: string;
  routes: FunctionRoute[];
  /** Called when the user toggles a route's auth requirement. Should write
   *  the new set to the backend and refresh the deployment record. */
  onToggleAuth?: (route: FunctionRoute, nextProtected: boolean) => Promise<void>;
  /** When set, the "Public → Protected" direction is disabled and the
   *  string is shown as the toggle's tooltip + a banner above the list. The
   *  "Protected → Public" direction remains enabled. */
  protectionDisabledReason?: string;
};

export function RoutesPanel({ url, routes, onToggleAuth, protectionDisabledReason }: Props) {
  const [expanded, setExpanded] = useState(false);
  const baseUrl = url.replace(/\/$/, '');
  const summary = routes.map((r) => `${r.method} ${r.path}`).join(' · ');
  const protectedCount = routes.filter((r) => r.auth === 'apiKey').length;

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
          {protectedCount > 0 && (
            <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>
              {' '}· {protectedCount} protected
            </span>
          )}
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
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {protectionDisabledReason && (
            <div
              style={{
                padding: '8px 14px',
                background: 'rgba(245,165,36,0.08)',
                borderBottom: '1px solid var(--line)',
                fontSize: 12,
                color: 'var(--warn, #f5a524)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon name="info" size={12} color="var(--warn, #f5a524)" />
              {protectionDisabledReason}
            </div>
          )}
          {routes.map((r, i) => (
            <RouteRow
              key={`${r.method}-${r.path}-${i}`}
              route={r}
              baseUrl={baseUrl}
              first={i === 0}
              onToggleAuth={onToggleAuth}
              protectionDisabledReason={protectionDisabledReason}
            />
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
  onToggleAuth,
  protectionDisabledReason,
}: {
  route: FunctionRoute;
  baseUrl: string;
  first: boolean;
  onToggleAuth?: (route: FunctionRoute, nextProtected: boolean) => Promise<void>;
  protectionDisabledReason?: string;
}) {
  const fullUrl = `${baseUrl}${route.path}`;
  const canOpen = route.method === 'GET' && !hasPathParam(route.path) && route.auth !== 'apiKey';
  const isProtected = route.auth === 'apiKey';
  const [pending, setPending] = useState(false);
  // Going from Public → Protected is what gets blocked on an outdated runner.
  // The reverse direction (un-protecting) is always allowed since it removes
  // a (broken) restriction, never adds one.
  const protectDisabled = !isProtected && !!protectionDisabledReason;

  const onCopy = () => {
    navigator.clipboard?.writeText(fullUrl).catch(() => undefined);
  };

  const onToggle = async () => {
    if (!onToggleAuth || pending || protectDisabled) return;
    setPending(true);
    try {
      await onToggleAuth(route, !isProtected);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '52px 1fr auto auto',
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
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
          title={route.path}
        >
          {isProtected && (
            <Icon name="lock" size={11} color="var(--accent)" />
          )}
          <span>{route.path}</span>
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
      {onToggleAuth && (
        <AuthToggle
          isProtected={isProtected}
          pending={pending}
          disabled={protectDisabled}
          disabledReason={protectionDisabledReason}
          onClick={onToggle}
        />
      )}
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

function AuthToggle({
  isProtected,
  pending,
  disabled,
  disabledReason,
  onClick,
}: {
  isProtected: boolean;
  pending: boolean;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  const title = disabled
    ? (disabledReason ?? 'Disabled')
    : isProtected
      ? 'Make this route public'
      : 'Require an API key for this route';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 11.5,
        fontWeight: 500,
        borderRadius: 6,
        border: '1px solid var(--line)',
        background: isProtected
          ? 'color-mix(in oklch, var(--accent) 12%, transparent)'
          : 'var(--bg-elev-3)',
        color: isProtected ? 'var(--accent)' : 'var(--fg-muted)',
        cursor: disabled ? 'not-allowed' : pending ? 'progress' : 'pointer',
        opacity: disabled ? 0.55 : pending ? 0.7 : 1,
      }}
    >
      <Icon name={isProtected ? 'lock' : 'globe'} size={11} />
      {isProtected ? 'Protected' : 'Public'}
    </button>
  );
}
