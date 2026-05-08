type Props = { size?: number };

export function FnLogo({ size = 28 }: Props) {
  const cls = size >= 36 ? 'fn-logo fn-logo-lg' : 'fn-logo';
  return (
    <span
      className={cls}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      <span style={{ fontStyle: 'italic', fontWeight: 700 }}>f</span>
    </span>
  );
}
