import { describe, expect, it } from 'vitest';
import { entryPathFor, pickEntryPath, primaryEntryPath, rebuildSourceMap } from './entryPath';

describe('pickEntryPath', () => {
  it('routes plain TS to src/index.ts', () => {
    expect(pickEntryPath('export default { fetch() {} }')).toBe('src/index.ts');
  });
  it('routes JSX to src/index.tsx', () => {
    expect(pickEntryPath('const App = () => <div>hi</div>;')).toBe('src/index.tsx');
  });
});

describe('primaryEntryPath', () => {
  it('opens main.py for a healthy python-job regardless of key order', () => {
    expect(
      primaryEntryPath('python-job', { 'requirements.txt': 'torch', 'main.py': 'print(1)' })
    ).toBe('main.py');
  });
  it('opens the code file (not requirements.txt) for a corrupted python-job', () => {
    expect(
      primaryEntryPath('python-job', { 'requirements.txt': 'torch', 'src/index.ts': 'print(1)' })
    ).toBe('src/index.ts');
  });
  it('opens src/index.ts for a TS service', () => {
    expect(primaryEntryPath('function', { 'src/index.ts': 'export default {}' })).toBe(
      'src/index.ts'
    );
  });
});

describe('entryPathFor', () => {
  it('keeps main.py for a python-job', () => {
    expect(entryPathFor('python-job', 'print(1)', 'main.py')).toBe('main.py');
  });
  it('keeps src/main.py for a python-job', () => {
    expect(entryPathFor('python-job', 'print(1)', 'src/main.py')).toBe('src/main.py');
  });
  // The regression: a python-job whose entry was mis-saved as src/index.ts must
  // be normalized back to a runner-probed entry.
  it('self-heals a python-job mis-saved under src/index.ts', () => {
    expect(entryPathFor('python-job', 'print(1)', 'src/index.ts')).toBe('main.py');
  });
  it('flips a TS service to .tsx when JSX appears', () => {
    expect(entryPathFor('function', 'const x = <div/>;', 'src/index.ts')).toBe('src/index.tsx');
  });
  it('keeps a TS service on .ts without JSX', () => {
    expect(entryPathFor('function', 'export default {}', 'src/index.ts')).toBe('src/index.ts');
  });
});

describe('rebuildSourceMap (the editor save transform)', () => {
  it('preserves main.py + requirements.txt on a python-job edit', () => {
    expect(
      rebuildSourceMap('python-job', { 'main.py': 'old', 'requirements.txt': 'torch' }, 'main.py', 'new')
    ).toEqual({ 'requirements.txt': 'torch', 'main.py': 'new' });
  });
  it('heals a corrupted python-job: drops src/index.ts, restores main.py', () => {
    const out = rebuildSourceMap(
      'python-job',
      { 'requirements.txt': 'torch', 'src/index.ts': 'oldpy' },
      'src/index.ts',
      'newpy'
    );
    expect(out).toEqual({ 'requirements.txt': 'torch', 'main.py': 'newpy' });
    expect(out['src/index.ts']).toBeUndefined();
  });
  it('flips a TS service entry .ts -> .tsx when JSX is added', () => {
    expect(
      rebuildSourceMap('function', { 'src/index.ts': 'old' }, 'src/index.ts', 'const x = <div/>;')
    ).toEqual({ 'src/index.tsx': 'const x = <div/>;' });
  });
});
