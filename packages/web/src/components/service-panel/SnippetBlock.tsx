// Tokenized code snippet renderer with copy button.
// Token rows are flat [class, text, class, text, …] arrays.

import { useState } from 'react';
import { Icon } from '../icons';

type Line = string[];

type Props = {
  tokens: Line[];
};

export function SnippetBlock({ tokens }: Props) {
  const [copied, setCopied] = useState(false);

  const plain = tokens
    .map((line) => (line.length === 0 ? '' : line.map((t, i) => (i % 2 === 1 ? t : '')).join('')))
    .join('\n');

  const onCopy = () => {
    navigator.clipboard?.writeText(plain).catch(() => undefined);
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
        {tokens.map((line, i) => (
          <div key={i} style={{ whiteSpace: 'pre' }}>
            {line.length === 0
              ? ' '
              : line.map((t, j) => {
                  if (j % 2 === 1) return null;
                  const cls = t;
                  const txt = line[j + 1] ?? '';
                  return (
                    <span key={j} className={`tok-${cls}`}>
                      {txt}
                    </span>
                  );
                })}
          </div>
        ))}
      </div>
    </div>
  );
}
