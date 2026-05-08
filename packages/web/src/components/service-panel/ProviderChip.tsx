import { FlagUS, Icon } from '../icons';

export function ProviderChip({ small }: { small?: boolean }) {
  return (
    <span
      className="pill"
      style={{
        padding: small ? '3px 9px' : '5px 10px',
        background: 'var(--bg-elev-2)',
        borderColor: 'var(--line-strong)',
        fontSize: small ? 11 : 12,
        gap: 8,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="globe" size={11} color="var(--fg-muted)" />
        <span style={{ color: 'var(--fg)', fontSize: small ? 11 : 12 }}>US West</span>
        <FlagUS />
      </span>
    </span>
  );
}
