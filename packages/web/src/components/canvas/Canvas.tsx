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

const isActive = (s: FunctionRecord) => s.status === 'online' || s.status === 'pending';

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
              className="btn btn-subtle btn-sm"
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

function OutdatedRunnerBanner({
  outdated,
  onDone,
}: {
  outdated: FunctionRecord[];
  onDone?: () => void | Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'partial'>('idle');
  const [progress, setProgress] = useState({ ok: 0, failed: 0 });

  // Runs in-place updates one at a time. Sequential because Akash's MsgUpdateDeployment
  // already serializes per dseq, but more importantly so a bad function's failure
  // surfaces immediately rather than after the whole batch lands.
  const onUpdateAll = async () => {
    if (state === 'running') return;
    setState('running');
    setProgress({ ok: 0, failed: 0 });
    let ok = 0;
    let failed = 0;
    for (const svc of outdated) {
      if (!svc.latestDeploymentId) {
        failed += 1;
        setProgress({ ok, failed });
        continue;
      }
      try {
        await api.updateRunnerImage(svc.id, svc.latestDeploymentId);
        ok += 1;
      } catch {
        failed += 1;
      }
      setProgress({ ok, failed });
    }
    setState(failed === 0 ? 'done' : 'partial');
    if (onDone) await onDone();
  };

  return (
    <div
      style={{
        marginTop: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'rgba(245,165,36,0.08)',
        border: '1px solid rgba(245,165,36,0.35)',
        borderRadius: 10,
        fontSize: 13,
      }}
    >
      <Icon name="arrowUp" size={14} color="var(--warn, #f5a524)" />
      <span style={{ color: 'var(--fg)' }}>
        {state === 'running' ? (
          <>
            Updating runners… <span style={{ color: 'var(--fg-muted)' }}>
              {progress.ok + progress.failed} / {outdated.length}
            </span>
          </>
        ) : state === 'done' ? (
          <>Updated {outdated.length} runner{outdated.length === 1 ? '' : 's'}.</>
        ) : state === 'partial' ? (
          <>
            Updated {progress.ok}, {progress.failed} failed — check each function for details.
          </>
        ) : (
          <>
            {outdated.length} function{outdated.length === 1 ? '' : 's'} running an outdated
            runner. Apply the in-place update to enforce protected routes.
          </>
        )}
      </span>
      <div style={{ flex: 1 }} />
      {state !== 'done' && state !== 'partial' && (
        <button
          type="button"
          onClick={onUpdateAll}
          disabled={state === 'running'}
          className="btn btn-sm"
          style={{
            background: 'var(--warn, #f5a524)',
            color: 'var(--bg)',
            border: 'none',
            fontWeight: 500,
            gap: 6,
            opacity: state === 'running' ? 0.7 : 1,
            cursor: state === 'running' ? 'progress' : 'pointer',
          }}
        >
          <Icon name="refresh" size={11} className={state === 'running' ? 'spin' : undefined} />
          {state === 'running' ? 'Updating…' : 'Update all'}
        </button>
      )}
    </div>
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
