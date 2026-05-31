// Edit-existing-function flow. Sibling of FunctionBuilder, but stripped of the
// create-only chrome (preset list, prompt regen, AkashML, ResChips). Saving
// always creates a new function_versions row server-side.
//
// When there's no active deployment, the user sees two buttons: "Save" (draft)
// and "Save & Deploy" (spin up the first pod). When a deployment is already
// live, the runner hot-reloads new versions automatically, so we collapse to a
// single "Save & deploy" button and surface a "pushing to live…" indicator
// during the propagation window.

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { DeploymentRecord, FunctionKind, FunctionVersionDetail } from '@shared/types';
import { api } from '../../lib/api';
import { primaryEntryPath, rebuildSourceMap } from '../../lib/entryPath';
import { detectStartupIssue } from '../../lib/codeChecks';
import { Icon } from '../icons';
import { AsyncButton } from '../ui/AsyncButton';
import { AgentCTACard } from './AgentCTACard';
import { CodeEditor } from './CodeEditor';
import { useRegisterActiveEditor } from '../agent/ActiveEditorContext';

type Props = {
  functionId: string;
  functionName: string;
  /** Function kind — decides the entry filename on save. Python jobs run
   *  main.py; TS services run src/index.ts(x). Getting this wrong drops the
   *  entry file and the runner can't find the program. */
  kind: FunctionKind;
  initialDetail: FunctionVersionDetail;
  hasActiveDeployment: boolean;
  onClose: () => void;
  onSaved: (newVersionId: string) => void;
  onSavedAndDeployed: (newVersionId: string, deployment: DeploymentRecord) => void;
  /** Agent chat panel — when present, switches the editor to a 3-column grid. */
  agentSlot?: ReactNode;
  /** Whether the agent panel is currently open. Controls whether the in-editor
   *  CTA card is shown (hidden when the panel is already docked). */
  agentOpen?: boolean;
  /** Opens the agent panel; the Layout docks it into the editor's grid. */
  onOpenAgent?: () => void;
  /** Invoked by the "Quick fix with agent" affordance when source has a known
   *  startup issue (e.g. double server-start). The host opens the agent panel
   *  and queues the corrective prompt for auto-send. */
  onAgentFix?: (prompt: string) => void;
};

// Matches the runner's default poll cadence + small buffer for the swap.
const PUSH_LIVE_WINDOW_MS = 12_000;

export function FunctionEditor({
  functionId,
  functionName,
  kind,
  initialDetail,
  hasActiveDeployment,
  onClose,
  onSaved,
  onSavedAndDeployed,
  agentSlot,
  agentOpen,
  onOpenAgent,
  onAgentFix,
}: Props): ReactElement {
  const primaryPath = useMemo(
    () => primaryEntryPath(kind, initialDetail.source),
    [kind, initialDetail.source]
  );
  const initialPrimaryValue = initialDetail.source[primaryPath] ?? '';
  const [source, setSource] = useState<string>(initialPrimaryValue);
  const [message, setMessage] = useState<string>('');

  useRegisterActiveEditor({
    mode: 'edit',
    functionId,
    functionName,
    primaryPath,
    currentSource: source,
    applySource: setSource,
  });
  const [inflight, setInflight] = useState<'save' | 'deploy' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<
    | { kind: 'pushing'; versionShort: string }
    | { kind: 'live'; versionShort: string }
    | null
  >(null);
  const dirty = source !== initialPrimaryValue || message.length > 0;
  const startupIssue = useMemo(() => detectStartupIssue(source), [source]);

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

  // Write the edit back under the correct entry filename for the kind: TS
  // services flip .ts<->.tsx by JSX; python jobs keep a runner-probed .py entry
  // (and a version mis-saved under a TS path heals back to main.py). The old
  // primary key is dropped so we never ship two entries. See ./entryPath.
  const buildSourceMap = (): Record<string, string> =>
    rebuildSourceMap(kind, initialDetail.source, primaryPath, source);

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
      // When a pod is already running, the runner will pick this version up on
      // its next poll. Surface that as a transient indicator so the user knows
      // the URL is updating without having to refresh.
      if (hasActiveDeployment) {
        const versionShort = result.id.slice(0, 7);
        setLiveStatus({ kind: 'pushing', versionShort });
        window.setTimeout(() => {
          setLiveStatus({ kind: 'live', versionShort });
        }, PUSH_LIVE_WINDOW_MS);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInflight(null);
    }
  };

  const handleSaveAndDeploy = async () => {
    if (inflight) return;
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
      <div
        className={agentSlot ? 'builder with-agent' : 'builder'}
        onClick={(e) => e.stopPropagation()}
      >
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
            {startupIssue && (
              <div className="editor-warn" role="alert">
                <Icon name="info" size={13} />
                <span style={{ flex: 1, lineHeight: 1.5 }}>{startupIssue.message}</span>
                {onAgentFix && (
                  <button
                    type="button"
                    onClick={() => onAgentFix(startupIssue.agentPrompt)}
                    className="btn btn-primary btn-sm editor-warn-action"
                  >
                    <Icon name="sparkles" size={11} />
                    Quick fix with agent
                  </button>
                )}
              </div>
            )}
            <CodeEditor value={source} onChange={setSource} minHeight={400} />
          </div>
        </div>

        <div className="builder-prompt scroll">
          {!agentOpen && onOpenAgent && (
            <div style={{ marginBottom: 18 }}>
              <AgentCTACard
                onOpen={onOpenAgent}
                copy="Ask the agent to modify this function — bugfix, refactor, or add a route."
              />
            </div>
          )}
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

          {liveStatus && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                background: 'rgba(80,200,120,0.06)',
                border: '1px solid rgba(80,200,120,0.4)',
                borderRadius: 10,
                fontSize: 12.5,
                color: 'var(--fg)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon name={liveStatus.kind === 'pushing' ? 'info' : 'check'} size={13} />
              <span>
                {liveStatus.kind === 'pushing'
                  ? `Pushing v${liveStatus.versionShort} to live…`
                  : `Live on v${liveStatus.versionShort}`}
              </span>
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
            {hasActiveDeployment ? (
              <AsyncButton
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!dirty}
                loading={inflight === 'save'}
                loadingText="Saving…"
                spinnerSize={12}
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  opacity: !dirty ? 0.5 : 1,
                }}
                title="Save a new version. The running pod will hot-reload it within ~10s."
              >
                <Icon name="play" size={12} color="#0A0A0F" />
                Save & deploy
              </AsyncButton>
            ) : (
              <>
                <AsyncButton
                  className="btn btn-subtle"
                  onClick={handleSave}
                  disabled={!!inflight || !dirty}
                  loading={inflight === 'save'}
                  loadingText="Saving…"
                  spinnerSize={12}
                  style={{ width: '100%', justifyContent: 'center', opacity: !dirty ? 0.5 : 1 }}
                >
                  <Icon name="check" size={12} />
                  Save
                </AsyncButton>
                <AsyncButton
                  className="btn btn-primary"
                  onClick={handleSaveAndDeploy}
                  disabled={!!inflight}
                  loading={inflight === 'deploy'}
                  loadingText="Deploying…"
                  spinnerSize={12}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Icon name="play" size={12} color="#0A0A0F" />
                  Save & Deploy
                </AsyncButton>
              </>
            )}
          </div>
        </div>
        {agentSlot && <div className="builder-agent-slot">{agentSlot}</div>}
      </div>
    </div>
  );
}
