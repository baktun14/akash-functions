type Props = { initials?: string; size?: number };

export function Avatar({ initials = 'MX', size = 24 }: Props) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
