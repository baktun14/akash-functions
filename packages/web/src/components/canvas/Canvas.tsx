// Functions list view — grid of DeploymentCard. Cards are <Link> to detail.

import { useState } from 'react';
import type { FunctionRecord } from '@shared/types';
import { Icon } from '../icons';
import { api } from '../../lib/api';
import { DeploymentCard } from './DeploymentCard';

type Props = {
  services: FunctionRecord[];
  onNewFunction?: () => void;
  onRefresh?: () => void | Promise<void>;
};

type Filter = 'active' | 'all';

// 'degraded' counts as active — the lease is still paid and the runner may
// recover any moment. Hiding it would reproduce the original bug where a
// transient probe failure wiped functions off the dashboard.
const isActive = (s: FunctionRecord) =>
  s.status === 'online' || s.status === 'pending' || s.status === 'degraded';

export function Canvas({ services, onNewFunction, onRefresh }: Props) {
  const [filter, setFilter] = useState<Filter>('active');

  const activeCount = services.filter(isActive).length;
  const visible = filter === 'active' ? services.filter(isActive) : services;
  const outdated = services.filter((s) => s.runnerOutdated && s.latestDeploymentId);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg)',
        overflow: 'auto',
        padding: '28px 32px 80px',
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto 20px',
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em' }}>Functions</div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>
          {filter === 'active'
            ? `${activeCount} active · production`
            : `${activeCount} of ${services.length} active · production`}
        </div>
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <FilterToggle filter={filter} onChange={setFilter} />
          {onNewFunction && (
            <button
              type="button"
              onClick={onNewFunction}
              className="btn btn-primary btn-sm"
              style={{ gap: 6 }}
            >
              <Icon name="plus" size={13} /> New function
            </button>
          )}
        </div>
        {outdated.length > 0 && (
          <OutdatedRunnerBanner outdated={outdated} onDone={onRefresh} />
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState filter={filter} hasAny={services.length > 0} onShowAll={() => setFilter('all')} />
      ) : (
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 14,
          }}
        >
          {visible.map((s) => (
            <DeploymentCard key={s.id} svc={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterToggle({ filter, onChange }: { filter: Filter; onChange: (f: Filter) => void }) {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        padding: 2,
        background: 'var(--bg-elev-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
      }}
    >
      <FilterButton selected={filter === 'active'} onClick={() => onChange('active')}>
        Active
      </FilterButton>
      <FilterButton selected={filter === 'all'} onClick={() => onChange('all')}>
        All
      </FilterButton>
    </div>
  );
}

function FilterButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      style={{
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 500,
        cursor: 'pointer',
        border: 'none',
        borderRadius: 6,
        background: selected ? 'var(--bg-elev-3, var(--bg-elev-2))' : 'transparent',
        color: selected ? 'var(--fg)' : 'var(--fg-muted)',
        transition: 'background 120ms var(--ease-out), color 120ms var(--ease-out)',
      }}
    >
      {children}
    </button>
  );
}

type ItemStatus =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'ok' }
  | { kind: 'failed'; error: string };

const COLLAPSE_THRESHOLD = 5;

