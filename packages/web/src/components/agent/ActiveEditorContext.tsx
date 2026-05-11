// Tracks whichever function editor is currently mounted so the agent panel can
// (a) include the current source as context in chat requests and (b) write the
// agent's "Apply" results back into that editor's React state.
//
// Only one editor is ever mounted at a time (FunctionBuilder and FunctionEditor
// are siblings, not nested), so the registry is a single optional slot rather
// than a keyed map.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { PresetId } from '@shared/types';

export type ActiveEditor =
  | {
      mode: 'create';
      preset: PresetId;
      name?: string;
      currentSource: string;
      applySource: (next: string) => void;
    }
  | {
      mode: 'edit';
      functionId: string;
      functionName: string;
      primaryPath: string;
      currentSource: string;
      applySource: (next: string) => void;
    };

type Ctx = {
  active: ActiveEditor | null;
  setActive: (a: ActiveEditor | null) => void;
};

const ActiveEditorCtx = createContext<Ctx | null>(null);

export function ActiveEditorProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveEditor | null>(null);
  const value = useMemo(() => ({ active, setActive }), [active]);
  return <ActiveEditorCtx.Provider value={value}>{children}</ActiveEditorCtx.Provider>;
}

export function useActiveEditor(): ActiveEditor | null {
  const ctx = useContext(ActiveEditorCtx);
  return ctx?.active ?? null;
}

// Editors call this on mount with a getter for the current snapshot. Re-runs
// when the snapshot's dependencies change so the registry always reflects the
// latest editor state.
export function useRegisterActiveEditor(editor: ActiveEditor): void {
  const ctx = useContext(ActiveEditorCtx);
  // Stable reference so deps below don't churn on every keystroke for unrelated
  // fields — but we DO want re-registration when source/name/etc. change.
  const setActive = ctx?.setActive;
  const applySource = editor.applySource;
  const snapshotKey = JSON.stringify({
    mode: editor.mode,
    ...(editor.mode === 'create'
      ? { preset: editor.preset, name: editor.name }
      : {
          functionId: editor.functionId,
          functionName: editor.functionName,
          primaryPath: editor.primaryPath,
        }),
    currentSource: editor.currentSource,
  });
  const apply = useCallback(applySource, [applySource]);
  useEffect(() => {
    if (!setActive) return;
    const parsed = JSON.parse(snapshotKey) as Omit<ActiveEditor, 'applySource'>;
    setActive({ ...(parsed as ActiveEditor), applySource: apply });
    return () => setActive(null);
  }, [setActive, snapshotKey, apply]);
}
