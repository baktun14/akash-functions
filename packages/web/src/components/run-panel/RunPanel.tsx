// Run detail — full-page view for a python-job (FunctionKind 'python-job').
// Mounted INSTEAD of ServicePanel. Distinct product: ephemeral GPU runs that
// stream stdout/stderr live, capture an exit code, and auto-tear-down. No
// ingress URL anywhere (D6). Reduced tabs: Logs / Source / Runs / Settings.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type {
  DeploymentState,
  FunctionRecord,
  RunOutcome,
  RunRecord,
  Session,
} from '@shared/types';
import { api } from '../../lib/api';
import { FnLogo, Icon } from '../icons';
import { AsyncButton } from '../ui/AsyncButton';
import { SourceCodeTab } from '../service-panel/tabs/SourceCodeTab';
import { SettingsTab } from '../service-panel/tabs/SettingsTab';
import { LogConsole, type StreamUpdate } from './LogConsole';
import {
  computeRunPill,
  estimateCostUsd,
  formatDuration,
  gpuHourlyUsd,
  isRunActive,
  phaseLabel,
  runDurationMs,
} from './runStatus';

const TABS = ['Logs', 'Source', 'Runs', 'Settings'] as const;
type TabName = (typeof TABS)[number];

const POLL_INTERVAL_MS = 2000;

type Props = {
  svc: FunctionRecord;
  session: Session;
  onClose: () => void;
  onCloseDeployment?: () => void;
  onDelete?: () => void;
  onRename?: (name: string) => void | Promise<void>;
};

