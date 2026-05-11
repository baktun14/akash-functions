// Scrollable list of chat turns. User turns render as right-aligned text;
// assistant turns are parsed for fenced code blocks and rendered as alternating
// text + CodeBlock segments.

import { useEffect, useRef, type ReactElement } from 'react';
import type { AgentChatMessage } from '@shared/types';
import { Icon } from '../icons';
import { CodeBlock } from './CodeBlock';
import { splitMessage } from './useAgentChat';

type Props = {
  messages: AgentChatMessage[];
  pending: boolean;
  onUseAsNewFunction: (code: string) => void;
  onQuickFix?: (prompt: string) => void;
};

export function MessageList({
  messages,
  pending,
  onUseAsNewFunction,
  onQuickFix,
}: Props): ReactElement {
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom on every new chunk so streaming output stays in
  // view. Smooth scrolling feels slow for streaming — jump straight to bottom.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);

  if (messages.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '20px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          textAlign: 'center',
          color: 'var(--fg-muted)',
        }}
      >
        <Icon name="sparkles" size={20} color="var(--accent)" />
        <div style={{ fontSize: 13, color: 'var(--fg)' }}>Describe a function, get the code.</div>
        <div style={{ fontSize: 12, maxWidth: 280, lineHeight: 1.5 }}>
          Try: <span className="mono">"a /cats endpoint that returns a list"</span> — or open a
          function and ask for an edit.
        </div>
      </div>
    );
  }

  // While streaming, the last message is an assistant placeholder. Show the
  // typing indicator unconditionally whenever pending=true so the user has
  // immediate feedback regardless of whether deltas have started arriving.
  const lastAssistantEmpty =
    messages[messages.length - 1]?.role === 'assistant' &&
    messages[messages.length - 1]?.content === '';

  return (
    <div
      className="scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '16px 16px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {messages.map((m, i) => {
        // Don't render the empty trailing placeholder — the TypingIndicator
        // below stands in for it until the first delta arrives.
        if (pending && i === messages.length - 1 && lastAssistantEmpty) return null;
        return (
          <Message
            key={i}
            message={m}
            onUseAsNewFunction={onUseAsNewFunction}
            onQuickFix={onQuickFix}
          />
        );
      })}
      {pending && <TypingIndicator />}
      <div ref={endRef} />
    </div>
  );
}

function TypingIndicator() {
  return (
    <div
      style={{
        color: 'var(--fg-muted)',
        fontSize: 12,
        display: 'flex',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <Icon name="spinner" size={12} style={{ animation: 'spin 0.9s linear infinite' }} />
      <span>Thinking</span>
      <span className="dots-anim" />
    </div>
  );
}

function Message({
  message,
  onUseAsNewFunction,
  onQuickFix,
}: {
  message: AgentChatMessage;
  onUseAsNewFunction: (code: string) => void;
  onQuickFix?: (prompt: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            maxWidth: '88%',
            padding: '8px 12px',
            borderRadius: 12,
            borderTopRightRadius: 4,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--line)',
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  const segments = splitMessage(message.content);

  return (
    <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--fg)' }}>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <span key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {seg.text}
          </span>
        ) : (
          <CodeBlock
            key={i}
            code={seg.code}
            lang={seg.lang}
            onUseAsNewFunction={onUseAsNewFunction}
            onQuickFix={onQuickFix}
          />
        )
      )}
    </div>
  );
}
