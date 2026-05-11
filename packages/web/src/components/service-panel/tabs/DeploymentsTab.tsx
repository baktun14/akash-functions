import { useCallback, useEffect, useState } from 'react';
import type {
  DeploymentRecord,
  DeploymentState,
  FunctionRecord,
  FunctionRoute,
} from '@shared/types';
import { Icon } from '../../icons';
import { api } from '../../../lib/api';
import { useReachable } from '../../../lib/useReachable';
import { RoutesPanel, routeKeyOf } from '../RoutesPanel';
import { UseThisFunction } from '../UseThisFunction';

const TRANSIENT_STATES: DeploymentState[] = ['pending', 'bidding', 'leased'];
const POLL_INTERVAL_MS = 2000;
const ERROR_BACKOFF_MS = 5000;

function useDeployment(
  fnId: string,
  depId: string | undefined
): { dep: DeploymentRecord | null; refresh: () => Promise<void> } {
  const [dep, setDep] = useState<DeploymentRecord | null>(null);

  const refresh = useCallback(async () => {
    if (!depId) return;
    try {
      const next = await api.getDeployment(fnId, depId);
      setDep(next);
    } catch {
      /* ignore — next poll will retry */
    }
  }, [fnId, depId]);

  useEffect(() => {
    if (!depId) {
      setDep(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const next = await api.getDeployment(fnId, depId);
        if (cancelled) return;
        setDep(next);
        if (TRANSIENT_STATES.includes(next.state)) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, ERROR_BACKOFF_MS);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fnId, depId]);

  return { dep, refresh };
}

type StateMeta = {
  label: string;
  pillClass: string;
  body: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
};

function describe(dep: DeploymentRecord | null): StateMeta {
  if (!dep) {
    return { label: 'Unknown', pillClass: 'pill', body: 'No deployment yet', tone: 'neutral' };
  }
  switch (dep.state) {
    case 'pending':
      return { label: 'Preparing', pillClass: 'pill', body: 'Setting up your environment', tone: 'neutral' };
    case 'bidding':
      return { label: 'Reserving', pillClass: 'pill', body: 'Allocating compute resources', tone: 'warn' };
    case 'leased':
      return { label: 'Starting', pillClass: 'pill', body: 'Bringing your function online', tone: 'warn' };
    case 'live':
      return { label: 'Active', pillClass: 'pill pill-ok', body: 'ready to receive traffic', tone: 'ok' };
    case 'failed':
      return {
        label: 'Failed',
        pillClass: 'pill',
        body: dep.errorMessage ?? "Couldn't start your function",
        tone: 'error',
      };
    case 'closed':
      return { label: 'Stopped', pillClass: 'pill', body: 'Function stopped', tone: 'neutral' };
    default:
      return { label: dep.state, pillClass: 'pill', body: '', tone: 'neutral' };
  }
}

type UpdateState = 'idle' | 'submitting' | 'submitted' | 'error';

export function DeploymentsTab({ svc }: { svc: FunctionRecord }) {
  const depId = svc.deploymentId ?? svc.latestDeploymentId;
  const { dep, refresh: refreshDeployment } = useDeployment(svc.id, depId);
  const meta = describe(dep);
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);

  const onToggleAuth = useCallback(
    async (route: FunctionRoute, nextProtected: boolean) => {
      // Refuse to mark a route as protected when the runner is on an older
      // version that doesn't enforce — toggling would save the flag but
      // unauthenticated callers would still reach user code, which is a
      // silent security regression. Allow un-protecting always.
      if (nextProtected && dep?.runnerOutdated) {
        throw new Error(
          `Update the runner to ${dep.expectedRunnerVersion ?? 'the latest version'} before marking routes protected — older runners don't enforce auth.`
        );
      }
      const current = (dep?.routes ?? [])
        .filter((r) => r.auth === 'apiKey')
        .map((r) => routeKeyOf(r));
      const key = routeKeyOf(route);
      const next = nextProtected
        ? Array.from(new Set([...current, key]))
        : current.filter((k) => k !== key);
      await api.updateProtectedRoutes(svc.id, next);
      await refreshDeployment();
    },
    [dep?.routes, dep?.runnerOutdated, dep?.expectedRunnerVersion, svc.id, refreshDeployment]
  );

  const onUpdateRunner = async () => {
    if (!dep || dep.state !== 'live') return;
    if (!confirm('Update the runner image? Your function will briefly restart.')) return;
    setUpdateState('submitting');
    setUpdateError(null);
    try {
      await api.updateRunnerImage(svc.id, dep.id);
      setUpdateState('submitted');
      setTimeout(() => setUpdateState('idle'), 3000);
    } catch (err) {
      setUpdateError((err as Error).message);
      setUpdateState('error');
      setTimeout(() => setUpdateState('idle'), 6000);
    }
  };

  const liveUri = dep?.uris?.[0];
  const publicUrl = liveUri
    ? liveUri.startsWith('http')
      ? liveUri
      : `https://${liveUri}`
    : null;
  // Only probe once Akash says the lease is live — otherwise we'd just be
  // burning cycles on a URL that doesn't exist yet.
  const reachable = useReachable(svc.id, dep?.state === 'live');

  const toneColor =
    meta.tone === 'ok'
      ? 'var(--ok)'
      : meta.tone === 'error'
        ? 'var(--err, #e5484d)'
        : meta.tone === 'warn'
          ? 'var(--warn, #f5a524)'
          : 'var(--fg-muted)';

  // The header pill (`● Online`) already conveys a healthy state, so when
  // everything is fine the card stays calm and neutral. Tone only escalates
  // the card chrome when there's something the header pill can't express.
  const containerBorder =
    meta.tone === 'error'
      ? 'rgba(229,72,77,0.25)'
      : meta.tone === 'warn'
        ? 'rgba(245,165,36,0.25)'
        : 'var(--line)';
  const containerBg =
    meta.tone === 'error'
      ? 'rgba(229,72,77,0.05)'
      : meta.tone === 'warn'
        ? 'rgba(245,165,36,0.05)'
        : 'var(--bg-elev-2)';

  // Show the inner status row only when it adds information beyond the header
  // pill — i.e. transient/error states or "live but ingress not yet probed".
  const showStatusRow = meta.tone !== 'ok' || !reachable;
  // True whenever something is in motion behind the scenes — drives the
  // shimmer, animated ellipsis, and spinning icon. Excludes failed (red,
  // static) and fully-reachable live (status row hidden anyway).
  const isWorking = meta.tone === 'warn' || meta.tone === 'neutral' || (meta.tone === 'ok' && !reachable);

  return (
    <div>
      {/* URL bar — only shown once the ingress is actually serving traffic.
          Akash flips state to 'live' before the upstream container is ready,
          so we wait for the server-side probe to succeed before exposing the
          link (otherwise users click through to a 503). */}
      {publicUrl && reachable && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            marginBottom: 14,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--line)',
            borderRadius: 10,
          }}
        >
          <Icon name="globe" size={14} color="var(--fg-muted)" />
          <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
            {publicUrl}
          </span>
          <div style={{ flex: 1 }} />
          <button
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', padding: 4 }}
            title="Copy"
            onClick={() => navigator.clipboard?.writeText(publicUrl).catch(() => undefined)}
          >
            <Icon name="copy" size={13} />
          </button>
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--fg-muted)', padding: 4, display: 'inline-flex' }}
            title="Open"
          >
            <Icon name="external" size={13} />
          </a>
          {dep?.state === 'live' && (
            <button
              onClick={onUpdateRunner}
              disabled={updateState === 'submitting'}
              title={
                dep.runnerOutdated
                  ? `Runner ${dep.runnerVersion ?? 'unknown'} → ${dep.expectedRunnerVersion}. Click to update in place.`
                  : 'Submit a fresh SDL on the same lease so the provider re-pulls the runner image'
              }
              style={{
                marginLeft: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                fontSize: 12,
                background:
                  updateState === 'submitting'
                    ? 'var(--bg-elev-3)'
                    : dep.runnerOutdated
                      ? 'rgba(245,165,36,0.12)'
                      : 'var(--bg-elev-3)',
                border:
                  updateState === 'submitting'
                    ? '1px solid var(--line)'
                    : dep.runnerOutdated
                      ? '1px solid rgba(245,165,36,0.45)'
                      : '1px solid var(--line)',
                borderRadius: 6,
                color:
                  updateState === 'submitting'
                    ? 'var(--fg-muted)'
                    : dep.runnerOutdated
                      ? 'var(--warn, #f5a524)'
                      : 'var(--fg)',
                cursor: updateState === 'submitting' ? 'not-allowed' : 'pointer',
                opacity: updateState === 'submitting' ? 0.55 : 1,
              }}
            >
              <Icon
                name={
                  updateState === 'submitting'
                    ? 'spinner'
                    : dep.runnerOutdated
                      ? 'arrowUp'
                      : 'refresh'
                }
                size={11}
                color={
                  updateState === 'submitting'
                    ? 'var(--fg-muted)'
                    : dep.runnerOutdated
                      ? 'var(--warn, #f5a524)'
                      : 'var(--fg-muted)'
                }
                className={updateState === 'submitting' ? 'spin' : undefined}
              />
              {updateState === 'submitting'
                ? 'Updating…'
                : updateState === 'submitted'
                  ? 'Update submitted'
                  : updateState === 'error'
                    ? 'Update failed'
                    : dep.runnerOutdated
                      ? 'Update runner ·'
                      : 'Update runner'}
              {dep.runnerOutdated && updateState === 'idle' && (
                <span
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--warn, #f5a524)', fontWeight: 500 }}
                >
                  {dep.runnerVersion ?? '—'} → {dep.expectedRunnerVersion}
                </span>
              )}
            </button>
          )}
        </div>
      )}
      {updateState === 'error' && updateError && (
        <div
          style={{
            marginBottom: 14,
            padding: '8px 12px',
            background: 'rgba(229,72,77,0.06)',
            border: '1px solid rgba(229,72,77,0.25)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--fg-muted)',
            wordBreak: 'break-word',
          }}
        >
          Couldn't submit update: {updateError}
        </div>
      )}

      {publicUrl && reachable && dep?.routes && dep.routes.length > 0 && (
        <RoutesPanel
          url={publicUrl}
          routes={dep.routes}
          onToggleAuth={onToggleAuth}
          protectionDisabledReason={
            dep.runnerOutdated
              ? `Update the runner${dep.runnerVersion ? ` (${dep.runnerVersion} → ${dep.expectedRunnerVersion})` : ''} before marking routes protected — older runners don't enforce auth.`
              : undefined
          }
        />
      )}

      {/* Active deployment */}
      <div
        style={{
          border: `1px solid ${containerBorder}`,
          background: containerBg,
          borderRadius: 10,
          padding: '12px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="box" size={14} color="var(--fg-muted)" />
          <div
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              color: 'var(--fg)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {svc.image}
          </div>
          {dep?.state === 'live' && dep?.dseq && (
            <a
              href={`https://console.akash.network/deployments/${dep.dseq}`}
              target="_blank"
              rel="noreferrer"
              title={`View deployment on Akash Console (dseq ${dep.dseq})`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                fontSize: 12,
                background: 'var(--bg-elev-3)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                color: 'var(--fg)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              View on Akash Console
              <Icon name="external" size={11} color="var(--fg-muted)" />
            </a>
          )}
        </div>

        {showStatusRow && (
          <div
            className={isWorking ? 'shimmer-row' : undefined}
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              fontSize: 12.5,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--fg)' }}>
              {meta.tone === 'error' ? (
                <Icon name="x" size={12} color={toneColor} />
              ) : isWorking ? (
                <Icon
                  name="refresh"
                  size={12}
                  color={meta.tone === 'ok' ? 'var(--warn, #f5a524)' : toneColor}
                  className="spin"
                />
              ) : (
                <Icon name="box" size={12} color={toneColor} />
              )}
              <span style={{ fontWeight: 500, color: meta.tone === 'ok' ? 'var(--warn, #f5a524)' : toneColor }}>
                {meta.tone === 'ok' && !reachable ? 'Finishing up' : meta.label}
              </span>
            </span>
            <span style={{ color: 'var(--fg-muted)' }}>·</span>
            <span className={isWorking ? 'dots-anim' : undefined} style={{ color: 'var(--fg)' }}>
              {meta.tone === 'ok' && !reachable ? 'Finalizing your endpoint' : meta.body}
            </span>
          </div>
        )}

        {meta.tone === 'ok' && dep?.errorMessage && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'rgba(245,165,36,0.06)',
              border: '1px solid rgba(245,165,36,0.25)',
              borderRadius: 8,
              fontSize: 12.5,
              color: 'var(--fg)',
              wordBreak: 'break-word',
            }}
          >
            <div
              style={{
                fontWeight: 500,
                color: 'var(--warn, #f5a524)',
                marginBottom: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon name="x" size={12} color="var(--warn, #f5a524)" />
              Runtime error on first request
            </div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {dep.errorMessage}
            </div>
          </div>
        )}

        {meta.tone === 'error' && dep?.errorMessage && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'rgba(229,72,77,0.06)',
              border: '1px solid rgba(229,72,77,0.25)',
              borderRadius: 8,
              fontSize: 12.5,
              color: 'var(--fg)',
              wordBreak: 'break-word',
            }}
          >
            <div style={{ fontWeight: 500, color: toneColor, marginBottom: 4 }}>Error</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {dep.errorMessage}
            </div>
          </div>
        )}
      </div>

      {meta.tone === 'ok' && reachable && publicUrl && (
        <UseThisFunction svc={svc} url={publicUrl} routes={dep?.routes} />
      )}
    </div>
  );
}
