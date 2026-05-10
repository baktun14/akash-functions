// Source Code tab — shows the latest version's source as a read-only editor
// and routes "Edit in builder" into the FunctionEditor modal owned by App.tsx.
//
// Fetches the latest function version on mount and re-fetches whenever
// `versionRev` (a tick from the layout context) bumps after a save/restore.

import { useEffect, useState, type ReactElement } from 'react';
import type { FunctionRecord, FunctionVersionDetail } from '@shared/types';
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

export function SourceCodeTab({ svc }: Props): ReactElement {
  const { openEditor, versionRev } = useLayout();
  const [detail, setDetail] = useState<FunctionVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getLatestVersion(svc.id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
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
  }, [svc.id, versionRev]);

  const primaryPath = detail ? pickPrimaryPath(detail.source) : 'src/index.ts';
  const primarySource = detail?.source[primaryPath] ?? '';

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
          {primaryPath}
        </span>
        <span style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>· Bun v1.3 runtime · read-only</span>
        {detail && (
          <span
            className="mono"
            style={{
              color: 'var(--fg-subtle)',
              fontSize: 11.5,
              marginLeft: 'auto',
              marginRight: 8,
            }}
            title={detail.message ?? undefined}
          >
            v{detail.id.slice(0, 7)} · {relativeTime(detail.createdAt)}
            {detail.message ? ` · "${detail.message}"` : ''}
          </span>
        )}
        <button
          className="btn btn-subtle btn-sm"
          onClick={() => openEditor(svc.id)}
          disabled={loading || !!error}
          style={{ opacity: loading || error ? 0.5 : 1 }}
        >
          <Icon name="edit" size={12} /> Edit in builder
        </button>
      </div>

      {loading && (
        <div
          className="card"
          style={{
            padding: '40px 18px',
            background: 'var(--code-surface)',
            textAlign: 'center',
            color: 'var(--fg-subtle)',
            fontSize: 13,
          }}
        >
          Loading source…
        </div>
      )}

      {error && (
        <div
          className="card"
          style={{
            padding: '20px 18px',
            background: 'rgba(229,72,77,0.05)',
            border: '1px solid rgba(229,72,77,0.4)',
            color: 'var(--err, #e5484d)',
            fontSize: 13,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <Icon name="info" size={14} />
          <span>Failed to load source: {error}</span>
        </div>
      )}

      {detail && !loading && !error && (
        <div className="card" style={{ padding: 0, background: 'var(--code-surface)', overflow: 'hidden' }}>
          <CodeEditor value={primarySource} readOnly minHeight={360} />
        </div>
      )}

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
