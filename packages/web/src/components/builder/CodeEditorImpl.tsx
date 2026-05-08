// Thin CodeMirror 6 wrapper. Mounts an EditorView, lets the parent control
// `value` from the outside while still allowing local edits to flow back via
// onChange. Used in both edit-mode (FunctionEditor) and read-only previews
// (SourceCodeTab, HistoryTab) so the look stays consistent.

import { useEffect, useRef, type ReactElement } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';

type Props = {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  minHeight?: number;
};

export function CodeEditor({ value, onChange, readOnly, minHeight = 280 }: Props): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest onChange held in a ref so the editor's update listener never goes
  // stale without forcing a remount of the whole view.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    });

    const themeOverrides = EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: 'var(--bg-elev-2)',
      },
      '.cm-scroller': {
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
        lineHeight: '1.55',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        borderRight: '1px solid var(--line)',
        color: 'var(--fg-subtle)',
      },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--fg-muted)',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-content': { padding: '12px 0' },
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        javascript({ jsx: true, typescript: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        oneDark,
        themeOverrides,
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(!!readOnly),
        EditorView.lineWrapping,
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We intentionally only construct the view once; subsequent prop changes
    // are funneled through dedicated effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // Sync external value changes (e.g., loading a different version) into the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      style={{
        minHeight,
        height: '100%',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    />
  );
}
