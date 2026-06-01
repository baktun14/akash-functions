// Jobs list — a recency-ordered runs view for python-jobs (ephemeral GPU runs
// that Succeed or Fail), deliberately distinct from the Functions card grid.
//
// The mental model here is "recent runs", not "active vs failed services", so
// this renders as scannable rows with an OUTCOME filter (All / Running /
// Succeeded / Failed) rather than cards with an Active/All toggle. Status logic,
// recency ordering, the filter predicate, and the relative-time formatter all
// live in run-panel/runStatus.ts so the pill and its filter bucket can't drift.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FunctionRecord } from '@shared/types';
import { Icon, StatusDot } from '../icons';
import {
  jobTone,
  jobMatchesOutcome,
  sortJobsByRecency,
  timeAgo,
  type JobOutcomeFilter,
} from '../run-panel/runStatus';

type Props = {
  jobs: FunctionRecord[];
  onNewJob: () => void;
};

const FILTERS: { id: JobOutcomeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'failed', label: 'Failed' },
];

export function JobsList({ jobs, onNewJob }: Props) {
  const [filter, setFilter] = useState<JobOutcomeFilter>('all');
  const now = Date.now();

  const ordered = sortJobsByRecency(jobs);
  const visible = ordered.filter((s) => jobMatchesOutcome(s, filter));

  const subtitle =
    filter === 'all'
      ? `${jobs.length} GPU ${jobs.length === 1 ? 'run' : 'runs'}`
      : `${visible.length} of ${jobs.length} · ${filter}`;

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
      <div style={{ maxWidth: 1280, margin: '0 auto 20px' }}>
        <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em' }}>Jobs</div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 2 }}>{subtitle}</div>
        <div
          style={{
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <OutcomeFilter filter={filter} onChange={setFilter} />
          <button
            type="button"
            onClick={onNewJob}
            className="btn btn-primary btn-sm"
            style={{ gap: 6 }}
          >
            <Icon name="plus" size={13} /> New job
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <JobsEmptyState
          filter={filter}
          hasAny={jobs.length > 0}
          onShowAll={() => setFilter('all')}
        />
      ) : (
        <div
          style={{
            maxWidth: 1280,
            margin: '0 auto',
            border: '1px solid var(--line)',
            borderRadius: 12,
            overflow: 'hidden',
            background: 'var(--bg-elev-1)',
          }}
        >
          {visible.map((svc, i) => (
            <JobRow key={svc.id} svc={svc} now={now} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

// One run row. Outcome dot + name on the left; the textual outcome + relative
// "last run" time on the right. Hover lifts the row a step so the whole row
// reads as the clickable target (it links to the RunPanel).
function JobRow({
  svc,
  now,
  first,
}: {
  svc: FunctionRecord;
  now: number;
  first: boolean;
}) {
  const [hover, setHover] = useState(false);
  const tone = jobTone(svc);
  return (
    <Link
      to={`/jobs/${svc.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '13px 16px',
        textDecoration: 'none',
        color: 'inherit',
        borderTop: first ? 'none' : '1px solid var(--line)',
        background: hover ? 'var(--bg-elev-2)' : 'transparent',
        transition: 'background 120ms var(--ease-out)',
      }}
    >
      <StatusDot color={tone.color} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 14.5,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {svc.name}
        </div>
      </div>
      <span
        style={{ fontSize: 12.5, color: tone.color, fontWeight: 500, whiteSpace: 'nowrap' }}
      >
        {tone.label}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          color: 'var(--fg-subtle)',
          minWidth: 72,
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {timeAgo(svc.updatedAt ?? svc.createdAt, now)}
      </span>
    </Link>
  );
}

function OutcomeFilter({
  filter,
  onChange,
}: {
  filter: JobOutcomeFilter;
  onChange: (f: JobOutcomeFilter) => void;
}) {
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
      {FILTERS.map((f) => {
        const selected = filter === f.id;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(f.id)}
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
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function JobsEmptyState({
  filter,
  hasAny,
  onShowAll,
}: {
  filter: JobOutcomeFilter;
  hasAny: boolean;
  onShowAll: () => void;
}) {
  const message =
    filter !== 'all' && hasAny
      ? `No ${filter} jobs right now.`
      : 'No jobs yet. Run a Python GPU job and it shows up here.';

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
      {filter !== 'all' && hasAny && (
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
