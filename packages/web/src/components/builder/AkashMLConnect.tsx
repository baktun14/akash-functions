// AkashML connection card — appears in the function builder when the gpu preset
// is active. Stores the user's AkashML key locally; backend embeds it as
// AKASHML_API_KEY in the SDL on deploy.

import { useState } from 'react';
import { AkashSign, Icon } from '../icons';
import { api } from '../../lib/api';

export function AkashMLConnect() {
  const [conn, setConn] = useState(() => api.getAkashMLConnection());
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');

  const connect = () => {
    if (!keyInput.trim()) return;
    setConn(api.saveAkashMLConnection(keyInput));
    setOpen(false);
    setKeyInput('');
  };

  const disconnect = () => {
    api.clearAkashMLConnection();
    setConn(null);
  };

  return (
    <div
      style={{
        marginTop: 14,
        padding: '12px 14px',
        background: conn ? 'rgba(43,215,159,0.06)' : 'rgba(255,41,3,0.05)',
        border: `1px solid ${conn ? 'rgba(43,215,159,0.25)' : 'rgba(255,41,3,0.25)'}`,
        borderRadius: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--bg)',
            border: '1px solid var(--line-strong)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AkashSign size={14} color={conn ? 'var(--ok)' : 'var(--accent)'} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            AkashML
            <span
              className="pill"
              style={{
                padding: '1px 7px',
                fontSize: 9.5,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                borderColor: conn ? 'rgba(43,215,159,0.4)' : 'rgba(255,41,3,0.4)',
                color: conn ? 'var(--ok)' : 'var(--accent-soft)',
                fontWeight: 600,
              }}
            >
              {conn ? 'Connected' : 'Required'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
            {conn ? (
              <>
                Key{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>
                  sk_aml_…{conn.last4}
                </span>{' '}
                will be injected as{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>
                  AKASHML_API_KEY
                </span>{' '}
                at deploy time.
              </>
            ) : (
              <>
                This function calls AkashML. Connect once — your key is injected as{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>
                  AKASHML_API_KEY
                </span>{' '}
                on every deploy.
              </>
            )}
          </div>
        </div>
        {conn ? (
          <button onClick={disconnect} className="btn btn-ghost btn-sm">Disconnect</button>
        ) : (
          <button onClick={() => setOpen((o) => !o)} className="btn btn-primary btn-sm">
            Connect AkashML
          </button>
        )}
      </div>

      {open && !conn && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 10,
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 8 }}>AkashML API key</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk_aml_…"
              style={{ flex: 1 }}
              autoFocus
            />
            <button onClick={connect} className="btn btn-primary btn-sm">Save</button>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--fg-subtle)',
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="lock" size={11} />
            Stored locally. Sent to the backend only at deploy time.
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              style={{
                color: 'var(--fg-muted)',
                textDecoration: 'underline',
                marginLeft: 'auto',
              }}
            >
              Get a key →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
