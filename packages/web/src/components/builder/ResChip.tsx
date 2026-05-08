import { Icon } from '../icons';

type Props = {
  icon: string;
  value: string;
  accent?: boolean;
};

export function ResChip({ icon, value, accent }: Props) {
  return (
    <span
      className="pill"
      style={{
        padding: '4px 10px',
        fontSize: 11.5,
        gap: 6,
        background: 'var(--bg-elev-2)',
        borderColor: accent ? 'rgba(255,41,3,0.4)' : 'var(--line-strong)',
        color: accent ? 'var(--accent-soft)' : 'var(--fg)',
      }}
    >
      <Icon name={icon} size={11} />
      <span className="mono" style={{ fontSize: 11 }}>{value}</span>
    </span>
  );
}
