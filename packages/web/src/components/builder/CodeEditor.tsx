// Lazy-loaded entry point for the CodeMirror editor. The actual implementation
// (and CodeMirror's ~120KB worth of language/theme deps) lives in
// CodeEditorImpl.tsx and is fetched as a separate chunk on first use, so the
// listing page doesn't pay for it.

import { lazy, Suspense, type ReactElement } from 'react';

type Props = {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  minHeight?: number;
};

const CodeEditorImpl = lazy(() =>
  import('./CodeEditorImpl').then((m) => ({ default: m.CodeEditor }))
);

function EditorSkeleton({ minHeight = 280 }: { minHeight?: number }): ReactElement {
  return (
    <div
      style={{
        minHeight,
        height: '100%',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--fg-subtle)',
        fontSize: 12.5,
      }}
    >
      Loading editor…
    </div>
  );
}

export function CodeEditor(props: Props): ReactElement {
  return (
    <Suspense fallback={<EditorSkeleton minHeight={props.minHeight} />}>
      <CodeEditorImpl {...props} />
    </Suspense>
  );
}
