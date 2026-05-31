// Source-map entry contract — shared by the builder (writes the map), the
// server's /code endpoint (delivers it verbatim) and the runner (reads it to
// find the program to run). Getting the entry FILENAME wrong silently drops the
// program: a python-job whose `main.py` is re-keyed to `src/index.ts` extracts
// fine but the runner's entry-point probe (main.py / src/main.py / app.py /
// run.py) finds nothing and the run dies at boot with "No Python entry point
// found". Keep this the ONE place that decides entry filenames.

import type { FunctionKind } from '@shared/types';

// Detects JSX content via an unambiguous closing-tag (or self-closing) pattern.
// TS generics like `Promise<T>` lack `</T>` and never carry attributes, so they
// don't match. Used to route a TS-service entry to .tsx when JSX is present,
// since Bun rejects JSX inside .ts files.
const JSX_TAG = /<\/[A-Za-z][\w-]*\s*>|<[A-Za-z][\w-]*[^<>]*\/>/;

// TS-service entry; flips .ts <-> .tsx by JSX presence.
export function pickEntryPath(code: string): 'src/index.tsx' | 'src/index.ts' {
  return JSX_TAG.test(code) ? 'src/index.tsx' : 'src/index.ts';
}

// Preferred editable "primary" file per kind — which file the editor opens.
// Order matters: first match wins.
const PRIMARY_CANDIDATES: Record<FunctionKind, string[]> = {
  function: ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx'],
  'python-job': ['main.py', 'src/main.py', 'app.py', 'run.py'],
};

// Entry filenames the python runner probes, in order (mirrors ENTRY_CANDIDATES
// in packages/runner/boot-job.ts). A python-job MUST land its code on one of
// these or it won't run.
const PY_ENTRY = /^(main\.py|src\/main\.py|app\.py|run\.py)$/;

// The file the editor should open as the primary editable entry. Falls back to
// the first non-deps key, then any key, so a single-file or oddly-shaped source
// (incl. a python-job previously corrupted to {requirements.txt, src/index.ts})
// still resolves to the actual code file rather than the deps manifest.
export function primaryEntryPath(kind: FunctionKind, source: Record<string, string>): string {
  for (const candidate of PRIMARY_CANDIDATES[kind]) {
    if (candidate in source) return candidate;
  }
  const keys = Object.keys(source);
  const nonDeps = keys.find((k) => k !== 'requirements.txt');
  return nonDeps ?? keys[0] ?? (kind === 'python-job' ? 'main.py' : 'src/index.ts');
}

// Where to write the edited entry back on save. TS services flip .ts <-> .tsx as
// JSX is added/removed. Python jobs MUST keep a runner-probed .py entry: keep the
// current one if it already is one, else normalize to main.py — which also
// self-heals a version previously mis-saved under a TS path like src/index.ts.
export function entryPathFor(
  kind: FunctionKind,
  code: string,
  currentPrimaryPath: string
): string {
  if (kind !== 'python-job') return pickEntryPath(code);
  return PY_ENTRY.test(currentPrimaryPath) ? currentPrimaryPath : 'main.py';
}

// Rebuild a source map after an edit: drop the old primary file and write the
// edited content under the correct entry path for the kind. This is the exact
// transform the builder applies on save — exported so it has one tested home.
export function rebuildSourceMap(
  kind: FunctionKind,
  source: Record<string, string>,
  primaryPath: string,
  edited: string
): Record<string, string> {
  const target = entryPathFor(kind, edited, primaryPath);
  const rest = { ...source };
  delete rest[primaryPath];
  return { ...rest, [target]: edited };
}
