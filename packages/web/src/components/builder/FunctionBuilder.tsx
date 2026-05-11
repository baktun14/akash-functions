// Full-screen function builder: code editor + side panel (prompt, presets,
// optional AkashMLConnect, inferred or custom resources, Deploy).
//
// Resources start as the preset's "inferred" defaults (read-only chips). The
// Adjust button toggles to an editable form (CPU/RAM/Storage/GPU) and, once
// the user has customized anything, a live feasibility indicator polls the
// backend for "how many online+audited providers can fulfill this spec?".
// We let the user deploy with 0 matches (providers come online dynamically)
// but require an explicit confirm so they don't sit in `bidding` by surprise.

import { useMemo, useState } from 'react';
import type {
  CodeSample,
  GpuSpec,
  PresetId,
  ResourceRequest,
} from '@shared/types';
import { FnLogo, Icon } from '../icons';
import { PRESETS, SAMPLES } from '../../data/presets';
import { ResChip } from './ResChip';
import { AkashMLConnect } from './AkashMLConnect';
import { CodeEditor } from './CodeEditor';
import { tokensToSource } from '../../lib/api';
import { useGpuModels } from '../../lib/use-gpu-models';
import { useFeasibility } from '../../lib/use-feasibility';

type Props = {
  initialPreset?: PresetId | null;
  onClose: () => void;
  /** customResources is sent only when the user opened Adjust and edited the form. */
  onDeploy: (sample: CodeSample, customResources?: ResourceRequest) => void;
};

type SizeUnit = 'Mi' | 'Gi';

type ResourceForm = {
  cpu: string;
  memoryValue: number;
  memoryUnit: SizeUnit;
  storageValue: number;
  storageUnit: SizeUnit;
  gpu: GpuSpec | null;
};

const CPU_OPTIONS = ['0.25', '0.5', '1', '2', '4', '8'];

function parseDefaultForm(sample: CodeSample): ResourceForm {
  const cpu = sample.res.cpu.match(/[\d.]+/)?.[0] ?? '0.5';
  const memMatch = sample.res.mem.match(/(\d+)\s*(Mi|Gi)/i);
  return {
    cpu,
    memoryValue: memMatch ? parseInt(memMatch[1]!, 10) : 512,
    memoryUnit: (memMatch?.[2]?.replace(/^\w/, (c) => c.toUpperCase()) ?? 'Mi') as SizeUnit,
    storageValue: 1,
    storageUnit: 'Gi',
    gpu: null,
  };
}

function toResourceRequest(form: ResourceForm): ResourceRequest {
  return {
    cpu: form.cpu,
    memory: `${form.memoryValue}${form.memoryUnit}`,
    storage: `${form.storageValue}${form.storageUnit}`,
    gpu: form.gpu ?? undefined,
  };
}

