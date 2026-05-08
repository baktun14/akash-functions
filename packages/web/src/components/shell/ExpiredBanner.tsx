import { Icon } from '../icons';

type Props = {
  onReconnect: () => void;
  onDismiss: () => void;
};

export function ExpiredBanner({ onReconnect, onDismiss }: Props) {
  return (
    <div
      className="banner fade-up"
      style={{
        position: 'absolute',
        top: 12,
        left: 16,
        right: 16,
        zIndex: 7,
        borderRadius: 10,
      }}
    >
      <Icon name="info" size={14} color="var(--accent-soft)" />
      <span style={{ fontSize: 13, color: 'var(--fg)' }}>
        Your Akash Console API key has expired or been revoked.
      </span>
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
        Reconnect to continue deploying.
      </span>
      <div style={{ flex: 1 }} />
      <button className="btn btn-ghost btn-sm" onClick={onDismiss}>
        Dismiss
      </button>
      <button className="btn btn-primary btn-sm" onClick={onReconnect}>
        Reconnect
      </button>
    </div>
  );
}
