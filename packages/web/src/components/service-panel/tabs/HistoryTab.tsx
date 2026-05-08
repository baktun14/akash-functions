// History tab — git-like timeline of every version of a function.
//
// Each row shows: short id, relative timestamp, optional message, "latest"
// pill, deployment count, and three actions:
//   View    — expand a read-only side panel showing that version's source
//   Restore — copy the version forward as a new version (history preserved)
//   Deploy  — push the selected version to Akash (disabled when an active
//             deployment already exists, since 1 fn = 1 deployment)

import { useEffect, useState, type ReactElement } from 'react';
import type { FunctionRecord, FunctionVersionDetail, FunctionVersionSummary } from '@shared/types';
import { useLayout } from '../../../App';
import { api } from '../../../lib/api';
import { Icon } from '../../icons';
import { CodeEditor } from '../../builder/CodeEditor';

type Props = { svc: FunctionRecord };

const PRIMARY_PATH_CANDIDATES = ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx'];

function pickPrimaryPath(source: Record<string, string>): string {
  for (const candidate of PRIMARY_PATH_CANDIDATES) {
    if (candidate in source) return candidate;
  }
  return Object.keys(source)[0] ?? 'src/index.ts';
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.max(1, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

export function HistoryTab({ svc }: Props): ReactElement {
  const { versionRev, setLocal, refresh } = useLayout();
  const [versions, setVersions] = useState<FunctionVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<FunctionVersionDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [localBumpRev, setLocalBumpRev] = useState(0);

  const hasActiveDeployment = svc.status === 'online' || svc.status === 'pending';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listVersions(svc.id)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [svc.id, versionRev, localBumpRev]);

  const handleView = async (versionId: string) => {
    if (selectedId === versionId) {
      setSelectedId(null);
      setSelected(null);
      return;
    }
    setSelectedId(versionId);
    setSelected(null);
    setSelectedLoading(true);
    try {
      const detail = await api.getVersion(svc.id, versionId);
      setSelected(detail);
    } catch (err) {
      setActionError(`Failed to load version: ${(err as Error).message}`);
    } finally {
      setSelectedLoading(false);
    }
  };

  const handleRestore = async (versionId: string) => {
    if (busyVersionId) return;
    if (!confirm('Create a new version from this snapshot? History will be preserved.')) return;
    setBusyVersionId(versionId);
    setActionError(null);
    try {
      await api.restoreVersion(svc.id, versionId);
      setLocalBumpRev((r) => r + 1);
    } catch (err) {
      setActionError(`Restore failed: ${(err as Error).message}`);
    } finally {
      setBusyVersionId(null);
    }
  };

  const handleDeploy = async (versionId: string) => {
    if (busyVersionId) return;
    if (hasActiveDeployment) {
      setActionError('Close the active deployment first (Settings tab) before deploying another version.');
      return;
    }
    setBusyVersionId(versionId);
    setActionError(null);
    try {
      const dep = await api.deployVersion(svc.id, versionId);
      setLocal((cur) =>
        cur.map((s) =>
          s.id === svc.id ? { ...s, deploymentId: dep.id, latestDeploymentId: dep.id, status: 'pending' } : s
        )
      );
      refresh().catch(() => undefined);
    } catch (err) {
      setActionError(`Deploy failed: ${(err as Error).message}`);
    } finally {
      setBusyVersionId(null);
    }
  };

  const selectedPrimaryPath = selected ? pickPrimaryPath(selected.source) : 'src/index.ts';

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          marginBottom: 16,
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          fontSize: 13,
          color: 'var(--fg-muted)',
        }}
      >
        <Icon name="layers" size={14} color="var(--fg-muted)" />
        <span>Every save creates a new immutable version. Restore copies it forward — never destructive.</span>
      </div>

      {actionError && (
        <div
          style={{
            marginBottom: 14,
            padding: '10px 12px',
            background: 'rgba(229,72,77,0.06)',
            border: '1px solid rgba(229,72,77,0.4)',
            borderRadius: 10,
            fontSize: 12.5,
            color: 'var(--err, #e5484d)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <Icon name="info" size={13} />
          <span>{actionError}</span>
        </div>
      )}

      {loading && !versions && (
        <div style={{ padding: '40px 0', color: 'var(--fg-subtle)', fontSize: 13, textAlign: 'center' }}>
          Loading versions…
        </div>
      )}

      {error && (
        <div
          style={{
            padding: '20px',
            background: 'rgba(229,72,77,0.05)',
            border: '1px solid rgba(229,72,77,0.4)',
            color: 'var(--err, #e5484d)',
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          Failed to load versions: {error}
        </div>
      )}

      {versions && versions.length === 0 && !loading && (
        <div
          style={{
            padding: '40px 20px',
            textAlign: 'center',
            color: 'var(--fg-subtle)',
            fontSize: 13,
          }}
        >
          No versions yet. The first save creates version 1.
        </div>
      )}

      {versions && versions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, position: 'relative' }}>
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 11,
              top: 14,
              bottom: 14,
              width: 1,
              background: 'var(--line)',
              zIndex: 0,
            }}
          />
          {versions.map((v) => {
            const expanded = selectedId === v.id;
            const busy = busyVersionId === v.id;
            return (
              <div key={v.id} style={{ position: 'relative', zIndex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '14px 12px 14px 32px',
                    borderBottom: '1px solid var(--line)',
                    position: 'relative',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: 7,
                      top: 'calc(50% - 5px)',
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: v.isLatest ? 'var(--accent, #ff2903)' : 'var(--bg-elev-3)',
                      border: '2px solid var(--bg)',
                      boxShadow: v.isLatest ? '0 0 0 2px rgba(255,41,3,0.25)' : 'none',
                    }}
                  />
                  <span
                    className="mono"
                    style={{ color: 'var(--fg)', fontSize: 12.5, minWidth: 64 }}
                  >
                    {v.id.slice(0, 7)}
                  </span>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 12.5, minWidth: 80 }}>
                    {relativeTime(v.createdAt)}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      color: v.message ? 'var(--fg)' : 'var(--fg-subtle)',
                      fontSize: 13,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={v.message ?? undefined}
                  >
                    {v.message ?? '(no message)'}
                  </span>
                  {v.isLatest && (
                    <span
                      style={{
                        padding: '1px 7px',
                        fontSize: 9.5,
                        letterSpacing: '0.06em',
                        borderRadius: 9999,
                        border: '1px solid rgba(255,41,3,0.4)',
                        color: 'var(--accent-soft, #ff7a5c)',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                      }}
                    >
                      Latest
                    </span>
                  )}
                  {v.deploymentCount > 0 && (
                    <span
                      style={{
                        fontSize: 11.5,
                        color: 'var(--fg-subtle)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                      title={`${v.deploymentCount} deployment${v.deploymentCount === 1 ? '' : 's'}`}
                    >
                      <Icon name="rocket" size={11} /> {v.deploymentCount}
                    </span>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleView(v.id)}
                      style={{ padding: '4px 10px', fontSize: 12 }}
                    >
                      <Icon name={expanded ? 'chevronUp' : 'eye'} size={11} />
                      {expanded ? 'Hide' : 'View'}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleRestore(v.id)}
                      disabled={busy || v.isLatest}
                      title={v.isLatest ? 'Already the latest version' : undefined}
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        opacity: v.isLatest ? 0.4 : 1,
                      }}
                    >
                      <Icon name="refresh" size={11} />
                      {busy && busyVersionId === v.id ? 'Restoring…' : 'Restore'}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDeploy(v.id)}
                      disabled={busy || hasActiveDeployment}
                      title={
                        hasActiveDeployment
                          ? 'Close the active deployment (Settings) before deploying another version'
                          : undefined
                      }
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        opacity: hasActiveDeployment ? 0.4 : 1,
                      }}
                    >
                      <Icon name="play" size={11} />
                      {busy && busyVersionId === v.id ? 'Deploying…' : 'Deploy'}
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div
                    style={{
                      padding: '10px 12px 18px 32px',
                      borderBottom: '1px solid var(--line)',
                    }}
                  >
                    {selectedLoading && (
                      <div
                        style={{ padding: '24px 0', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}
                      >
                        Loading source…
                      </div>
                    )}
                    {selected && selected.id === v.id && (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            marginBottom: 8,
                          }}
                        >
                          <Icon name="file" size={12} color="var(--fg-muted)" />
                          <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                            {selectedPrimaryPath}
                          </span>
                        </div>
                        <div
                          style={{ background: '#08080B', borderRadius: 10, overflow: 'hidden' }}
                        >
                          <CodeEditor
                            value={selected.source[selectedPrimaryPath] ?? ''}
                            readOnly
                            minHeight={280}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