export function RunPanel({
  svc,
  session,
  onClose,
  onCloseDeployment,
  onDelete,
  onRename,
}: Props): ReactElement {
  const [tab, setTab] = useState<TabName>('Logs');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [underline, setUnderline] = useState({ left: 0, width: 0 });

  const [editingName, setEditingName] = useState(svc.name);
  const [renaming, setRenaming] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // All runs of this function, latest first. The first is the "current" run
  // we show logs for unless the user clicks an older one in the Runs tab.
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  // Live transitions bubbled up from the LogConsole stream so the pill updates
  // without re-fetching (D4).
  const [streamUpdate, setStreamUpdate] = useState<StreamUpdate | null>(null);
  // Re-render tick so live-duration ticks up while a run is active.
  const [, setNow] = useState(Date.now());

  const loadRuns = useCallback(async () => {
    try {
      const list = await api.listRuns(svc.id);
      setRuns(list);
      setSelectedRunId((cur) => cur ?? list[0]?.runId ?? null);
    } catch {
      /* ignore — poll will retry */
    }
  }, [svc.id]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const selectedRun =
    runs.find((r) => r.runId === selectedRunId) ?? runs[0] ?? null;

  // Merge the authoritative run record with any live stream transition for the
  // currently-shown run.
  const merged: {
    state: DeploymentState;
    runOutcome?: RunOutcome;
    exitCode?: number;
    errorMessage?: string;
  } = {
    state: streamUpdate?.state ?? selectedRun?.state ?? 'pending',
    runOutcome: streamUpdate?.runOutcome ?? selectedRun?.runOutcome,
    exitCode: streamUpdate?.exitCode ?? selectedRun?.exitCode,
    errorMessage: streamUpdate?.errorMessage ?? selectedRun?.errorMessage,
  };
  const failed = merged.runOutcome === 'failed' || merged.state === 'failed';
  const active = isRunActive(merged.state, merged.runOutcome);
  const pill = computeRunPill(merged.state, merged.runOutcome, merged.exitCode);

  // Reset stream-derived overrides when switching runs.
  useEffect(() => {
    setStreamUpdate(null);
  }, [selectedRunId]);

  // Poll the run list + tick the clock while the shown run is active, so the
  // summary row's live duration advances and a finished run gets its terminal
  // record reflected even if the stream's `end` was missed.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void loadRuns();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [active, loadRuns]);

  useEffect(() => {
    setEditingName(svc.name);
  }, [svc.name]);

  const commitName = async () => {
    const trimmed = editingName.trim();
    if (!trimmed || trimmed === svc.name) {
      setEditingName(svc.name);
      return;
    }
    if (!onRename || renaming) return;
    setRenaming(true);
    try {
      await onRename(trimmed);
    } finally {
      setRenaming(false);
    }
  };

  const cancelName = () => {
    setEditingName(svc.name);
    nameInputRef.current?.blur();
  };

  const onCancelRun = async () => {
    if (!selectedRun || canceling) return;
    // While waiting for capacity there's no lease yet — branch the copy so the
    // confirm matches reality.
    const confirmMsg =
      merged.state === 'waiting'
        ? 'Stop waiting for a GPU? No lease has been acquired yet.'
        : 'Cancel this run? The GPU lease is torn down immediately.';
    if (!confirm(confirmMsg)) return;
    setCanceling(true);
    try {
      await api.cancelRun(svc.id, selectedRun.runId);
      setStreamUpdate({ state: 'closed', runOutcome: 'canceled' });
      await loadRuns();
    } catch (err) {
      alert(`Failed to cancel run: ${(err as Error).message}`);
    } finally {
      setCanceling(false);
    }
  };

  // Re-run the job: starts a fresh run of the latest version (same code + GPU
  // request), so it re-enters the GPU-fallback flow. We jump to the new run.
  const onRunAgain = async () => {
    if (rerunning) return;
    setRerunning(true);
    try {
      const run = await api.createRun(svc.id);
      setStreamUpdate(null);
      setRuns((cur) => [run, ...cur]);
      setSelectedRunId(run.runId);
      setTab('Logs');
      await loadRuns();
    } catch (err) {
      alert(`Failed to start a new run: ${(err as Error).message}`);
    } finally {
      setRerunning(false);
    }
  };

  useLayoutEffect(() => {
    const el = tabRefs.current[tab];
    if (el) setUnderline({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab]);

  return (
    <div
      className="page-in"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '18px 36px 0',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12.5,
            color: 'var(--fg-muted)',
            marginBottom: 14,
          }}
        >
          <button onClick={onClose} className="btn btn-ghost btn-sm" style={{ padding: '4px 10px', gap: 6 }}>
            <Icon name="arrowLeft" size={12} /> Back
          </button>
          <span style={{ color: 'var(--fg-subtle)' }}>/</span>
          <span style={{ color: 'var(--fg-muted)' }}>Functions</span>
          <span style={{ color: 'var(--fg-subtle)' }}>/</span>
          <span className="mono" style={{ color: 'var(--fg)' }}>{svc.name}</span>
          <span
            style={{
              marginLeft: 4,
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
            Python GPU
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <FnLogo size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <input
                ref={nameInputRef}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    nameInputRef.current?.blur();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelName();
                  }
                }}
                maxLength={60}
                spellCheck={false}
                aria-label="Function name"
                disabled={!onRename || renaming}
                size={Math.max(editingName.length, 8)}
                className="service-name-input"
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  background: 'transparent',
                  border: '1px solid transparent',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  padding: '2px 6px',
                  margin: '-2px -6px',
                  outline: 'none',
                  fontFamily: 'inherit',
                  minWidth: 0,
                  opacity: renaming ? 0.6 : 1,
                }}
              />
              {renaming && (
                <Icon name="spinner" size={14} className="spin" color="var(--fg-muted)" />
              )}
              <StatusPill pill={pill} />
            </h1>
            {active && (
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
                {phaseLabel(merged.state, selectedRun?.gpuAttempt)}
                {selectedRun?.gpu ? ` · ${selectedRun.gpu.vendor.toUpperCase()} ${selectedRun.gpu.model.toUpperCase()}` : ''}…
              </div>
            )}
          </div>
          {active && (
            <AsyncButton
              onClick={onCancelRun}
              loading={canceling}
              loadingText="Canceling…"
              className="btn btn-subtle btn-sm"
              style={{ gap: 6, opacity: canceling ? 0.6 : 1 }}
            >
              <Icon name="x" size={11} />
              Cancel run
            </AsyncButton>
          )}
          {!active && selectedRun && (
            <AsyncButton
              onClick={onRunAgain}
              loading={rerunning}
              loadingText="Starting…"
              className="btn btn-primary btn-sm"
              style={{ gap: 6 }}
            >
              <Icon name="refresh" size={11} color="#0A0A0F" />
              Run again
            </AsyncButton>
          )}
        </div>

        {/* Run-summary row — GPU / provider / duration / exit / est. cost. */}
        <RunSummary run={selectedRun} merged={merged} />

        {failed && merged.errorMessage && (
          <FailureBanner message={merged.errorMessage} />
        )}

        <div style={{ position: 'relative', display: 'flex', gap: 30, marginTop: 16 }}>
          {TABS.map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              onClick={() => setTab(t)}
              style={{
                padding: '10px 0',
                border: 'none',
                background: 'transparent',
                color: tab === t ? 'var(--fg)' : 'var(--fg-muted)',
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: '-0.005em',
                transition: 'color 160ms',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          ))}
          <div className="tab-underline" style={underline} />
        </div>
      </div>

      <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '32px 36px 80px' }}>
        <div key={tab} className="fade-up" style={{ maxWidth: 1100, margin: '0 auto' }}>
          {tab === 'Logs' &&
            (selectedRun ? (
              <LogConsole
                key={selectedRun.runId}
                fnId={svc.id}
                runId={selectedRun.runId}
                active={active}
                onStreamUpdate={setStreamUpdate}
              />
            ) : (
              <EmptyHint text="No runs yet for this function." />
            ))}
          {tab === 'Source' && <SourceCodeTab svc={svc} />}
          {tab === 'Runs' && (
            <RunsTab
              runs={runs}
              selectedRunId={selectedRun?.runId ?? null}
              onSelect={(id) => {
                setSelectedRunId(id);
                setTab('Logs');
              }}
            />
          )}
          {tab === 'Settings' && (
            <SettingsTab
              svc={svc}
              session={session}
              onCloseDeployment={onCloseDeployment}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ pill }: { pill: ReturnType<typeof computeRunPill> }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: pill.color,
        fontWeight: 500,
      }}
    >
      {pill.active ? (
        <Icon name="spinner" size={12} className="spin" color={pill.color} />
      ) : (
        <span className="status-dot" style={{ background: pill.color }} />
      )}
      {pill.label}
    </span>
  );
}

function FailureBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 12,
        padding: '10px 14px',
        background: 'rgba(229, 72, 77, 0.08)',
        border: '1px solid rgba(229, 72, 77, 0.35)',
        borderRadius: 10,
        fontSize: 12.5,
        color: 'var(--err, #e5484d)',
        lineHeight: 1.5,
      }}
    >
      <span style={{ marginTop: 1, flexShrink: 0 }}>
        <Icon name="info" size={13} color="var(--err, #e5484d)" />
      </span>
      <span>{message}</span>
    </div>
  );
}

function RunSummary({
  run,
  merged,
}: {
  run: RunRecord | null;
  merged: { state: DeploymentState; runOutcome?: RunOutcome; exitCode?: number };
}) {
  const durationMs = runDurationMs(run?.startedAt, run?.finishedAt, Date.now());
  const gpuModel = run?.gpu?.model;
  const gpuLabel = run?.gpu
    ? `${run.gpu.vendor.toUpperCase()} ${run.gpu.model.toUpperCase()}`
    : '—';
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 18,
        padding: '12px 14px',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        fontSize: 12.5,
      }}
    >
      <SummaryItem icon="gpu" label="GPU" value={gpuLabel} />
      <SummaryItem
        icon="network"
        label="Provider"
        value={run?.provider ? short(run.provider) : '—'}
      />
      <SummaryItem
        icon="cron"
        label="Duration"
        value={durationMs != null ? formatDuration(durationMs) : '—'}
      />
      <SummaryItem
        icon="bolt"
        label="Exit code"
        value={merged.exitCode != null ? String(merged.exitCode) : '—'}
      />
      <SummaryItem
        icon="coin"
        label="Cost (est.)"
        value={durationMs != null ? `$${estimateCostUsd(durationMs, gpuModel).toFixed(3)}` : '—'}
        hint={`est. @ $${gpuHourlyUsd(gpuModel)}/hr`}
      />
    </div>
  );
}

function SummaryItem({
  icon,
  label,
  value,
  hint,
}: {
  icon: 'gpu' | 'network' | 'cron' | 'bolt' | 'coin';
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 90 }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10.5,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
        }}
      >
        <Icon name={icon} size={11} color="var(--fg-subtle)" />
        {label}
      </span>
      <span className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
        {value}
      </span>
      {hint && (
        <span style={{ fontSize: 10, color: 'var(--fg-subtle)' }}>{hint}</span>
      )}
    </div>
  );
}

function RunsTab({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: RunRecord[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <EmptyHint text="No runs yet for this function." />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {runs.map((run) => {
        const pill = computeRunPill(run.state, run.runOutcome, run.exitCode);
        const selected = run.runId === selectedRunId;
        const durationMs = runDurationMs(run.startedAt, run.finishedAt, Date.now());
        return (
          <button
            key={run.runId}
            type="button"
            onClick={() => onSelect(run.runId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              textAlign: 'left',
              borderRadius: 10,
              cursor: 'pointer',
              background: selected ? 'var(--bg-elev-3)' : 'var(--bg-elev-2)',
              border:
                '1px solid ' + (selected ? 'var(--line-strong)' : 'var(--line)'),
              color: 'var(--fg)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {pill.active ? (
                <Icon name="spinner" size={11} className="spin" color={pill.color} />
              ) : (
                <span className="status-dot" style={{ background: pill.color }} />
              )}
              <span style={{ fontSize: 12.5, color: pill.color, fontWeight: 500, minWidth: 120 }}>
                {pill.label}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)', flex: 1, minWidth: 0 }}>
              {run.runId}
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {durationMs != null ? formatDuration(durationMs) : '—'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {fmtWhen(run.createdAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: '40px 24px',
        textAlign: 'center',
        color: 'var(--fg-muted)',
        border: '1px dashed var(--line)',
        borderRadius: 12,
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}

function short(s: string): string {
  return s.length > 16 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
