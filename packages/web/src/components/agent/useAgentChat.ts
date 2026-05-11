// Owns the agent chat conversation: messages, in-flight state, error, and the
// SSE stream. Builds the request from the active editor snapshot so the
// component tree doesn't have to thread context around.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentChatContext,
  AgentChatMessage,
} from '@shared/types';
import { api } from '../../lib/api';
import type { ActiveEditor } from './ActiveEditorContext';

export type AgentChatState = {
  messages: AgentChatMessage[];
  pending: boolean;
  error: string | null;
};

export type UseAgentChat = AgentChatState & {
  send: (text: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
};

function snapshotToContext(active: ActiveEditor | null): AgentChatContext {
  if (!active) return { mode: 'none' };
  if (active.mode === 'create') {
    return {
      mode: 'create',
      preset: active.preset,
      name: active.name,
      currentSource: active.currentSource,
    };
  }
  return {
    mode: 'edit',
    functionId: active.functionId,
    functionName: active.functionName,
    primaryPath: active.primaryPath,
    currentSource: active.currentSource,
  };
}

export function useAgentChat(
  getActive: () => ActiveEditor | null,
  getAkashmlKey: () => string | null
): UseAgentChat {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // setMessages updaters run on the next render, so we can't read `nextMessages`
  // synchronously after queuing a setter. Mirror the state in a ref so `send`
  // can compute the request body without waiting for a render to flush.
  const messagesRef = useRef<AgentChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;
      const akashmlKey = getAkashmlKey();
      if (!akashmlKey) {
        setError('Connect your AkashML key to use the agent.');
        return;
      }

      setError(null);
      setPending(true);

      // Build the request synchronously from the ref so the wire payload always
      // contains the new user turn — independent of when React flushes the
      // updater below. The UI gets a trailing empty assistant turn the stream
      // fills as deltas arrive.
      const wireMessages: AgentChatMessage[] = [
        ...messagesRef.current,
        { role: 'user', content: trimmed },
      ];
      const nextMessages: AgentChatMessage[] = [
        ...wireMessages,
        { role: 'assistant', content: '' },
      ];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const stream = api.agentChatStream(
          {
            messages: wireMessages,
            context: snapshotToContext(getActive()),
            akashmlKey,
          },
          controller.signal
        );
        for await (const chunk of stream) {
          if (chunk.type === 'delta') {
            setMessages((cur) => {
              const next = cur.slice();
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: last.content + chunk.text };
              }
              return next;
            });
          } else if (chunk.type === 'error') {
            setError(chunk.message);
          } else if (chunk.type === 'done') {
            break;
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message || 'Chat failed');
        }
      } finally {
        setPending(false);
        abortRef.current = null;
      }
    },
    [getActive, getAkashmlKey, pending]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setPending(false);
  }, []);

  return { messages, pending, error, send, cancel, reset };
}

// Parses fenced code blocks out of a markdown string. Returns an interleaved
// list of plain text and `code` segments so the UI can render Apply buttons
// next to each block. Greedy on ```lang … ``` only; nested fences are not a
// real concern for generated code.
export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; code: string };

export function splitMessage(content: string): ChatSegment[] {
  const segments: ChatSegment[] = [];
  const fence = /```([a-zA-Z0-9_+-]*)?\n([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, match.index) });
    }
    const lang = (match[1] || '').trim();
    const code = match[2] ?? '';
    segments.push({ kind: 'code', lang, code });
    cursor = fence.lastIndex;
  }
  if (cursor < content.length) {
    segments.push({ kind: 'text', text: content.slice(cursor) });
  }
  return segments;
}
