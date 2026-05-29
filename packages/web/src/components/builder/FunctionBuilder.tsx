// Full-screen function builder: code editor + side panel (prompt, presets,
// optional AkashMLConnect, inferred or custom resources, Deploy).
//
// Resources start as the preset's "inferred" defaults (read-only chips). The
// Adjust button toggles to an editable form (CPU/RAM/Storage/GPU) and, once
// the user has customized anything, a live feasibility indicator polls the
// backend for "how many online+audited providers can fulfill this spec?".
// We let the user deploy with 0 matches (providers come online dynamically)
// but require an explicit confirm so they don't sit in `bidding` by surprise.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CodeSample,
  CreateAndRunRequest,
  GpuModelOption,
  GpuSpec,
  PresetId,
  ResourceRequest,
} from '@shared/types';
import { FnLogo, Icon } from '../icons';
import { PRESETS, SAMPLES, PYTHON_REQUIREMENTS } from '../../data/presets';
import { ResChip } from './ResChip';
import { AgentCTACard } from './AgentCTACard';
import { AkashMLConnect } from './AkashMLConnect';
import { CodeEditor } from './CodeEditor';
import { AsyncButton } from '../ui/AsyncButton';
import { api, tokensToSource } from '../../lib/api';
import { detectEnvVarKeys } from '../../lib/detect-env-vars';
import { useGpuModels } from '../../lib/use-gpu-models';
import { useFeasibility } from '../../lib/use-feasibility';
import { useRegisterActiveEditor } from '../agent/ActiveEditorContext';

