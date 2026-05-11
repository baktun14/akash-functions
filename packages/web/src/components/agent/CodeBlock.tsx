// One generated code block + its action buttons. Apply target depends on
// whether an editor is currently mounted: when yes, "Apply to editor"
// overwrites the active editor's source; when no, "Use as new function" opens
// the builder seeded with this code.

import { useMemo, useState, type ReactElement } from 'react';
import { Icon } from '../icons';
import { detectStartupIssueInFencedBlock } from '../../lib/codeChecks';
import { useActiveEditor } from './ActiveEditorContext';

type Props = {
  code: string;
  lang: string;
  /** Used by the empty-state path: invoked with the code to open the builder
   *  pre-filled. Layout owns this — the panel doesn't need to know how. */
  onUseAsNewFunction: (code: string) => void;
  /** When provided, the warning banner shows a "Ask agent to fix" button that
   *  sends a corrective follow-up to the same conversation. */
  onQuickFix?: (prompt: string) => void;
};

export function CodeBlock({
  code,
  lang,
  onUseAsNewFunction,
  onQuickFix,
}: Props): ReactElement {
  const active = useActiveEditor();
  const [justApplied, setJustApplied] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const issue = useMemo(() => detectStartupIssueInFencedBlock(code, lang), [code, lang]);

  const apply = () => {
    if (!active) return;
    active.applySource(code);
    setJustApplied(true);
    window.setTimeout(() => setJustApplied(false), 1400);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setJustCopied(true);
      window.setTimeout(() => setJustCopied(false), 1400);
    } catch {
      // ignore — clipboard can fail in non-secure contexts; the user can still
      // select and copy by hand.
    }
  };

  return (
    <div
      style={{
        marginTop: 8,
        marginBottom: 8,
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: 'var(--bg-elev-2)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 10.5, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
        >
          {lang || 'code'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={copy} className="btn btn-ghost btn-sm" style={{ gap: 6 }}>
          <Icon name={justCopied ? 'check' : 'copy'} size={12} />
          {justCopied ? 'Copied' : 'Copy'}
        </button>
        {active ? (
          <button onClick={apply} className="btn btn-primary btn-sm" style={{ gap: 6 }}>
            <Icon name={justApplied ? 'check' : 'edit'} size={12} />
            {justApplied ? 'Applied' : 'Apply to editor'}
          </button>
        ) : (
          <button
            onClick={() => onUseAsNewFunction(code)}
            className="btn btn-primary btn-sm"
            style={{ gap: 6 }}
          >
            <Icon name="plus" size={12} />
            Use as new function
          </button>
        )}
      </div>
      {issue && (
        <div className="codeblock-warn" role="alert">
          <Icon name="info" size={11} />
          <span style={{ flex: 1, lineHeight: 1.5 }}>{issue.message}</span>
          {onQuickFix && (
            <button
              type="button"
              onClick={() => onQuickFix(issue.agentPrompt)}
              className="btn btn-ghost btn-sm codeblock-warn-action"
            >
              Ask agent to fix
            </button>
          )}
        </div>
      )}
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: '10px 12px',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--fg)',
          background: 'transparent',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
    </div>
  );
}
