export function FlagUS() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 11,
        borderRadius: 2,
        overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18)',
      }}
      aria-label="US"
    >
      <svg viewBox="0 0 24 16" width="16" height="11">
        <rect width="24" height="16" fill="#0A2461" />
        <g fill="#fff">
          {Array.from({ length: 7 }).map((_, i) => (
            <rect
              key={i}
              y={i * 2.3}
              width="24"
              height="1.15"
              fill={i % 2 ? '#fff' : '#D02F44'}
            />
          ))}
          <rect width="11" height="8" fill="#0A2461" />
          {Array.from({ length: 12 }).map((_, i) => (
            <circle
              key={i}
              cx={1.5 + (i % 4) * 2.5}
              cy={1.5 + Math.floor(i / 4) * 2.5}
              r="0.4"
              fill="#fff"
            />
          ))}
        </g>
      </svg>
    </span>
  );
}
