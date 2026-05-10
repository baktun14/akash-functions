import { useEffect, useMemo, useState } from 'react';
import type { FunctionRecord, FunctionVariableSummary } from '@shared/types';
import { validateVariableKey } from '@shared/reserved-vars';
import { api } from '../../../lib/api';
import { Icon } from '../../icons';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; variables: FunctionVariableSummary[]; revision: number };

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; key: string }
  | { kind: 'delete'; key: string };

const SDL_INJECTED: [string, string][] = [
  ['FUNCTION_ID', 'opaque function identifier'],
  ['INITIAL_VERSION_ID', 'version booted on first start'],
  ['BACKEND_BASE_URL', 'host the runner calls back to'],
  ['RUNNER_TOKEN', 'HMAC scoped to this function'],
  ['POLL_INTERVAL_MS', 'cadence for hot-reload polling'],
  ['PORT', 'port the user code listens on (3000)'],
];

export function VariablesTab({ svc }: { svc: FunctionRecord }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [showInjected, setShowInjected] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const refresh = async () => {
    try {
      const res = await api.listVariables(svc.id);
      setLoad({ status: 'ok', variables: res.variables, revision: res.variablesRevision });
    } catch (err) {
      setLoad({ status: 'error', message: (err as Error).message });
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc.id]);

  const isLive = svc.status === 'online';

  const onPut = (saved: { key: string; updatedAt: string; variablesRevision: number }) => {
    setLoad((prev) => {
      if (prev.status !== 'ok') return prev;
      const others = prev.variables.filter((v) => v.key !== saved.key);
      const next = [...others, { key: saved.key, updatedAt: saved.updatedAt }].sort((a, b) =>
        a.key.localeCompare(b.key)
      );
      return { status: 'ok', variables: next, revision: saved.variablesRevision };
    });
    setDialog(null);
  };

  const onDeleted = (key: string, revision: number) => {
    setLoad((prev) =>
      prev.status === 'ok'
        ? { status: 'ok', variables: prev.variables.filter((v) => v.key !== key), revision }
        : prev
    );
    setDialog(null);
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 18,
        }}
      >
        <div>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Service variables
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4 }}>
            Encrypted at rest. Saved values are never shown again — to change one, overwrite it.
          </div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setDialog({ kind: 'create' })}
        >
          <Icon name="plus" size={12} color="#0A0A0F" /> New variable
        </button>
      </div>

      {load.status === 'loading' && (
        <div className="empty-state">
          <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Loading variables…</div>
        </div>
      )}

      {load.status === 'error' && (
        <div className="empty-state">
          <div style={{ fontSize: 14, color: 'var(--err, #e5484d)', marginTop: 4 }}>
            Failed to load variables
          </div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', maxWidth: 380 }}>
            {load.message}
          </div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {load.status === 'ok' && load.variables.length === 0 && (
        <div className="empty-state">
          <Icon name="cube" size={20} color="var(--fg-subtle)" />
          <div style={{ fontSize: 14, color: 'var(--fg)', marginTop: 4 }}>
            No environment variables yet.
          </div>
          <div style={{ fontSize: 13, maxWidth: 380 }}>
            Add secrets like API keys or database URLs. They're injected into{' '}
            <span className="mono">process.env</span> when your function starts.
          </div>
        </div>
      )}

      {load.status === 'ok' && load.variables.length > 0 && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-elev-2)',
            overflow: 'hidden',
          }}
        >
          {load.variables.map((v, i) => (
            <div
              key={v.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1.4fr auto',
                padding: '10px 14px',
                borderTop: i ? '1px solid var(--line)' : 'none',
                alignItems: 'center',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ color: 'var(--fg)' }}>{v.key}</span>
              <span
                className="mono"
                aria-label="value masked"
                style={{ color: 'var(--fg-subtle)', letterSpacing: 2 }}
              >
                ••••••••••••
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDialog({ kind: 'edit', key: v.key })}
                >
                  Replace
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDialog({ kind: 'delete', key: v.key })}
                  aria-label={`Delete ${v.key}`}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setShowInjected((v) => !v)}
        style={{
          marginTop: 18,
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
        <Icon name={showInjected ? 'chevronDown' : 'chevronRight'} size={14} color="var(--fg-muted)" />
        <span style={{ fontSize: 13 }}>{SDL_INJECTED.length} variables added by Akash</span>
        <span
          className="mono"
          style={{ fontSize: 11, color: 'var(--fg-subtle)', marginLeft: 'auto' }}
        >
          system · read-only · not stored
        </span>
      </button>

      {showInjected && (
        <div
          className="fade-up"
          style={{
            marginTop: 8,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-elev-2)',
          }}
        >
          {SDL_INJECTED.map(([k, desc], i) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr 24px',
                padding: '10px 14px',
                borderTop: i ? '1px solid var(--line)' : 'none',
                alignItems: 'center',
                gap: 10,
                fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ color: 'var(--fg)' }}>{k}</span>
              <span style={{ color: 'var(--fg-muted)' }}>{desc}</span>
              <Icon name="lock" size={12} color="var(--fg-subtle)" />
            </div>
          ))}
        </div>
      )}

      {dialog && load.status === 'ok' && dialog.kind !== 'delete' && (
        <VariableEditor
          fnId={svc.id}
          mode={dialog}
          existingKeys={new Set(load.variables.map((v) => v.key))}
          isLive={isLive}
          onClose={() => setDialog(null)}
          onSaved={onPut}
        />
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmDelete
          name={dialog.key}
          isLive={isLive}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const res = await api.deleteVariable(svc.id, dialog.key);
            onDeleted(res.key, res.variablesRevision);
          }}
        />
      )}
    </div>
  );
}

