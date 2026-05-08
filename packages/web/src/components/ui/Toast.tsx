import type { ToastMsg } from '@shared/types';
import { Icon } from '../icons';

export function Toast({ toast }: { toast: ToastMsg }) {
  const color = toast.kind === 'ok' ? 'var(--ok)' : 'var(--accent-soft)';
  const iconName = toast.kind === 'ok' ? 'check' : 'info';
  return (
    <div className="toast">
      <Icon name={iconName} size={14} color={color} />
      <span style={{ fontSize: 13, color: 'var(--fg)' }}>{toast.text}</span>
    </div>
  );
}