function OutdatedRunnerBanner({
  outdated,
  onDone,
}: {
  outdated: FunctionRecord[];
  onDone?: () => void | Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'partial'>('idle');
  const [items, setItems] = useState<Record<string, ItemStatus>>({});
  const [batch, setBatch] = useState<FunctionRecord[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const runUpdates = async (targets: FunctionRecord[]) => {
    if (state === 'running') return;
    if (targets.length === 0) return;
    setState('running');
    setBatch(targets);
    setCollapsed(targets.length > COLLAPSE_THRESHOLD);
    const next: Record<string, ItemStatus> = {};
    for (const svc of targets) next[svc.id] = { kind: 'pending' };
    setItems(next);

    let failed = 0;
    await Promise.all(
      targets.map(async (svc) => {
        setItems((cur) => ({ ...cur, [svc.id]: { kind: 'running' } }));
        if (!svc.latestDeploymentId) {
          failed += 1;
          setItems((cur) => ({
            ...cur,
            [svc.id]: { kind: 'failed', error: 'No deployment id on record — refresh and retry.' },
          }));
          return;
        }
        try {
          await api.updateRunnerImage(svc.id, svc.latestDeploymentId);
          setItems((cur) => ({ ...cur, [svc.id]: { kind: 'ok' } }));
        } catch (err) {
          failed += 1;
          setItems((cur) => ({
            ...cur,
            [svc.id]: { kind: 'failed', error: (err as Error).message || 'Unknown error' },
          }));
        }
      })
    );
    setState(failed === 0 ? 'done' : 'partial');
    if (onDone) await onDone();
  };

  const onUpdateAll = () => void runUpdates(outdated);
  const onRetryFailed = () => {
    const failedIds = new Set(
      Object.entries(items)
        .filter(([, s]) => s.kind === 'failed')
        .map(([id]) => id)
    );
    void runUpdates(batch.filter((s) => failedIds.has(s.id)));
  };

  const okCount = Object.values(items).filter((s) => s.kind === 'ok').length;
  const failedCount = Object.values(items).filter((s) => s.kind === 'failed').length;
  const runningCount = Object.values(items).filter((s) => s.kind === 'running').length;
  const pendingCount = Object.values(items).filter((s) => s.kind === 'pending').length;
  const settled = okCount + failedCount;
  const total = state === 'idle' ? outdated.length : Object.keys(items).length;
  // Progress bar still nudges off zero on the first tick so the user gets an
  // immediate visual signal that something happened.
  const pct = total === 0 ? 0 : Math.max(2, (settled / total) * 100);

  const headerIcon =
    state === 'running'
      ? { name: 'spinner', color: 'var(--warn, #f5a524)', spin: true }
      : state === 'done'
        ? { name: 'check', color: 'var(--ok, #30a46c)', spin: false }
        : { name: 'arrowUp', color: 'var(--warn, #f5a524)', spin: false };

  return (
    <div
      style={{
        marginTop: 14,
        padding: '10px 14px',
        background:
          state === 'done' ? 'rgba(48,164,108,0.08)' : 'rgba(245,165,36,0.08)',
        border:
          state === 'done'
            ? '1px solid rgba(48,164,108,0.35)'
            : '1px solid rgba(245,165,36,0.35)',
        borderRadius: 10,
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icon
          name={headerIcon.name}
          size={14}
          color={headerIcon.color}
          className={headerIcon.spin ? 'spin' : undefined}
        />
        <span style={{ color: 'var(--fg)' }}>
          {state === 'running' ? (
            <>
              Updating runners…{' '}
              <span style={{ color: 'var(--fg-muted)' }}>
                {settled} / {total}
              </span>
            </>
          ) : state === 'done' ? (
            <>Updated {total} runner{total === 1 ? '' : 's'}.</>
          ) : state === 'partial' ? (
            <>
              Updated {okCount}, {failedCount} failed — see below.
            </>
          ) : (
            <>
              {outdated.length} function{outdated.length === 1 ? '' : 's'} running an outdated
              runner. Apply the in-place update to enforce protected routes.
            </>
          )}
        </span>
        <div style={{ flex: 1 }} />
        {state === 'idle' && (
          <button
            type="button"
            onClick={onUpdateAll}
            className="btn btn-sm"
            style={{
              background: 'var(--warn, #f5a524)',
              color: 'var(--bg)',
              border: 'none',
              fontWeight: 500,
              gap: 6,
            }}
          >
            <Icon name="arrowUp" size={11} />
            Update all
          </button>
        )}
        {state === 'running' && (
          <button
            type="button"
            disabled
            className="btn btn-sm"
            style={{
              background: 'var(--bg-elev-3)',
              color: 'var(--fg-muted)',
              border: '1px solid var(--line)',
              fontWeight: 500,
              gap: 6,
              opacity: 0.55,
              cursor: 'not-allowed',
            }}
          >
            <Icon name="spinner" size={11} className="spin" />
            Updating…
          </button>
        )}
        {state === 'partial' && failedCount > 0 && (
          <button
            type="button"
            onClick={onRetryFailed}
            className="btn btn-sm"
            style={{
              background: 'var(--warn, #f5a524)',
              color: 'var(--bg)',
              border: 'none',
              fontWeight: 500,
              gap: 6,
            }}
          >
            <Icon name="refresh" size={11} />
            Retry failed
          </button>
        )}
      </div>

      {state === 'running' && (
        <div
          aria-hidden="true"
          style={{
            marginTop: 10,
            height: 3,
            borderRadius: 999,
            background: 'rgba(245,165,36,0.18)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: 'var(--warn, #f5a524)',
              transition: 'width 240ms var(--ease-out)',
            }}
          />
        </div>
      )}

      {(state === 'running' || state === 'partial') && (
        <BulkDetails
          batch={batch}
          items={items}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          okCount={okCount}
          runningCount={runningCount}
          pendingCount={pendingCount}
          failedCount={failedCount}
        />
      )}
    </div>
  );
}

function BulkDetails({
  batch,
  items,
  collapsed,
  onToggle,
  okCount,
  runningCount,
  pendingCount,
  failedCount,
}: {
  batch: FunctionRecord[];
  items: Record<string, ItemStatus>;
  collapsed: boolean;
  onToggle: () => void;
  okCount: number;
  runningCount: number;
  pendingCount: number;
  failedCount: number;
}) {
  const showToggle = batch.length > COLLAPSE_THRESHOLD;
  const summaryParts: string[] = [];
  if (okCount) summaryParts.push(`${okCount} done`);
  if (runningCount) summaryParts.push(`${runningCount} updating`);
  if (pendingCount) summaryParts.push(`${pendingCount} pending`);
  if (failedCount) summaryParts.push(`${failedCount} failed`);
  const visible = collapsed
    ? batch.filter((svc) => items[svc.id]?.kind === 'failed')
    : batch;

  return (
    <div style={{ marginTop: 12 }}>
      {showToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="btn btn-subtle btn-sm"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            fontSize: 12,
            color: 'var(--fg-muted)',
            background: 'transparent',
            border: 'none',
          }}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
          {collapsed
            ? `${summaryParts.join(' · ')} — show details`
            : 'Hide details'}
        </button>
      )}
      {visible.length > 0 && (
        <ul
          style={{
            margin: showToggle ? '6px 0 0' : 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {visible.map((svc) => {
            const s = items[svc.id];
            if (!s) return null;
            return <BulkItemRow key={svc.id} name={svc.name} status={s} />;
          })}
        </ul>
      )}
    </div>
  );
}

function BulkItemRow({ name, status }: { name: string; status: ItemStatus }) {
  const tone =
    status.kind === 'ok'
      ? { icon: 'check', color: 'var(--ok, #30a46c)', label: 'Done', spin: false }
      : status.kind === 'failed'
        ? { icon: 'x', color: 'var(--err, #e5484d)', label: 'Failed', spin: false }
        : status.kind === 'running'
          ? { icon: 'spinner', color: 'var(--warn, #f5a524)', label: 'Updating…', spin: true }
          : { icon: 'cron', color: 'var(--fg-muted)', label: 'Pending', spin: false };

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 10px',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        fontSize: 12.5,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', paddingTop: 2 }}>
        <Icon name={tone.icon} size={12} color={tone.color} className={tone.spin ? 'spin' : undefined} />
      </span>
      <span style={{ color: 'var(--fg)', minWidth: 0, flex: 1, overflow: 'hidden' }}>
        <span style={{ fontWeight: 500 }}>{name}</span>
        <span style={{ color: 'var(--fg-muted)' }}> · {tone.label}</span>
        {status.kind === 'failed' && (
          <div
            className="mono"
            style={{
              marginTop: 4,
              fontSize: 11.5,
              color: 'var(--fg-muted)',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            {status.error}
          </div>
        )}
      </span>
    </li>
  );
}

function EmptyState({
  filter,
  hasAny,
  onShowAll,
}: {
  filter: Filter;
  hasAny: boolean;
  onShowAll: () => void;
}) {
  const message =
    filter === 'active'
      ? hasAny
        ? 'No active functions. Failed and idle functions are hidden.'
        : 'No functions yet. Hit Deploy in the sidebar to create one.'
      : 'No functions yet. Hit Deploy in the sidebar to create one.';

  return (
    <div
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: '48px 24px',
        textAlign: 'center',
        color: 'var(--fg-muted)',
        border: '1px dashed var(--line)',
        borderRadius: 12,
        fontSize: 13,
      }}
    >
      <div>{message}</div>
      {filter === 'active' && hasAny && (
        <button
          type="button"
          onClick={onShowAll}
          style={{
            marginTop: 12,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            border: '1px solid var(--line)',
            borderRadius: 6,
            background: 'var(--bg-elev-1)',
            color: 'var(--fg)',
          }}
        >
          Show all
        </button>
      )}
    </div>
  );
}
