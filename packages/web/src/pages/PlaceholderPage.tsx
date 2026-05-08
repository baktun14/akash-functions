import type { ReactElement } from 'react';

export function PlaceholderPage({ label }: { label: string }): ReactElement {
  return (
    <div
      className="page-in"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 8,
        color: 'var(--fg-muted)',
      }}
    >
      <div className="eyebrow">Coming soon</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          color: 'var(--fg)',
          letterSpacing: '-0.015em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, maxWidth: 360, textAlign: 'center' }}>
        This view is on the roadmap. For now, manage everything from the Functions list.
      </div>
    </div>
  );
}