function VariableEditor({
  mode,
  existingKeys,
  isLive,
  fnId,
  onClose,
  onSaved,
}: {
  mode: { kind: 'create' } | { kind: 'edit'; key: string };
  existingKeys: Set<string>;
  isLive: boolean;
  fnId: string;
  onClose: () => void;
  onSaved: (saved: { key: string; updatedAt: string; variablesRevision: number }) => void;
}) {
  const [key, setKey] = useState(mode.kind === 'edit' ? mode.key : '');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = useMemo(() => {
    if (key.length === 0) return null;
    const shapeError = validateVariableKey(key);
    if (shapeError) return shapeError;
    if (mode.kind === 'create' && existingKeys.has(key)) {
      return `${key} already exists. Use Replace from the list to overwrite.`;
    }
    return null;
  }, [key, mode, existingKeys]);

  const canSubmit = !submitting && validation === null && key.length > 0 && value.length > 0;

  const submit = async () => {
    setError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const saved = await api.putVariable(fnId, key, value);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={mode.kind === 'edit' ? `Replace ${mode.key}` : 'New variable'} onClose={onClose}>
      <label style={fieldLabelStyle}>
        Key
        <input
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="MY_API_KEY"
          disabled={mode.kind === 'edit'}
          autoFocus={mode.kind === 'create'}
          spellCheck={false}
          maxLength={128}
          style={{ ...fieldInputStyle, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
        />
        {validation && (
          <div style={{ fontSize: 11.5, color: 'var(--err, #e5484d)', marginTop: 6 }}>{validation}</div>
        )}
      </label>

      <label style={{ ...fieldLabelStyle, marginTop: 16 }}>
        Value
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            mode.kind === 'edit'
              ? 'Paste new value. The previous value is gone — overwriting cannot be undone.'
              : 'Paste secret here. It will be encrypted at rest and never shown again.'
          }
          rows={4}
          spellCheck={false}
          autoFocus={mode.kind === 'edit'}
          style={{
            ...fieldInputStyle,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            resize: 'vertical',
            minHeight: 80,
          }}
        />
      </label>

      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '12px 0 0' }}>
        {isLive
          ? 'Your live deployment will pick up this change in ~10 seconds.'
          : 'Saved. Will be applied on the next deployment.'}
      </p>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: '1px solid var(--err, #e5484d)',
            borderRadius: 8,
            color: 'var(--err, #e5484d)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={!canSubmit}>
          {submitting ? 'Saving…' : mode.kind === 'edit' ? 'Replace' : 'Save'}
        </button>
      </div>
    </ModalShell>
  );
}

function ConfirmDelete({
  name,
  isLive,
  onCancel,
  onConfirm,
}: {
  name: string;
  isLive: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };
  return (
    <ModalShell title={`Delete ${name}`} onClose={onCancel}>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: 0 }}>
        {isLive
          ? `Your live deployment will restart with ${name} removed within ~10 seconds.`
          : `${name} will be removed from this function.`}
      </p>
      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: '1px solid var(--err, #e5484d)',
            borderRadius: 8,
            color: 'var(--err, #e5484d)',
            fontSize: 12.5,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={submitting}>
          {submitting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-shell" onClick={onClose}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(520px, 100%)', padding: 20 }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: 4 }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  color: 'var(--fg-muted)',
  fontWeight: 500,
};

const fieldInputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '8px 10px',
  background: 'var(--bg-elev-2)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  color: 'var(--fg)',
  fontSize: 13,
  outline: 'none',
};

