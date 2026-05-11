// Right-docked chat surface. Renders next to whichever editor is open (the
// `.builder` grid switches to 3 columns via .builder.with-agent) or beside the
// route content when no editor is mounted.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../icons';
import { useActiveEditor } from './ActiveEditorContext';
import { MessageList } from './MessageList';
import { useAgentChat } from './useAgentChat';

type Props = {
  onClose: () => void;
  /** Invoked when the user clicks "Use as new function" on a code block while
   *  no editor is currently open. The Layout owns the builder-open flow. */
  onUseAsNewFunction: (code: string) => void;
};

export function AgentPanel({ onClose, onUseAsNewFunction }: Props): ReactElement {
  // Re-read the AkashML connection each render so connecting it from the
  // builder reflects here without a remount.
  const [conn, setConn] = useState(() => api.getAkashMLConnection());
  const [keyInput, setKeyInput] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);

  const active = useActiveEditor();
  const getActive = useMemo(() => () => active, [active]);
  const getAkashmlKey = useMemo(() => () => conn?.key ?? null, [conn]);

  const chat = useAgentChat(getActive, getAkashmlKey);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Esc closes the panel only when the composer isn't focused, otherwise it
  // collides with users dismissing autocomplete or partial input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement !== inputRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    void chat.send(trimmed);
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. Matches Linear / Slack.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const connect = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    const next = api.saveAkashMLConnection(trimmed);
    setConn(next);
    setKeyInput('');
    setConnectOpen(false);
  };

  const disconnect = () => {
    api.clearAkashMLConnection();
    setConn(null);
  };

  const composerDisabled = !conn || chat.pending;

  return (
    <aside className="agent-panel">
      {/* Header */}
      <div className="agent-panel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="sparkles" size={14} color="var(--accent)" />
          <div style={{ fontSize: 13, fontWeight: 600 }}>Akash Agent</div>
        </div>
        <div style={{ flex: 1 }} />
        {chat.messages.length > 0 && (
          <button
            onClick={chat.reset}
            className="btn btn-ghost btn-sm"
            title="Clear conversation"
            style={{ padding: 6 }}
          >
            <Icon name="refresh" size={12} />
          </button>
        )}
        <button
          onClick={onClose}
          className="btn btn-ghost btn-sm"
          aria-label="Close agent"
          style={{ padding: 6 }}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      {/* AkashML connection chip */}
      <div className="agent-panel-conn">
        <Icon
          name={conn ? 'check' : 'lock'}
          size={11}
          color={conn ? 'var(--ok)' : 'var(--accent)'}
        />
        {conn ? (
          <>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              AkashML connected · <span className="mono">…{conn.last4}</span>
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={disconnect}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              Disconnect
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              Connect your AkashML key to chat.
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setConnectOpen((o) => !o)}
              className="btn btn-primary btn-sm"
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              Connect
            </button>
          </>
        )}
      </div>
      {connectOpen && !conn && (
        <div className="agent-panel-connect">
          <input
            className="input mono"
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk_aml_…"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && connect()}
            style={{ flex: 1 }}
          />
          <button onClick={connect} className="btn btn-primary btn-sm">
            Save
          </button>
        </div>
      )}

      {/* Active-editor context indicator */}
      {active && (
        <div className="agent-panel-context">
          <Icon name="file" size={11} color="var(--fg-subtle)" />
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            Context:{' '}
            <span className="mono" style={{ color: 'var(--fg)' }}>
              {active.mode === 'create'
                ? `new ${active.preset}${active.name ? ` · ${active.name}` : ''}`
                : `${active.functionName} · ${active.primaryPath}`}
            </span>
          </span>
        </div>
      )}

      {/* Messages */}
      <MessageList
        messages={chat.messages}
        pending={chat.pending}
        onUseAsNewFunction={onUseAsNewFunction}
      />

      {chat.error && (
        <div className="agent-panel-error">
          <Icon name="info" size={11} />
          {chat.error}
        </div>
      )}

      {/* Composer */}
      <div className="agent-panel-composer">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={
            conn ? 'Describe a function or an edit…' : 'Connect AkashML to start chatting'
          }
          rows={2}
          disabled={composerDisabled}
        />
        {chat.pending ? (
          <button onClick={chat.cancel} className="btn btn-ghost btn-sm" style={{ gap: 6 }}>
            <Icon name="x" size={12} />
            Stop
          </button>
        ) : (
          <button
            onClick={submit}
            className="btn btn-primary btn-sm"
            disabled={composerDisabled || text.trim().length === 0}
            style={{ gap: 6 }}
          >
            <Icon name="send" size={12} />
            Send
          </button>
        )}
      </div>
    </aside>
  );
}
