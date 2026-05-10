// Full-screen function builder: code editor + side panel (prompt, presets,
// optional AkashMLConnect, inferred resources, Deploy).

import { useMemo, useState } from 'react';
import type { CodeSample, PresetId } from '@shared/types';
import { FnLogo, Icon } from '../icons';
import { PRESETS, SAMPLES } from '../../data/presets';
import { ResChip } from './ResChip';
import { AkashMLConnect } from './AkashMLConnect';
import { CodeEditor } from './CodeEditor';
import { tokensToSource } from '../../lib/api';

type Props = {
  initialPreset?: PresetId | null;
  onClose: () => void;
  onDeploy: (sample: CodeSample) => void;
};

export function FunctionBuilder({ initialPreset, onClose, onDeploy }: Props) {
  const initial: PresetId =
    initialPreset && SAMPLES[initialPreset] ? initialPreset : 'rest';
  const [preset, setPreset] = useState<PresetId>(initial);
  const [source, setSource] = useState<string>(() =>
    tokensToSource(SAMPLES[initial].code)
  );
  const [prompt, setPrompt] = useState<string>(SAMPLES[initial].prompt);
  const [name, setName] = useState<string>(SAMPLES[initial].name);
  const sample = SAMPLES[preset];
  const templateSource = useMemo(() => tokensToSource(sample.code), [sample.code]);
  const dirty =
    source !== templateSource || prompt !== sample.prompt || name !== sample.name;
  const trimmedName = name.trim();
  const canDeploy = trimmedName.length > 0;

  const onSelectPreset = (next: PresetId) => {
    if (next === preset) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const ns = SAMPLES[next];
    setPreset(next);
    setSource(tokensToSource(ns.code));
    setPrompt(ns.prompt);
    setName(ns.name);
  };

  const requestClose = () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    onClose();
  };

  return (
    <div
      className="modal-shell"
      onClick={requestClose}
      style={{ alignItems: 'stretch', justifyContent: 'stretch', padding: 0 }}
    >
      <div className="builder" onClick={(e) => e.stopPropagation()}>
        <div className="builder-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <FnLogo size={26} />
            <div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                spellCheck={false}
                aria-label="Function name"
                placeholder="Name your function"
                className="builder-name-input"
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  background: 'transparent',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  padding: '2px 6px',
                  margin: '-2px -6px',
                  outline: 'none',
                  fontFamily: 'inherit',
                  width: 'min(360px, 40vw)',
                }}
              />
              <div
                style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}
                className="mono"
              >
                ai · scaffolded by claude-haiku · 1.3s
              </div>
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={requestClose} className="btn btn-ghost btn-sm" style={{ padding: 8 }}>
            <Icon name="minimize" size={14} />
          </button>
          <button onClick={requestClose} className="btn btn-ghost btn-sm" style={{ padding: 8 }}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="builder-editor scroll" style={{ padding: 0 }}>
          <div style={{ height: '100%', padding: '16px 24px' }}>
            <CodeEditor value={source} onChange={setSource} minHeight={400} />
          </div>
        </div>

        <div className="builder-prompt scroll">
          <div className="eyebrow" style={{ marginBottom: 8 }}>Prompt</div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '12px 14px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              minHeight: 56,
            }}
          >
            <Icon
              name="sparkles"
              size={14}
              color="var(--fg-muted)"
              style={{ marginTop: 2 }}
            />
            <textarea
              className="prompt-area"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Describe your function. We'll write the code, pick a provider, and deploy it on Akash."
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                color: 'var(--fg)',
                fontSize: 13.5,
                resize: 'none',
                outline: 'none',
                fontFamily: 'inherit',
                lineHeight: 1.5,
                minHeight: 80,
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              marginTop: 6,
            }}
          >
            <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              ⌘ Enter to regenerate
            </span>
          </div>

          <div className="eyebrow" style={{ marginTop: 18, marginBottom: 8 }}>Templates</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelectPreset(p.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: preset === p.id ? 'var(--bg-elev-3)' : 'transparent',
                  border:
                    '1px solid ' +
                    (preset === p.id ? 'var(--line-strong)' : 'transparent'),
                  color: preset === p.id ? 'var(--fg)' : 'var(--fg-muted)',
                  fontSize: 13,
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'background 120ms, border-color 120ms',
                }}
              >
                <Icon name={p.icon} size={13} />
                <span style={{ flex: 1 }}>{p.label}</span>
                {p.akash && (
                  <span
                    style={{
                      padding: '1px 6px',
                      fontSize: 9,
                      letterSpacing: '0.06em',
                      borderRadius: 9999,
                      border: '1px solid rgba(255,41,3,0.4)',
                      color: 'var(--accent-soft)',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                    }}
                  >
                    Akash
                  </span>
                )}
              </button>
            ))}
          </div>

          {sample.needsAkashML && (
            <>
              <div className="eyebrow" style={{ marginTop: 18, marginBottom: 8 }}>
                Connections
              </div>
              <AkashMLConnect />
            </>
          )}

          <div className="eyebrow" style={{ marginTop: 18, marginBottom: 8 }}>
            Inferred resources
          </div>
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              borderRadius: 12,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <ResChip icon="cpu" value={sample.res.cpu} />
              <ResChip icon="cube" value={sample.res.mem} />
              <ResChip icon="gpu" value={sample.res.gpu} accent={preset === 'gpu'} />
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--fg-subtle)',
                marginTop: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span>Providers will bid on this spec</span>
              <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px' }}>
                <Icon name="edit" size={11} /> Adjust
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 18 }} />

          <button
            className="btn btn-primary"
            onClick={() => onDeploy({ ...sample, name: trimmedName, source, prompt })}
            disabled={!canDeploy}
            style={{
              width: '100%',
              marginTop: 18,
              justifyContent: 'center',
              opacity: canDeploy ? 1 : 0.5,
              cursor: canDeploy ? 'pointer' : 'not-allowed',
            }}
          >
            <Icon name="play" size={12} color="#0A0A0F" />
            Deploy function
          </button>
        </div>
      </div>
    </div>
  );
}
