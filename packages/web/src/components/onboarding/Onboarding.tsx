// Onboarding — split-screen brand pitch + Akash Console API key form.

import { useState, type FormEvent } from 'react';
import type { Session } from '@shared/types';
import { AkashSign, Icon } from '../icons';
import { api } from '../../lib/api';

type Props = {
  onConnect: (session: Session) => void;
};

export function Onboarding({ onConnect }: Props) {
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [help, setHelp] = useState(false);

  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim() || loading) return;
    setLoading(true);
    try {
      const session = await api.connect(key.trim());
      onConnect(session);
    } finally {
      setLoading(false);
    }
  };

  const skip = async () => {
    const session = await api.connectSample();
    onConnect(session);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg)',
        display: 'flex',
        alignItems: 'stretch',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Left: brand */}
      <div
        style={{
          width: '42%',
          minWidth: 480,
          background: '#000',
          backgroundImage: 'url(/assets/texture-grunge.png)',
          backgroundSize: 'cover',
          position: 'relative',
          padding: '40px 48px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          color: '#fff',
          borderRight: '1px solid #1F1F26',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AkashSign size={22} color="#fff" />
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>
            Akash Functions
          </span>
          <span className="eyebrow" style={{ marginLeft: 12, color: '#86868B' }}>
            v0.1 · Beta
          </span>
        </div>

        <div>
          <div className="eyebrow" style={{ marginBottom: 24 }}>01 / Connect</div>
          <h1
            style={{
              fontSize: 64,
              lineHeight: 1.0,
              letterSpacing: '-0.025em',
              fontWeight: 700,
              margin: '0 0 24px',
            }}
          >
            Describe a function.<br />
            <span
              style={{
                fontFamily: 'Instrument Serif, serif',
                fontStyle: 'italic',
                fontWeight: 400,
                letterSpacing: '-0.01em',
              }}
            >
              Deploy
            </span>{' '}
            on Akash<span style={{ color: 'var(--accent)' }}>.</span>
          </h1>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.55,
              color: '#fff',
              maxWidth: 440,
              margin: 0,
            }}
          >
            One prompt → one container → one provider on the open cloud. We write the code, the
            network bids on it, you pay for blocks consumed.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 32, fontSize: 12 }}>
          <span className="eyebrow" style={{ color: '#fff' }}>Mainnet · v0.38</span>
          <span className="eyebrow" style={{ color: '#fff' }}>342 providers</span>
          <span className="eyebrow" style={{ color: '#fff' }}>~2.1s bid window</span>
        </div>
      </div>

      {/* Right: form */}
      <div
        className="scroll"
        style={{
          flex: 1,
          padding: '64px 80px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <div style={{ maxWidth: 520, width: '100%', margin: '0 auto' }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>Connect Akash Console</div>
          <h2
            style={{
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: '0 0 12px',
              lineHeight: 1.15,
            }}
          >
            Connect your Akash Console to deploy functions.
          </h2>
          <p
            style={{
              color: 'var(--fg-muted)',
              fontSize: 15,
              lineHeight: 1.55,
              margin: '0 0 32px',
            }}
          >
            Akash Functions uses your Console API key to deploy on your behalf. Your key is only
            forwarded to Akash — we never store it server-side.
          </p>

          <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 28px' }}>
            <li className="numbered-step">
              <span className="num">01</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  Open{' '}
                  <span className="mono" style={{ color: 'var(--fg)' }}>
                    console.akash.network
                  </span>{' '}
                  → Settings → API Keys.
                </div>
                <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                  Or click{' '}
                  <a
                    href="#"
                    onClick={(e) => e.preventDefault()}
                    style={{
                      color: 'var(--fg)',
                      textDecoration: 'underline',
                      textUnderlineOffset: 3,
                    }}
                  >
                    Get a key ↗
                  </a>
                </div>
              </div>
            </li>
            <li className="numbered-step">
              <span className="num">02</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  Click <span className="mono">New API key</span>, name it{' '}
                  <span className="mono">Akash Functions</span>.
                </div>
                <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                  Scope to{' '}
                  <span className="mono" style={{ color: 'var(--fg)' }}>
                    Deployments: read/write
                  </span>
                  . That's all we need.
                </div>
              </div>
            </li>
            <li className="numbered-step">
              <span className="num">03</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  Copy the key (it's shown once) and paste below.
                </div>
                <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                  Stored locally in your browser. Forwarded to Akash on each request.
                </div>
              </div>
            </li>
          </ol>

          <form onSubmit={handle}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--fg-muted)',
                marginBottom: 8,
              }}
            >
              <span>Akash Console API key</span>
              <button
                type="button"
                onClick={() => setHelp((v) => !v)}
                style={{
                  width: 16,
                  height: 16,
                  padding: 0,
                  border: '1px solid var(--line-strong)',
                  borderRadius: 9999,
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                }}
                aria-label="What can this key do?"
              >
                ?
              </button>
            </label>

            {help && (
              <div
                className="fade-up"
                style={{
                  padding: 12,
                  borderRadius: 10,
                  marginBottom: 12,
                  background: 'var(--bg-elev-2)',
                  border: '1px solid var(--line)',
                  fontSize: 12.5,
                  color: 'var(--fg-muted)',
                  lineHeight: 1.55,
                }}
              >
                A{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>
                  Deployments: read/write
                </span>{' '}
                key can create, update, and close deployments on your account. It cannot move funds
                or change wallet settings. Revoke any time at{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>
                  console.akash.network → API Keys
                </span>
                .
              </div>
            )}

            <div style={{ position: 'relative', marginBottom: 14 }}>
              <input
                type={show ? 'text' : 'password'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk_console_••••••••••••••••••••••••••••"
                className="input mono"
                style={{ paddingRight: 80, fontSize: 13, paddingTop: 12, paddingBottom: 12 }}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  padding: '6px 10px',
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  fontSize: 12,
                }}
              >
                <Icon name={show ? 'eyeOff' : 'eye'} size={14} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="submit"
                disabled={!key.trim() || loading}
                className="btn btn-primary btn-lg"
              >
                {loading ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" className="spin">
                      <circle cx="12" cy="12" r="9" stroke="rgba(0,0,0,0.15)" strokeWidth="3" fill="none" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="#0A0A0F" strokeWidth="3" fill="none" strokeLinecap="round" />
                    </svg>
                    Validating…
                  </>
                ) : (
                  <>
                    Validate &amp; Continue <Icon name="arrowRight" size={14} />
                  </>
                )}
              </button>
              <a
                href="#"
                onClick={(e) => e.preventDefault()}
                className="btn btn-ghost btn-lg"
                rel="noreferrer"
              >
                Get a key <Icon name="external" size={13} />
              </a>
              <button
                type="button"
                onClick={skip}
                style={{
                  marginLeft: 'auto',
                  padding: '8px 4px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--fg-muted)',
                  fontSize: 13,
                  textDecoration: 'underline',
                  textUnderlineOffset: 3,
                }}
              >
                Skip — explore with sample data
              </button>
            </div>

            <div
              style={{
                marginTop: 28,
                paddingTop: 20,
                borderTop: '1px solid var(--line)',
                display: 'flex',
                gap: 24,
                fontSize: 12,
                color: 'var(--fg-subtle)',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="lock" size={12} /> Forwarded over TLS
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="check" size={12} /> Deployments scope
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="refresh" size={12} /> Revoke any time
              </span>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
