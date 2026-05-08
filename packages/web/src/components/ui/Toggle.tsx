import { useState } from 'react';

type Props = {
  label: string;
  checked: boolean;
};

export function Toggle({ label, checked }: Props) {
  const [on, setOn] = useState(checked);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span style={{ fontSize: 13.5, flex: 1 }}>{label}</span>
      <button
        onClick={() => setOn((v) => !v)}
        style={{
          width: 36,
          height: 20,
          borderRadius: 9999,
          background: on ? 'var(--ok)' : 'var(--bg-elev-4)',
          border: '1px solid ' + (on ? 'var(--ok)' : 'var(--line-strong)'),
          padding: 0,
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 160ms',
        }}
        aria-pressed={on}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: on ? 17 : 1,
            width: 16,
            height: 16,
            borderRadius: 9999,
            background: '#fff',
            transition: 'left 160ms',
          }}
        />
      </button>
    </div>
  );
}
