// CTA to open the Akash Agent panel. Shown in both FunctionBuilder (create)
// and FunctionEditor (edit) right panels when the agent panel is not yet
// docked. Hidden once the agent is open — the panel itself becomes the
// surface.

import { Icon } from '../icons';

export function AgentCTACard({
  onOpen,
  copy = 'Describe a function or refine the scaffold — I’ll write the code.',
}: {
  onOpen: () => void;
  /** Override the secondary line. Useful in the editor where the framing
   *  is "modify this function" rather than "scaffold a new one". */
  copy?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '14px 14px',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        color: 'var(--fg)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'border-color 120ms, background 120ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--line-strong)';
        e.currentTarget.style.background = 'var(--bg-elev-3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
        e.currentTarget.style.background = 'var(--bg-elev-2)';
      }}
    >
      <Icon name="sparkles" size={16} color="var(--accent)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>
          Ask Akash Agent
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
          {copy}
        </div>
      </div>
      <Icon name="chevronRight" size={14} color="var(--fg-muted)" />
    </button>
  );
}
