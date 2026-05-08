// Official three-triangle Akash mark — same path data as assets/akash-sign-*.svg.

type Props = {
  size?: number;
  color?: string;
  className?: string;
};

export function AkashSign({ size = 22, color = '#fff', className }: Props) {
  return (
    <svg
      width={size}
      height={size * (164 / 185)}
      viewBox="0 0 185 164"
      fill={color}
      style={{ display: 'inline-block' }}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M115.175 107.912L139.598 136.586L153.657 161.428H92.1939L61.4454 107.912H115.175Z" />
      <path d="M153.64 161.437L184.338 107.921L122.892 0.861938H61.4454L153.64 161.437Z" />
      <path d="M30.7231 54.3643H92.1694L30.7486 161.423L0.000183105 107.907L30.7231 54.3643Z" />
    </svg>
  );
}
