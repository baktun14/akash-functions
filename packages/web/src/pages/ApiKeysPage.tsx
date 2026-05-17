// /keys — wallet-scoped API keys for protecting function routes.
// Plaintext is shown exactly once, in a one-time disclosure dialog after
// creation. Otherwise the list shows only a masked tail.

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { ApiKeyRecord, CreateApiKeyResponse } from '@shared/types';
import { Icon } from '../components/icons';
import { AsyncButton } from '../components/ui/AsyncButton';
import { api } from '../lib/api';

export function ApiKeysPage(): ReactElement {
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<CreateApiKeyResponse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .listApiKeys()
      .then((list) => {
        if (!cancelled) setKeys(list);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createApiKey(name.trim());
      setReveal(created);
      setName('');
      setKeys((cur) => [
        ...(cur ?? []),
        {
          id: created.id,
          name: created.name,
          maskedTail: created.maskedTail,
          createdAt: created.createdAt,
        },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (id: string) => {
    if (pendingDelete) return;
    setPendingDelete(id);
    try {
      await api.deleteApiKey(id);
      setKeys((cur) => (cur ?? []).filter((k) => k.id !== id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div
      className="page-in"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg)',
        overflow: 'auto',
        padding: '28px 32px 80px',
      }}
    >
      <div style={{ maxWidth: 1080, margin: '0 auto' }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em' }}>API keys</div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>
            Account-level keys used to authenticate calls to function routes you mark as
            protected. A key is shown once at creation; copy it then.
          </div>
        </div>

        <form
          onSubmit={onCreate}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 18,
            flexWrap: 'wrap',
          }}
        >
          <input
            type="text"
            placeholder="Key name (e.g. production)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            disabled={creating}
            style={{
              flex: '1 1 240px',
              minWidth: 0,
              padding: '8px 12px',
              fontSize: 13,
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'var(--bg-elev-1)',
              color: 'var(--fg)',
              outline: 'none',
            }}
          />
          <AsyncButton
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={!name.trim()}
            loading={creating}
            loadingText="Creating…"
            spinnerSize={13}
            style={{ gap: 6 }}
          >
            <Icon name="plus" size={13} />
            New API key
          </AsyncButton>
        </form>

        {error && (
          <div
            style={{
              padding: '10px 12px',
              marginBottom: 14,
              border: '1px solid var(--err)',
              borderRadius: 8,
              color: 'var(--err)',
              fontSize: 13,
              background: 'color-mix(in oklch, var(--err) 8%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        {keys === null ? (
          <div style={{ color: 'var(--fg-muted)', fontSize: 13, padding: 24, textAlign: 'center' }}>
            Loading…
          </div>
        ) : keys.length === 0 ? (
          <EmptyState />
        ) : (
          <KeysList
            keys={keys}
            pendingDelete={pendingDelete}
            onDelete={onDelete}
          />
        )}
      </div>

      {reveal && (
        <RevealDialog created={reveal} onClose={() => setReveal(null)} />
      )}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div
      style={{
        padding: '48px 24px',
        textAlign: 'center',
        color: 'var(--fg-muted)',
        border: '1px dashed var(--line)',
        borderRadius: 12,
        fontSize: 13,
      }}
    >
      No API keys yet. Create one above to authenticate calls to protected function routes.
    </div>
  );
}

function KeysList({
  keys,
  pendingDelete,
  onDelete,
}: {
  keys: ApiKeyRecord[];
  pendingDelete: string | null;
  onDelete: (id: string) => void;
}): ReactElement {
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--bg-elev-1)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.5fr 1fr 1fr 80px',
          gap: 12,
          padding: '10px 16px',
          background: 'var(--bg-elev-2)',
          borderBottom: '1px solid var(--line)',
          fontSize: 11,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          fontWeight: 600,
        }}
      >
        <div>Name</div>
        <div>Key</div>
        <div>Created</div>
        <div></div>
      </div>
      {keys.map((k) => (
        <div
          key={k.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 1fr 1fr 80px',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--line)',
            alignItems: 'center',
            fontSize: 13,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="keys" size={14} color="var(--fg-muted)" />
            <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{k.name}</span>
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 12,
              color: 'var(--fg-muted)',
            }}
          >
            akf_…{k.maskedTail}
          </div>
          <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
            {formatDate(k.createdAt)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <AsyncButton
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onDelete(k.id)}
              loading={pendingDelete === k.id}
              spinnerSize={13}
              title="Revoke key"
              style={{ padding: '4px 8px' }}
            >
              <Icon name="trash" size={13} />
            </AsyncButton>
          </div>
        </div>
      ))}
    </div>
  );
}

function RevealDialog({
  created,
  onClose,
}: {
  created: CreateApiKeyResponse;
  onClose: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard?.writeText(created.key).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999,
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 560,
          width: '100%',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--line-strong)',
          borderRadius: 14,
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="lock" size={18} color="var(--accent)" />
          <div style={{ fontSize: 16, fontWeight: 600 }}>API key created</div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          Copy this key now — for your security, it won't be shown again. Store it somewhere
          safe; you can always create a new one if you lose it.
        </div>
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            background: 'var(--code-surface, var(--bg-elev-1))',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <code
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'auto',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono, ui-monospace)',
              fontSize: 13,
              color: 'var(--fg)',
            }}
          >
            {created.key}
          </code>
          <button
            type="button"
            className="btn btn-subtle btn-sm"
            onClick={onCopy}
            style={{ gap: 6, flexShrink: 0 }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
