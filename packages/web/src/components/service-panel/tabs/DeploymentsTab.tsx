import { useEffect, useState } from 'react';
import type { DeploymentRecord, DeploymentState, FunctionRecord } from '@shared/types';
import { Icon } from '../../icons';
import { api } from '../../../lib/api';
import { UseThisFunction } from '../UseThisFunction';

const TRANSIENT_STATES: DeploymentState[] = ['pending', 'bidding', 'leased'];
const POLL_INTERVAL_MS = 2000;
const ERROR_BACKOFF_MS = 5000;
const REACHABILITY_POLL_MS = 2000;

function useDeployment(fnId: string, depId: string | undefined): DeploymentRecord | null {
  const [dep, setDep] = useState<DeploymentRecord | null>(null);

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

  return dep;
}

// Akash reports `live` as soon as the lease's manifest is accepted, but the
// ingress can take another 10–30s to actually serve traffic. Probe the URL
// from the browser until it stops erroring (any HTTP response counts — even
// 404 means the ingress resolved).
function useReachable(url: string | null): boolean {
  const [reachable, setReachable] = useState(false);

  useEffect(() => {
    setReachable(false);
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probe = async () => {
      try {
        await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        if (!cancelled) setReachable(true);
      } catch {
        if (!cancelled) timer = setTimeout(probe, REACHABILITY_POLL_MS);
      }
    };
    void probe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url]);

  return reachable;
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
      return { label: 'Queued', pillClass: 'pill', body: 'Preparing SDL…', tone: 'neutral' };
    case 'bidding':
      return {
        label: 'Bidding',
        pillClass: 'pill',
        body: dep.dseq ? `Waiting for providers · dseq ${dep.dseq}` : 'Waiting for providers…',
        tone: 'warn',
      };
    case 'leased':
      return {
        label: 'Provisioning',
        pillClass: 'pill',
        body: dep.provider
          ? `Provider ${truncate(dep.provider)} accepted · booting container`
          : 'Provider accepted · booting container',
        tone: 'warn',
      };
    case 'live':
      return { label: 'Active', pillClass: 'pill pill-ok', body: 'ready to receive traffic', tone: 'ok' };
    case 'failed':
      return {
        label: 'Failed',
        pillClass: 'pill',
        body: dep.errorMessage ?? 'Deploy failed',
        tone: 'error',
      };
    case 'closed':
      return { label: 'Closed', pillClass: 'pill', body: 'Lease closed', tone: 'neutral' };
    default:
      return { label: dep.state, pillClass: 'pill', body: '', tone: 'neutral' };
  }
}

function truncate(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-4)}`;
}

type UpdateState = 'idle' | 'submitting' | 'submitted' | 'error';

export function DeploymentsTab({ svc }: { svc: FunctionRecord }) {
  const depId = svc.deploymentId ?? svc.latestDeploymentId;
  const dep = useDeployment(svc.id, depId);
  const meta = describe(dep);
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);

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
  const reachable = useReachable(dep?.state === 'live' ? publicUrl : null);

  const toneColor =
    meta.tone === 'ok'
      ? 'var(--ok)'
      : meta.tone === 'error'
        ? 'var(--err, #e5484d)'
        : meta.tone === 'warn'
          ? 'var(--warn, #f5a524)'
          : 'var(--fg-muted)';

  const containerBorder =
    meta.tone === 'ok'
      ? 'rgba(43,215,159,0.18)'
      : meta.tone === 'error'
        ? 'rgba(229,72,77,0.25)'
        : meta.tone === 'warn'
          ? 'rgba(245,165,36,0.25)'
          : 'var(--line)';
  const containerBg =
    meta.tone === 'ok'
      ? 'rgba(43,215,159,0.04)'
      : meta.tone === 'error'
        ? 'rgba(229,72,77,0.05)'
        : meta.tone === 'warn'
          ? 'rgba(245,165,36,0.05)'
          : 'var(--bg-elev-2)';

  return (
    <div>
      {/* URL bar — only shown once Akash assigns a real public URL. */}
      {publicUrl && (
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
              title="Submit a fresh SDL on the same lease so the provider re-pulls the runner image"
              style={{
                marginLeft: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                fontSize: 12,
                background: 'var(--bg-elev-3)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                color: 'var(--fg)',
                cursor: updateState === 'submitting' ? 'progress' : 'pointer',
                opacity: updateState === 'submitting' ? 0.7 : 1,
              }}
            >
              <Icon
                name="refresh"
                size={11}
                color="var(--fg-muted)"
                className={updateState === 'submitting' ? 'spin' : undefined}
              />
              {updateState === 'submitting'
                ? 'Updating…'
                : updateState === 'submitted'
                  ? 'Update submitted'
                  : updateState === 'error'
                    ? 'Update failed'
                    : 'Update runner'}
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

      {/* Active deployment */}
      <div
        style={{
          border: `1px solid ${containerBorder}`,
          background: containerBg,
          borderRadius: 12,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            className={meta.pillClass}
            style={{
              fontSize: 10,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '4px 10px',
              color: toneColor,
              borderColor: containerBorder,
            }}
          >
            {meta.label}
          </span>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'var(--bg-elev-3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid var(--line)',
            }}
          >
            <Icon name="box" size={14} color="var(--fg-muted)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="mono"
              style={{ fontSize: 12.5, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {svc.image}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              {dep?.dseq ? `dseq ${dep.dseq}` : 'no deployment yet'}
              {dep?.provider ? ` · ${truncate(dep.provider)}` : ''}
            </div>
          </div>
        </div>

        <div
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
            {meta.tone === 'ok' ? (
              <Icon name="check" size={12} color="var(--ok)" />
            ) : meta.tone === 'error' ? (
              <Icon name="x" size={12} color={toneColor} />
            ) : (
              <Icon name="box" size={12} color={toneColor} />
            )}
            <span style={{ fontWeight: 500, color: toneColor }}>{meta.label}</span>
          </span>
          <span style={{ color: 'var(--fg-muted)' }}>·</span>
          <span style={{ color: 'var(--fg)' }}>{meta.body}</span>
        </div>

        {meta.tone === 'ok' && reachable && !dep?.errorMessage && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'rgba(43,215,159,0.06)',
              border: '1px solid rgba(43,215,159,0.2)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Icon name="check" size={14} color="var(--ok)" />
            <span style={{ fontSize: 13, color: 'var(--ok)', fontWeight: 500 }}>
              Deployment successful
            </span>
            <span style={{ color: 'var(--fg-subtle)' }}>·</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>ready to receive traffic</span>
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

        {meta.tone === 'ok' && !reachable && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'rgba(245,165,36,0.06)',
              border: '1px solid rgba(245,165,36,0.25)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Icon name="refresh" size={14} color="var(--warn, #f5a524)" className="spin" />
            <span style={{ fontSize: 13, color: 'var(--warn, #f5a524)', fontWeight: 500 }}>
              Waiting for ingress
            </span>
            <span style={{ color: 'var(--fg-subtle)' }}>·</span>
            <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
              {publicUrl ? 'probing URL until it serves traffic…' : 'lease is live, URL pending…'}
            </span>
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

      {meta.tone === 'ok' && reachable && publicUrl && <UseThisFunction svc={svc} url={publicUrl} />}
    </div>
  );
}
