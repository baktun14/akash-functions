import { useState } from 'react';
import { Icon } from '../../icons';

const RANGES = ['1h', '6h', '1d', '7d', '30d'] as const;
type Range = (typeof RANGES)[number];

export function MetricsTab() {
  const [range, setRange] = useState<Range>('1h');
  return (
    <div style={{ position: 'relative' }}>
      <div
        aria-hidden="true"
        style={{
          filter: 'blur(3px)',
          opacity: 0.45,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 18,
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              padding: 3,
              borderRadius: 9999,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
            }}
          >
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  padding: '5px 14px',
                  borderRadius: 9999,
                  border: 'none',
                  background: range === r ? 'var(--bg-elev-4)' : 'transparent',
                  color: range === r ? 'var(--fg)' : 'var(--fg-muted)',
                  fontSize: 12,
                  fontWeight: 500,
                  fontFamily: 'JetBrains Mono, monospace',
                  cursor: 'pointer',
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'inline-flex',
              padding: 3,
              borderRadius: 8,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--line)',
            }}
          >
            <button
              style={{
                padding: '5px 8px',
                border: 'none',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--fg-muted)',
              }}
            >
              <Icon name="layers" size={13} />
            </button>
            <button
              style={{
                padding: '5px 8px',
                border: 'none',
                borderRadius: 6,
                background: 'var(--bg-elev-4)',
                color: 'var(--fg)',
              }}
            >
              <Icon name="grid" size={13} />
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <MetricTile
            title="CPU"
            unit="vCPU"
            max={0.8}
            kind="line"
            data={[0.04, 0.05, 0.04, 0.05, 0.06, 0.04]}
            accent="#8C8CFF"
          />
          <MetricTile
            title="Memory"
            unit="MB"
            max={400}
            kind="line"
            data={[120, 119, 122, 120, 121, 120]}
            accent="#8C8CFF"
          />
          <MetricTile
            title="Public Network Traffic"
            unit="kB"
            max={50}
            kind="line"
            data={[0.4, 0.6, 0.5, 0.4, 0.6, 0.4]}
            accent="#2BD79F"
          />
          <MetricTile
            title="Requests"
            unit=""
            max={4}
            kind="bar"
            data={[0, 0, 0, 1, 2, 0]}
            accent="#F2C760"
            totalLabel="3 total"
          />
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          className="card"
          style={{
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            maxWidth: 360,
            textAlign: 'center',
            background: 'var(--bg-elev-1)',
            border: '1px solid var(--line)',
          }}
        >
          <Icon name="chart" size={20} color="var(--fg-muted)" />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
            Metrics coming soon
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Real-time CPU, memory, network, and request metrics will be available
            once cloud-deployed functions expose them.
          </div>
        </div>
      </div>
    </div>
  );
}

type MetricProps = {
  title: string;
  unit: string;
  max: number;
  kind: 'line' | 'bar';
  data: number[];
  accent: string;
  totalLabel?: string;
};

function MetricTile({ title, unit, max, kind, data, accent, totalLabel }: MetricProps) {
  const w = 360;
  const h = 110;
  const n = data.length;
  const stepX = w / Math.max(n - 1, 1);
  const points = data.map((v, i) => [i * stepX, h - (v / max) * h] as const);
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = path + ` L ${w} ${h} L 0 ${h} Z`;
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0];
  const fmt = (v: number) =>
    unit === 'MB' ? `${Math.round(v)} MB`
    : unit === 'vCPU' ? `${v.toFixed(1)} vCPU`
    : unit === 'kB' ? `${v} kB`
    : `${Math.round(v)}`;

  return (
    <div className="card" style={{ padding: 14, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{title}</div>
        <div style={{ flex: 1 }} />
        {totalLabel ? (
          <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{totalLabel}</span>
        ) : (
          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--fg-muted)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 9999, background: accent }} /> Sum
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: 0.45 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 9999,
                  border: '1px solid var(--fg-subtle)',
                }}
              />{' '}
              Replicas
            </span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontSize: 10,
            color: 'var(--fg-faint)',
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          {ticks.map((t, i) => (
            <span key={i}>{fmt(t)}</span>
          ))}
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} style={{ flex: 1, height: 110, overflow: 'visible' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <line
              key={i}
              x1="0"
              x2={w}
              y1={(h / 4) * i}
              y2={(h / 4) * i}
              stroke="var(--line)"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
          ))}
          {kind === 'line' ? (
            <>
              <path d={area} fill={accent} fillOpacity="0.08" />
              <path d={path} fill="none" stroke={accent} strokeWidth="1.5" />
              {points.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r="2" fill={accent} />
              ))}
            </>
          ) : (
            data.map((v, i) => {
              const bw = stepX * 0.55;
              const bh = (v / max) * h;
              return (
                <rect
                  key={i}
                  x={i * stepX - bw / 2}
                  y={h - bh}
                  width={bw}
                  height={bh}
                  fill={accent}
                  rx="2"
                />
              );
            })
          )}
        </svg>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: 10,
          color: 'var(--fg-faint)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {['7:45 PM', '7:45 PM', '7:46 PM', '7:46 PM', '7:47 PM'].map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}
