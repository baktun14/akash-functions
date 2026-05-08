type Props = { color?: string; size?: number };

export function StatusDot({ color = 'var(--ok)', size = 7 }: Props) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 9999,
        background: color,
        position: 'relative',
        boxShadow: `0 0 0 0 ${color}`,
        animation: 'dot-pulse 2.4s var(--ease-out) infinite',
      }}
      aria-hidden="true"
    />
  );
}