type Props = {
  initialPreset?: PresetId | null;
  /** Seed for the editor when opening the builder from the agent chat. Falls
   *  back to the preset's template source when absent. */
  initialSource?: string | null;
  onClose: () => void;
  /** customResources is sent only when the user opened Adjust and edited the form.
   *  envVars carries any user-supplied secrets the source references (e.g.
   *  AKASHML_API_KEY) — undefined when there are none to send. */
  onDeploy: (
    sample: CodeSample,
    customResources?: ResourceRequest,
    envVars?: Record<string, string>,
  ) => Promise<void>;
  /** Python-job primary action. When the active preset is `python`, the
   *  builder's primary button reads "Run" and calls this instead of onDeploy.
   *  The parent wires it to api.createAndRun + navigates to the RunPanel. */
  onRun?: (body: CreateAndRunRequest) => Promise<void>;
  /** Agent chat panel — when present, the builder shifts to a 3-column grid
   *  with the agent docked on the right. Layout owns the panel; we just host it. */
  agentSlot?: ReactNode;
  /** Whether the agent panel is currently open. Controls whether the in-builder
   *  CTA card is shown (hidden when the panel is already docked). */
  agentOpen: boolean;
  /** Opens the agent panel; the Layout docks it into the builder's grid. */
  onOpenAgent: () => void;
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

// Parse a "vendor model" GPU hint (e.g. "nvidia h100") off the sample's
// resource chip. Returns null for "no GPU" / "AkashML" / unparseable values.
function parseGpuHint(gpu: string): GpuSpec | null {
  const m = gpu.trim().toLowerCase().match(/^(nvidia|amd)\s+(\S+)$/);
  if (!m) return null;
  return { vendor: m[1] as 'nvidia' | 'amd', model: m[2]! };
}

// Datacenter-class GPUs in rough capability order — used to pick a sensible
// AVAILABLE default for a Python job when the preset's hint (h100) is busy.
const JOB_GPU_PREFERENCE = ['h200', 'h100', 'a100', 'pro6000se', 'l40', 'l4', 'rtx5090'];

// Choose an available GPU for a job: keep `preferred` if it has free capacity;
// otherwise fall back through the preference list, then to the model with the
// most free units. Returns `preferred` unchanged when nothing is free (so we
// don't silently flip the user's pick to "None"). The model list carries live
// availability from /api/gpu-models.
function pickAvailableGpu(models: GpuModelOption[], preferred: GpuSpec | null): GpuSpec | null {
  const avail = models.filter((m) => m.available > 0);
  if (avail.length === 0) return preferred;
  if (
    preferred &&
    avail.some((m) => m.vendor === preferred.vendor && m.model === preferred.model)
  ) {
    return preferred;
  }
  for (const model of JOB_GPU_PREFERENCE) {
    const hit = avail.find((m) => m.model === model);
    if (hit) return { vendor: hit.vendor, model: hit.model };
  }
  const best = avail.slice().sort((a, b) => b.available - a.available)[0]!;
  return { vendor: best.vendor, model: best.model };
}

function parseDefaultForm(sample: CodeSample): ResourceForm {
  const cpu = sample.res.cpu.match(/[\d.]+/)?.[0] ?? '0.5';
  const memMatch = sample.res.mem.match(/(\d+)\s*(Mi|Gi)/i);
  const gpu = parseGpuHint(sample.res.gpu);
  // A real GPU passthrough (Python jobs) needs room for the CUDA/PyTorch image
  // + pip wheels — the server floors job storage to 20Gi anyway, so default the
  // form to match instead of showing a misleading 1Gi.
  const isGpuJob = gpu != null;
  return {
    cpu,
    memoryValue: memMatch ? parseInt(memMatch[1]!, 10) : 512,
    memoryUnit: (memMatch?.[2]?.replace(/^\w/, (c) => c.toUpperCase()) ?? 'Mi') as SizeUnit,
    storageValue: isGpuJob ? 20 : 1,
    storageUnit: 'Gi',
    gpu,
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

export function FunctionBuilder({
  initialPreset,
  initialSource,
  onClose,
  onDeploy,
  onRun,
  agentSlot,
  agentOpen,
  onOpenAgent,
}: Props) {
  const initial: PresetId =
    initialPreset && SAMPLES[initialPreset] ? initialPreset : 'rest';
  const [preset, setPreset] = useState<PresetId>(initial);
  const [source, setSource] = useState<string>(() =>
    initialSource ?? SAMPLES[initial].source ?? tokensToSource(SAMPLES[initial].code)
  );
  // `prompt` is no longer user-editable in the builder — the agent panel is the
  // prompt surface. We still carry the preset's stock prompt through to
  // `onDeploy` so it lands on the function record as descriptor metadata.
  const [prompt, setPrompt] = useState<string>(SAMPLES[initial].prompt);
  const [name, setName] = useState<string>(SAMPLES[initial].name);

  // Expose this editor to the agent panel so it can read the current source
  // and write generated code back via setSource.
  useRegisterActiveEditor({
    mode: 'create',
    preset,
    name,
    currentSource: source,
    applySource: setSource,
  });

  // Statically detect env-var references in the source. The list updates as
  // the agent edits the code. Each key gets a row in the form below; missing
  // values block deploy.
  const detectedEnvKeys = useMemo(() => detectEnvVarKeys(source), [source]);
  const needsAkashMLKey = detectedEnvKeys.includes('AKASHML_API_KEY');

  const [envValues, setEnvValues] = useState<Record<string, string>>({});

  // Pre-fill AKASHML_API_KEY from the stored connection whenever the key is
  // newly detected and the field is empty. Re-runs when the detection set
  // changes (agent rewrites the source).
  useEffect(() => {
    if (!needsAkashMLKey) return;
    if (envValues.AKASHML_API_KEY) return;
    const conn = api.getAkashMLConnection();
    if (!conn?.key) return;
    setEnvValues((cur) => ({ ...cur, AKASHML_API_KEY: conn.key }));
    // envValues intentionally excluded — we only want to seed an empty field
    // once per detection event, not fight the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAkashMLKey]);

  // True when at least one detected key has no value. Drives the Deploy
  // button's disabled state.
  const missingEnvValues = detectedEnvKeys.some((k) => !envValues[k]?.trim());

  // Adjust panel: closed by default so casual users see the preset chips, can
  // open inline to override. customRes === null means "use the preset defaults"
  // and skips both the feasibility call and the customResources payload.
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [customRes, setCustomRes] = useState<ResourceForm | null>(null);
  const [confirmingNoMatch, setConfirmingNoMatch] = useState(false);
  const [deploying, setDeploying] = useState(false);

  const sample = SAMPLES[preset];
  const isPython = preset === 'python';
  const templateSource = useMemo(
    () => sample.source ?? tokensToSource(sample.code),
    [sample.source, sample.code]
  );
  const dirty = source !== templateSource || name !== sample.name;
  const trimmedName = name.trim();
  const canDeploy = trimmedName.length > 0 && !missingEnvValues;

  const effectiveForm = customRes ?? parseDefaultForm(sample);
  const customResourceRequest: ResourceRequest | null = customRes
    ? toResourceRequest(customRes)
    : null;

  const gpuModelsState = useGpuModels();
  const feasibility = useFeasibility(customResourceRequest, customRes !== null);

  // For Python jobs, auto-correct the GPU to an AVAILABLE model once the live
  // inventory loads. The preset hint is h100, which is frequently busy — without
  // this the form opens on "0 providers match" and (worse) a run launched
  // without opening Adjust would request a busy GPU and never get a bid. Runs
  // once per preset selection so it sets a good default without fighting a
  // user's later manual pick.
  const gpuAutoPicked = useRef(false);
  useEffect(() => {
    if (!isPython || gpuModelsState.status !== 'ready' || gpuAutoPicked.current) return;
    const current = effectiveForm.gpu;
    const currentAvailable =
      current != null &&
      gpuModelsState.models.some(
        (m) => m.vendor === current.vendor && m.model === current.model && m.available > 0
      );
    if (!currentAvailable) {
      const picked = pickAvailableGpu(gpuModelsState.models, current);
      if (picked && (picked.model !== current?.model || picked.vendor !== current?.vendor)) {
        updateForm({ gpu: picked });
      }
    }
    gpuAutoPicked.current = true;
    // updateForm/effectiveForm are recomputed each render; we intentionally gate
    // re-runs on the ref, not the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPython, gpuModelsState]);

  const updateForm = (patch: Partial<ResourceForm>) => {
    setCustomRes((cur) => ({ ...(cur ?? parseDefaultForm(sample)), ...patch }));
    setConfirmingNoMatch(false);
  };

  const onSelectPreset = (next: PresetId) => {
    if (next === preset) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const ns = SAMPLES[next];
    setPreset(next);
    setSource(ns.source ?? tokensToSource(ns.code));
    setPrompt(ns.prompt);
    setName(ns.name);
    // Re-seed the form to the new preset's defaults so the user isn't stuck
    // with "0.25 vCPU" they picked under rest after switching to gpu.
    setCustomRes(null);
    setConfirmingNoMatch(false);
    // Allow the availability-aware GPU auto-pick to run again for the new preset.
    gpuAutoPicked.current = false;
  };

  const onDeployClick = async () => {
    if (!canDeploy || deploying) return;
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
    // Filter envValues down to currently-detected keys so a stale value left
    // behind from a previous source revision doesn't get sent.
    const envOut: Record<string, string> = {};
    for (const k of detectedEnvKeys) {
      const v = envValues[k]?.trim();
      if (v) envOut[k] = v;
    }
    setDeploying(true);
    try {
      if (isPython) {
        // Python jobs: create-and-run with a { main.py, requirements.txt }
        // source map and a GPU-bearing resource request.
        const resources: ResourceRequest = customResourceRequest ?? {
          cpu: effectiveForm.cpu,
          memory: `${effectiveForm.memoryValue}${effectiveForm.memoryUnit}`,
          storage: `${effectiveForm.storageValue}${effectiveForm.storageUnit}`,
          gpu: effectiveForm.gpu ?? { vendor: 'nvidia', model: 'h100' },
        };
        await onRun?.({
          name: trimmedName,
          prompt,
          source: { 'main.py': source, 'requirements.txt': PYTHON_REQUIREMENTS },
          resources,
          envVars: Object.keys(envOut).length > 0 ? envOut : undefined,
        });
      } else {
        await onDeploy(
          { ...sample, name: trimmedName, source, prompt },
          customResourceRequest ?? undefined,
          Object.keys(envOut).length > 0 ? envOut : undefined,
        );
      }
    } finally {
      setDeploying(false);
    }
  };

  const requestClose = () => {
    if (deploying) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    onClose();
  };

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
          {!agentOpen && <AgentCTACard onOpen={onOpenAgent} />}

          <div
            className="eyebrow"
            style={{ marginTop: agentOpen ? 0 : 18, marginBottom: 8 }}
          >
            Templates
          </div>
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

          {(sample.needsAkashML || needsAkashMLKey) && (
            <>
              <div className="eyebrow" style={{ marginTop: 18, marginBottom: 8 }}>
                Connections
              </div>
              <AkashMLConnect />
            </>
          )}

          {detectedEnvKeys.length > 0 && (
            <>
              <div className="eyebrow" style={{ marginTop: 18, marginBottom: 8 }}>
                Environment variables
              </div>
              <EnvVarsSection
                keys={detectedEnvKeys}
                values={envValues}
                onChange={(k, v) => setEnvValues((cur) => ({ ...cur, [k]: v }))}
              />
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

          <AsyncButton
            className="btn btn-primary"
            onClick={onDeployClick}
            disabled={!canDeploy}
            loading={deploying}
            loadingText={isPython ? 'Starting run…' : 'Deploying…'}
            spinnerSize={12}
            style={{
              width: '100%',
              marginTop: 18,
              justifyContent: 'center',
              opacity: canDeploy ? 1 : 0.5,
              cursor: canDeploy && !deploying ? 'pointer' : 'not-allowed',
              background: confirmingNoMatch ? 'var(--accent-soft)' : undefined,
            }}
          >
            <Icon name="play" size={12} color="#0A0A0F" />
            {confirmingNoMatch
              ? isPython
                ? 'Run anyway'
                : 'Deploy anyway'
              : isPython
                ? 'Run'
                : 'Deploy function'}
          </AsyncButton>
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
        {agentSlot && <div className="builder-agent-slot">{agentSlot}</div>}
      </div>
    </div>
  );
}

// ─── Env vars section ─────────────────────────────────────────────────

function EnvVarsSection({
  keys,
  values,
  onChange,
}: {
  keys: string[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>
        Detected in your source. Values are encrypted at rest and injected
        as <span className="mono" style={{ color: 'var(--fg)' }}>process.env.X</span> at runtime.
      </div>
      {keys.map((k) => {
        const value = values[k] ?? '';
        const empty = !value.trim();
        return (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label
              className="mono"
              style={{
                fontSize: 11,
                color: empty ? 'var(--accent-soft)' : 'var(--fg-muted)',
              }}
            >
              {k}
              {empty && <span style={{ marginLeft: 6 }}>required</span>}
            </label>
            <input
              type="password"
              value={value}
              onChange={(e) => onChange(k, e.target.value)}
              placeholder="paste value"
              autoComplete="off"
              spellCheck={false}
              className="input mono"
              style={{
                width: '100%',
                padding: '6px 10px',
                fontSize: 12,
                background: 'var(--bg-elev-3)',
                border: '1px solid ' + (empty ? 'rgba(255,41,3,0.4)' : 'var(--line)'),
                borderRadius: 8,
                color: 'var(--fg)',
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </div>
        );
      })}
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