export function FunctionBuilder({ initialPreset, onClose, onDeploy }: Props) {
  const initial: PresetId =
    initialPreset && SAMPLES[initialPreset] ? initialPreset : 'rest';
  const [preset, setPreset] = useState<PresetId>(initial);
  const [source, setSource] = useState<string>(() =>
    tokensToSource(SAMPLES[initial].code)
  );
  const [prompt, setPrompt] = useState<string>(SAMPLES[initial].prompt);
  const [name, setName] = useState<string>(SAMPLES[initial].name);

  // Adjust panel: closed by default so casual users see the preset chips, can
  // open inline to override. customRes === null means "use the preset defaults"
  // and skips both the feasibility call and the customResources payload.
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [customRes, setCustomRes] = useState<ResourceForm | null>(null);
  const [confirmingNoMatch, setConfirmingNoMatch] = useState(false);

  const sample = SAMPLES[preset];
  const templateSource = useMemo(() => tokensToSource(sample.code), [sample.code]);
  const dirty =
    source !== templateSource || prompt !== sample.prompt || name !== sample.name;
  const trimmedName = name.trim();
  const canDeploy = trimmedName.length > 0;

  const effectiveForm = customRes ?? parseDefaultForm(sample);
  const customResourceRequest: ResourceRequest | null = customRes
    ? toResourceRequest(customRes)
    : null;

  const gpuModelsState = useGpuModels();
  const feasibility = useFeasibility(customResourceRequest, customRes !== null);

  const updateForm = (patch: Partial<ResourceForm>) => {
    setCustomRes((cur) => ({ ...(cur ?? parseDefaultForm(sample)), ...patch }));
    setConfirmingNoMatch(false);
  };

  const onSelectPreset = (next: PresetId) => {
    if (next === preset) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const ns = SAMPLES[next];
    setPreset(next);
    setSource(tokensToSource(ns.code));
    setPrompt(ns.prompt);
    setName(ns.name);
    // Re-seed the form to the new preset's defaults so the user isn't stuck
    // with "0.25 vCPU" they picked under rest after switching to gpu.
    setCustomRes(null);
    setConfirmingNoMatch(false);
  };

  const onDeployClick = () => {
    if (!canDeploy) return;
    // If the user customized resources AND 0 providers match, require a
    // second click before we submit. Otherwise the bid pool will be empty
    // and the deployment sits in `bidding` until something comes online.
    if (
      customResourceRequest &&
      feasibility.status === 'ready' &&
      feasibility.result.matchingProviders === 0 &&
      !confirmingNoMatch
    ) {
      setConfirmingNoMatch(true);
      return;
    }
    onDeploy(
      { ...sample, name: trimmedName, source, prompt },
      customResourceRequest ?? undefined
    );
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
            {customRes ? 'Custom resources' : 'Inferred resources'}
          </div>
          <div
            style={{
              padding: '12px 14px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
              borderRadius: 12,
            }}
          >
            {!adjustOpen ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <ResChip
                  icon="cpu"
                  value={customRes ? `${customRes.cpu} vCPU` : sample.res.cpu}
                />
                <ResChip
                  icon="cube"
                  value={
                    customRes
                      ? `${customRes.memoryValue} ${customRes.memoryUnit}`
                      : sample.res.mem
                  }
                />
                <ResChip
                  icon="storage"
                  value={
                    customRes
                      ? `${customRes.storageValue} ${customRes.storageUnit}`
                      : '1 Gi'
                  }
                />
                <ResChip
                  icon="gpu"
                  value={
                    customRes
                      ? customRes.gpu
                        ? `${customRes.gpu.vendor} ${customRes.gpu.model}`
                        : 'no GPU'
                      : sample.res.gpu
                  }
                  accent={preset === 'gpu' || !!customRes?.gpu}
                />
              </div>
            ) : (
              <ResourceFormEditor
                form={effectiveForm}
                onChange={updateForm}
                gpuModels={gpuModelsState}
              />
            )}

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
              <FeasibilityLine
                active={customRes !== null}
                state={feasibility}
              />
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: '3px 8px' }}
                onClick={() => setAdjustOpen((v) => !v)}
              >
                <Icon name={adjustOpen ? 'check' : 'edit'} size={11} />
                {adjustOpen ? ' Done' : ' Adjust'}
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 18 }} />

          <button
            className="btn btn-primary"
            onClick={onDeployClick}
            disabled={!canDeploy}
            style={{
              width: '100%',
              marginTop: 18,
              justifyContent: 'center',
              opacity: canDeploy ? 1 : 0.5,
              cursor: canDeploy ? 'pointer' : 'not-allowed',
              background: confirmingNoMatch ? 'var(--accent-soft)' : undefined,
            }}
          >
            <Icon name="play" size={12} color="#0A0A0F" />
            {confirmingNoMatch ? 'Deploy anyway' : 'Deploy function'}
          </button>
          {confirmingNoMatch && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--fg-subtle)',
                marginTop: 6,
                textAlign: 'center',
              }}
            >
              No providers currently match — your deployment will sit in
              <span style={{ fontFamily: 'monospace' }}> bidding </span>
              until one comes online.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Resource editor ──────────────────────────────────────────────────

type ResourceFormEditorProps = {
  form: ResourceForm;
  onChange: (patch: Partial<ResourceForm>) => void;
  gpuModels: ReturnType<typeof useGpuModels>;
};

