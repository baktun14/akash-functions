// Debounced "how many providers match this spec?" call. Returns idle/loading/
// ready states the UI can render straight as inline status text.
//
// Pass `enabled=false` (or omit the spec) to skip the check entirely — used
// when the user hasn't opened the Adjust panel, so preset defaults aren't
// subject to feasibility nag UI.

import { useEffect, useRef, useState } from 'react';
import type { FeasibilityCheck, ResourceRequest } from '@shared/types';
import { api } from './api';

const DEBOUNCE_MS = 400;

export type FeasibilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: FeasibilityCheck }
  | { status: 'error'; error: string };

export function useFeasibility(
  spec: ResourceRequest | null,
  enabled: boolean
): FeasibilityState {
  const [state, setState] = useState<FeasibilityState>({ status: 'idle' });
  const reqId = useRef(0);

  useEffect(() => {
    if (!enabled || !spec) {
      setState({ status: 'idle' });
      return;
    }
    const myId = ++reqId.current;
    setState((prev) =>
      prev.status === 'ready' ? prev : { status: 'loading' }
    );

    const t = setTimeout(() => {
      api.checkFeasibility(spec).then(
        (result) => {
          if (myId === reqId.current) setState({ status: 'ready', result });
        },
        (err) => {
          if (myId === reqId.current) setState({ status: 'error', error: String(err) });
        }
      );
    }, DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [enabled, specKey(spec)]);

  return state;
}

// Stable string key for the spec so useEffect deps cover all dimensions
// without forcing callers to memoize the object.
function specKey(spec: ResourceRequest | null): string {
  if (!spec) return '';
  const g = spec.gpu;
  return [
    spec.cpu,
    spec.memory,
    spec.storage,
    g ? `${g.vendor}/${g.model}/${g.units ?? 1}` : '-',
  ].join('|');
}
