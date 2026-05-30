// Live log console for a python-job run. Consumes api.streamRunLogs as an
// async-iterable of RunLogChunk frames (mirroring the agent-chat SSE shape),
// renders stdout normally + stderr tinted red, auto-scrolls, and on reconnect
// resumes from the last seen `seq` via `afterSeq`. Terminal frames (`state`
// closed/failed, `end`, `error`) stop the stream; the parent owns the pill.

import { useEffect, useRef, useState } from 'react';
import type { DeploymentState, RunOutcome, RunLogChunk } from '@shared/types';
import { api } from '../../lib/api';
import { Icon } from '../icons';

export type LogLine = { seq: number; stream: 'stdout' | 'stderr'; text: string };

export type StreamUpdate = {
  state?: DeploymentState;
  runOutcome?: RunOutcome;
  exitCode?: number;
  errorMessage?: string;
};

type Props = {
  fnId: string;
  runId: string;
  // Whether the run is still active — drives whether we (re)open the stream.
  // Passing a terminal run skips reconnect once `end` lands.
  active: boolean;
  // Bubble state/outcome/exit transitions up so the parent can recompute the
  // status pill (D4) without re-fetching the run.
  onStreamUpdate?: (update: StreamUpdate) => void;
};

export function LogConsole({ fnId, runId, active, onStreamUpdate }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'ended' | 'error'>(
    'connecting'
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Last seq we've rendered — used to resume after a reconnect.
  const lastSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Reset all per-run state when the target run changes.
  useEffect(() => {
    setLines([]);
    setStatus('connecting');
    setErrorMsg(null);
    lastSeqRef.current = 0;
    stickToBottomRef.current = true;
  }, [fnId, runId]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let ended = false;

    const run = async () => {
      // Retry loop — on a dropped connection we reopen resuming at lastSeq,
      // unless the run already reached a terminal frame or the parent says
      // it's no longer active.
      while (!cancelled && !ended) {
        try {
          setStatus((s) => (s === 'ended' ? s : 'connecting'));
          const stream = api.streamRunLogs(fnId, runId, {
            afterSeq: lastSeqRef.current,
            signal: controller.signal,
          });
          for await (const chunk of stream) {
            if (cancelled) return;
            handleChunk(chunk);
            if (chunk.type === 'end') {
              ended = true;
              setStatus('ended');
              return;
            }
            if (chunk.type === 'error') {
              ended = true;
              setStatus('error');
              setErrorMsg(chunk.message);
              return;
            }
          }
          // Stream closed without an explicit end frame. If the run is still
          // active, loop and resume; otherwise treat as ended.
          if (!active) {
            setStatus('ended');
            return;
          }
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          setStatus('error');
          setErrorMsg((err as Error).message);
          // Back off briefly, then resume from lastSeq.
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    };

    const handleChunk = (chunk: RunLogChunk) => {
      if (chunk.type === 'log') {
        lastSeqRef.current = Math.max(lastSeqRef.current, chunk.seq);
        setLines((cur) => [...cur, { seq: chunk.seq, stream: chunk.stream, text: chunk.text }]);
        setStatus('streaming');
      } else if (chunk.type === 'state') {
        onStreamUpdate?.({
          state: chunk.state,
          runOutcome: chunk.runOutcome,
          exitCode: chunk.exitCode,
          errorMessage: chunk.errorMessage,
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // onStreamUpdate intentionally excluded — parents pass a fresh closure each
    // render; we don't want to tear down the stream on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fnId, runId, active]);

  // Auto-scroll to the bottom on new lines, but only while the user is pinned
  // there (so scrolling up to read history isn't yanked back down).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickToBottomRef.current = atBottom;
  };

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--bg-elev-2)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          fontSize: 12,
          color: 'var(--fg-muted)',
        }}
      >
        <Icon name="fileLines" size={12} color="var(--fg-muted)" />
        <span style={{ fontWeight: 500, color: 'var(--fg)' }}>Logs</span>
        <span style={{ color: 'var(--fg-subtle)' }}>·</span>
        <StreamBadge status={status} />
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          {lines.length} line{lines.length === 1 ? '' : 's'}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll mono"
        style={{
          maxHeight: 420,
          minHeight: 160,
          overflowY: 'auto',
          padding: '10px 14px',
          fontSize: 12.5,
          lineHeight: 1.5,
          background: 'var(--bg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {lines.length === 0 ? (
          <div style={{ color: 'var(--fg-subtle)' }}>
            {status === 'error'
              ? `Stream error: ${errorMsg ?? 'unknown'}`
              : 'Waiting for output…'}
          </div>
        ) : (
          lines.map((line) => (
            <span
              key={line.seq}
              style={{
                display: 'block',
                color: line.stream === 'stderr' ? 'var(--err, #e5484d)' : 'var(--fg)',
              }}
            >
              {line.text.replace(/\n$/, '')}
            </span>
          ))
        )}
        {status === 'error' && lines.length > 0 && (
          <div style={{ color: 'var(--err, #e5484d)', marginTop: 6 }}>
            Stream error: {errorMsg ?? 'unknown'} — retrying…
          </div>
        )}
      </div>
    </div>
  );
}

function StreamBadge({
  status,
}: {
  status: 'connecting' | 'streaming' | 'ended' | 'error';
}) {
  const meta: Record<typeof status, { label: string; color: string; spin?: boolean }> = {
    connecting: { label: 'Connecting', color: 'var(--warn, #f5a524)', spin: true },
    streaming: { label: 'Live', color: 'var(--ok)', spin: false },
    ended: { label: 'Ended', color: 'var(--fg-subtle)', spin: false },
    error: { label: 'Reconnecting', color: 'var(--warn, #f5a524)', spin: true },
  };
  const m = meta[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: m.color }}>
      {m.spin ? (
        <Icon name="spinner" size={10} color={m.color} className="spin" />
      ) : (
        <span className="status-dot" style={{ background: m.color }} />
      )}
      {m.label}
    </span>
  );
}