function ResourceFormEditor({ form, onChange, gpuModels }: ResourceFormEditorProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Row label="CPU">
        <ChipRow
          options={CPU_OPTIONS}
          value={form.cpu}
          onSelect={(v) => onChange({ cpu: v })}
          suffix="vCPU"
        />
      </Row>

      <Row label="Memory">
        <SizeField
          value={form.memoryValue}
          unit={form.memoryUnit}
          onValue={(v) => onChange({ memoryValue: v })}
          onUnit={(u) => onChange({ memoryUnit: u })}
        />
      </Row>

      <Row label="Storage">
        <SizeField
          value={form.storageValue}
          unit={form.storageUnit}
          onValue={(v) => onChange({ storageValue: v })}
          onUnit={(u) => onChange({ storageUnit: u })}
        />
      </Row>

      <Row label="GPU">
        <GpuSelect
          value={form.gpu}
          onChange={(gpu) => onChange({ gpu })}
          state={gpuModels}
        />
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 26 }}>
      <div
        style={{
          width: 60,
          fontSize: 11,
          color: 'var(--fg-muted)',
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function ChipRow({
  options,
  value,
  onSelect,
  suffix,
}: {
  options: string[];
  value: string;
  onSelect: (v: string) => void;
  suffix?: string;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onSelect(opt)}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              fontFamily: 'inherit',
              borderRadius: 6,
              border: '1px solid ' + (active ? 'var(--line-strong)' : 'var(--line)'),
              background: active ? 'var(--bg-elev-3)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              cursor: 'pointer',
            }}
          >
            {opt}
            {suffix ? <span style={{ opacity: 0.6 }}> {suffix}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function SizeField({
  value,
  unit,
  onValue,
  onUnit,
}: {
  value: number;
  unit: SizeUnit;
  onValue: (v: number) => void;
  onUnit: (u: SizeUnit) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n) && n > 0) onValue(n);
        }}
        style={{
          width: 72,
          padding: '3px 6px',
          fontSize: 12,
          background: 'var(--bg-elev-3)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          color: 'var(--fg)',
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: 2 }}>
        {(['Mi', 'Gi'] as SizeUnit[]).map((u) => {
          const active = u === unit;
          return (
            <button
              key={u}
              type="button"
              onClick={() => onUnit(u)}
              style={{
                padding: '3px 7px',
                fontSize: 11,
                fontFamily: 'inherit',
                borderRadius: 6,
                border: '1px solid ' + (active ? 'var(--line-strong)' : 'var(--line)'),
                background: active ? 'var(--bg-elev-3)' : 'transparent',
                color: active ? 'var(--fg)' : 'var(--fg-muted)',
                cursor: 'pointer',
              }}
            >
              {u}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GpuSelect({
  value,
  onChange,
  state,
}: {
  value: GpuSpec | null;
  onChange: (next: GpuSpec | null) => void;
  state: ReturnType<typeof useGpuModels>;
}) {
  if (state.status === 'loading') {
    return (
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>Loading models…</div>
    );
  }
  if (state.status === 'error') {
    return (
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
        Couldn’t load GPU options — try again later
      </div>
    );
  }
  const models = state.models;
  // Encode "vendor:model" so the <select> value is a single string.
  const currentKey = value ? `${value.vendor}:${value.model}` : '';
  return (
    <select
      value={currentKey}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) {
          onChange(null);
          return;
        }
        const [vendor, model] = v.split(':');
        if (!vendor || !model) return;
        onChange({ vendor: vendor as 'nvidia' | 'amd', model });
      }}
      style={{
        width: '100%',
        padding: '4px 6px',
        fontSize: 12,
        background: 'var(--bg-elev-3)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        color: 'var(--fg)',
        fontFamily: 'inherit',
        outline: 'none',
      }}
    >
      <option value="">None</option>
      {models.map((m) => {
        const key = `${m.vendor}:${m.model}`;
        const ram = m.ram ? ` • ${m.ram}` : '';
        const free = m.available > 0 ? ` (${m.available} free)` : ' (busy)';
        return (
          <option key={key} value={key} disabled={m.available <= 0}>
            {m.vendor} {m.model}
            {ram}
            {free}
          </option>
        );
      })}
    </select>
  );
}

// ─── Feasibility status line ──────────────────────────────────────────

function FeasibilityLine({
  active,
  state,
}: {
  active: boolean;
  state: ReturnType<typeof useFeasibility>;
}) {
  if (!active) {
    return <span>Providers will bid on this spec</span>;
  }
  if (state.status === 'idle' || state.status === 'loading') {
    return <span>Checking provider availability…</span>;
  }
  if (state.status === 'error') {
    // Don't block the user on a feasibility-check failure; the deploy path
    // still works, providers will either bid or not.
    return <span>Couldn’t check availability</span>;
  }
  const { matchingProviders, totalActiveProviders, bottleneck } = state.result;
  if (matchingProviders === 0) {
    const hint = bottleneck ? ` — try lowering ${bottleneck}` : '';
    return (
      <span style={{ color: 'var(--accent-soft)' }}>
        0 providers match{hint}
      </span>
    );
  }
  if (matchingProviders < 5) {
    return (
      <span style={{ color: 'var(--accent-soft)' }}>
        {matchingProviders} of {totalActiveProviders} providers match
      </span>
    );
  }
  return (
    <span>
      {matchingProviders} of {totalActiveProviders} providers match
    </span>
  );
}
