// Code snippet block. Takes a plain string + a language hint and paints two
// things only — comments and string literals. The previous incarnation tried
// to be a real syntax highlighter via a flat [class, text, …] token array; the
// pairs went out of sync, swallowed the URL, and printed the class name as
// text. A minimal regex pass is harder to mis-shift and keeps the snippets
// guaranteed-runnable: the displayed text is always exactly the source string.

import { useState, type ReactNode } from 'react';
import { Icon } from '../icons';

export type SnippetLang = 'shell' | 'js' | 'python';

type Props = {
  code: string;
  lang: SnippetLang;
};

export function SnippetBlock({ code, lang }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard?.writeText(code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div
      className="card"
      style={{ padding: 0, background: '#08080B', position: 'relative', overflow: 'hidden' }}
    >
      <button
        onClick={onCopy}
        className="btn btn-ghost btn-sm"
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 2,
          padding: '4px 10px',
          gap: 6,
          fontSize: 11.5,
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={11} />
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="code-block" style={{ padding: '14px 18px', overflowX: 'auto' }}>
        {code.split('\n').map((line, i) => (
          <div key={i} style={{ whiteSpace: 'pre' }}>
            {line.length === 0 ? ' ' : renderLine(line, lang)}
          </div>
        ))}
      </div>
    </div>
  );
}

// Comment markers per language. JS uses //; shell and Python use # (but only
// when not inside a string — we handle that by tokenising strings first).
const COMMENT_PREFIX: Record<SnippetLang, string> = {
  shell:  '#',
  js:     '//',
  python: '#',
};

// Walks one line left-to-right. Each step either consumes a string literal
// (single- or double-quoted, no escape handling — sufficient for snippet
// samples), a comment-to-end-of-line, or a single plain character.
function renderLine(line: string, lang: SnippetLang): ReactNode[] {
  const out: ReactNode[] = [];
  const commentMarker = COMMENT_PREFIX[lang];
  let buffer = '';
  let i = 0;
  let key = 0;

  const flushPlain = () => {
    if (buffer) {
      out.push(buffer);
      buffer = '';
    }
  };

  while (i < line.length) {
    const ch = line[i]!;

    // Comment to end of line. For JS the marker is two chars (//); for shell/
    // python it's one (#). Anything after gets one tok-c span.
    if (line.startsWith(commentMarker, i)) {
      flushPlain();
      out.push(
        <span key={key++} className="tok-c">
          {line.slice(i)}
        </span>
      );
      return out;
    }

    // String literal. Match the opening quote with the same closing quote.
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      if (end !== -1) {
        flushPlain();
        out.push(
          <span key={key++} className="tok-s">
            {line.slice(i, end + 1)}
          </span>
        );
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }

  flushPlain();
  return out;
}
