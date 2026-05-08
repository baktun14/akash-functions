// Edit-existing-function flow. Sibling of FunctionBuilder, but stripped of the
// create-only chrome (preset list, prompt regen, AkashML, ResChips). Saving
// always creates a new function_versions row server-side; the user can also
// "Save & Deploy" to push the new version to Akash in one click.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DeploymentRecord, FunctionVersionDetail } from '@shared/types';
import { api } from '../../lib/api';
import { Icon } from '../icons';
import { CodeEditor } from './CodeEditor';

type Props = {
  functionId: string;
  functionName: string;
  initialDetail: FunctionVersionDetail;
  hasActiveDeployment: boolean;
  onClose: () => void;
  onSaved: (newVersionId: string) => void;
  onSavedAndDeployed: (newVersionId: string, deployment: DeploymentRecord) => void;
};

const PRIMARY_PATH_CANDIDATES = ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx'];

function pickPrimaryPath(source: Record<string, string>): string {
  for (const candidate of PRIMARY_PATH_CANDIDATES) {
    if (candidate in source) return candidate;
  }
  // Fallback: first key in insertion order.
  return Object.keys(source)[0] ?? 'src/index.ts';
}

export function FunctionEditor({
  functionId,
  functionName,
  initialDetail,
  hasActiveDeployment,
  onClose,
  onSaved,
  onSavedAndDeployed,
}: Props): ReactElement {
  const primaryPath = useMemo(() => pickPrimaryPath(initialDetail.source), [initialDetail.source]);
  const initialPrimaryValue = initialDetail.source[primaryPath] ?? '';
  const [source, setSource] = useState<string>(initialPrimaryValue);
  const [message, setMessage] = useState<string>('');
  const [inflight, setInflight] = useState<'save' | 'deploy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = source !== initialPrimaryValue || message.length > 0;

  // Confirm-on-close if the user has unsaved edits.
  const requestClose = () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    onClose();
  };

  // Esc closes the modal (with the same dirty guard).
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const buildSourceMap = (): Record<string, string> => ({
    ...initialDetail.source,
    [primaryPath]: source,
  });

  const handleSave = async () => {
    if (inflight) return;
    setInflight('save');
    setError(null);
    try {
      const result = await api.updateCode(functionId, {
        source: buildSourceMap(),
        message: message.trim() || undefined,
      });
      onSaved(result.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInflight(null);
    }
  };

  const handleSaveAndDeploy = async () => {
    if (inflight) return;
    if (hasActiveDeployment) {
      setError(
        'This function already has an active deployment. Close it from Settings before deploying a new version.'
      );
      return;
    }
    setInflight('deploy');
    setError(null);
    try {
      const result = await api.updateCode(functionId, {
        source: buildSourceMap(),
        message: message.trim() || undefined,
      });
      const dep = await api.deployVersion(functionId);
      onSavedAndDeployed(result.id, dep);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInflight(null);
    }
  };

  const otherFileCount = Object.keys(initialDetail.source).length - 1;

  return (
    <div
      className="modal-shell"
      onClick={requestClose}
      style={{ alignItems: 'stretch', justifyContent: 'stretch', padding: 0 }}
    >
      <div className="builder" onClick={(e) => e.stopPropagation()}>
        <div className="builder-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Icon name="edit" size={18} color="var(--fg-muted)" />
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
                Edit {functionName}
              </div>
              <div
                style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}
                className="mono"
              >
                editing version {initialDetail.id.slice(0, 7)} ·{' '}
                {initialDetail.message ?? 'no message'}
              </div>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={requestClose}
            className="btn btn-ghost btn-sm"
            style={{ padding: 8 }}
            aria-label="Close editor"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="builder-editor scroll" style={{ padding: 0 }}>
          <div style={{ height: '100%', padding: '16px 24px' }}>
            <CodeEditor value={source} onChange={setSource} minHeight={400} />
          </div>
        </div>

        <div className="builder-prompt scroll">
          <div className="eyebrow" style={{ marginBottom: 8 }}>File</div>
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Icon name="file" size={13} color="var(--fg-muted)" />
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--fg)' }}>
              {primaryPath}
            </span>
          </div>
          {otherFileCount > 0 && (
            <div
              style={{
                marginTop: 8,
                padding: '8px 12px',
                background: 'var(--bg-elev-2)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                fontSize: 11.5,
                color: 'var(--fg-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon name="info" size={11} />
              +{otherFileCount} other file{otherFileCount === 1 ? '' : 's'} preserved on save
            </div>
          )}

          <div className="eyebrow" style={{ marginTop: 18, marginBottom: 8 }}>
            Commit message
          </div>
          <input
            type="text"
            className="prompt-area"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Updated ${primaryPath}`}
            maxLength={200}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              color: 'var(--fg)',
              fontSize: 13,
              outline: 'none',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
          <div
            style={{
              fontSize: 11,
              color: 'var(--fg-subtle)',
              marginTop: 6,
              textAlign: 'right',
            }}
            className="mono"
          >
            {message.length}/200
          </div>

          {error && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                background: 'rgba(229,72,77,0.08)',
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
              <span>{error}</span>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 18 }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
            <button
              className="btn btn-subtle"
              onClick={requestClose}
              disabled={!!inflight}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              Cancel
            </button>
            <button
              className="btn btn-subtle"
              onClick={handleSave}
              disabled={!!inflight || !dirty}
              style={{ width: '100%', justifyContent: 'center', opacity: !dirty ? 0.5 : 1 }}
            >
              <Icon name="check" size={12} />
              {inflight === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSaveAndDeploy}
              disabled={!!inflight || hasActiveDeployment}
              title={
                hasActiveDeployment
                  ? 'Close the active deployment from Settings before deploying a new version'
                  : undefined
              }
              style={{
                width: '100%',
                justifyContent: 'center',
                opacity: hasActiveDeployment ? 0.5 : 1,
              }}
            >
              <Icon name="play" size={12} color="#0A0A0F" />
              {inflight === 'deploy' ? 'Deploying…' : 'Save & Deploy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
