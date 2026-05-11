import type { CSSProperties, ReactElement } from 'react';

// Lucide-style stroke icon library. Names cover the full surface used by the
// prototype — adding a new one means appending to PATHS only.

const PATHS: Record<string, ReactElement> = {
  x: <><path d="M18 6 6 18" /><path d="M6 6l12 12" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronUp: <path d="m18 15-6-6-6 6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  sparkles: <path d="m12 3-1.9 5.5L4.5 10l5.6 1.5L12 17l1.9-5.5L19.5 10l-5.6-1.5L12 3Z" />,
  network: <><rect x="16" y="16" width="6" height="6" rx="1" /><rect x="2" y="16" width="6" height="6" rx="1" /><rect x="9" y="2" width="6" height="6" rx="1" /><path d="M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" /><path d="M12 12V8" /></>,
  chart: <><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></>,
  book: <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c5 0 8.5 4 10 8a13 13 0 0 1-1.67 2.68" /><path d="M6.1 6.1C3.5 7.7 2 12 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="m1 1 22 22" /><path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" /></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  edit: <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v7H3V3h7" /></>,
  bolt: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
  minimize: <><path d="M9 9V3" /><path d="M3 9h6" /><path d="M21 9h-6V3" /><path d="M3 15h6v6" /><path d="M21 15h-6v6" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  db: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></>,
  cube: <><path d="m21 16-9 5-9-5V8l9-5 9 5z" /><path d="m3.27 8 8.73 5 8.73-5" /><path d="M12 22V12" /></>,
  globe: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20A15 15 0 0 1 12 2Z" /></>,
  cpu: <><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" /></>,
  coin: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M9 9.5C9 8 10 7 12 7s3 1 3 2.5-1 2.5-3 2.5-3 1-3 2.5S10 17 12 17s3-1 3-2.5" /></>,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  fn: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 8h5M9 12h3M9 16h2" /></>,
  flag: <><path d="M4 22V4" /><path d="M4 4h13l-2 4 2 4H4" /></>,
  arrowUp: <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>,
  arrowRight: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  arrowLeft: <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
  play: <path d="M5 3 19 12 5 21z" />,
  box: <><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /></>,
  user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  cron: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  web: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M9 21V9" /></>,
  gpu: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="8.5" cy="12" r="2" /><circle cx="15.5" cy="12" r="2" /></>,
  storage: <><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /><circle cx="7" cy="7" r="0.6" /><circle cx="7" cy="17" r="0.6" /></>,
  keys: <><circle cx="7.5" cy="15.5" r="3.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></>,
  fileLines: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8M8 17h6" /></>,
  headset: <><path d="M3 13a9 9 0 0 1 18 0v5a2 2 0 0 1-2 2h-1v-7h3" /><path d="M3 13v5a2 2 0 0 0 2 2h1v-7H3" /></>,
  rocket: <><path d="M4 14a4 4 0 0 1 4-4l4-4a8 8 0 0 1 8-2 8 8 0 0 1-2 8l-4 4a4 4 0 0 1-4 4l-2-2 2-3-3 2-2-2" /><circle cx="14" cy="8" r="1.4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  send: <path d="m22 2-7 20-4-9-9-4 20-7Z" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m21 15-5-5-9 9" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />,
  spinner: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
};

export type IconName = keyof typeof PATHS;

type Props = {
  name: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
};

export function Icon({
  name,
  size = 16,
  color = 'currentColor',
  strokeWidth = 1.5,
  style,
  className,
}: Props): ReactElement | null {
  const path = PATHS[name];
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}
