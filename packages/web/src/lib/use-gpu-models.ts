// Fetches the live GPU dropdown options once per session. Stored on a
// module-level Promise so re-opening the FunctionBuilder doesn't refetch.

import { useEffect, useState } from 'react';
import type { GpuModelOption } from '@shared/types';
import { api } from './api';

let cachedPromise: Promise<GpuModelOption[]> | null = null;

function fetchOnce(): Promise<GpuModelOption[]> {
  if (!cachedPromise) {
    cachedPromise = api.listGpuModels().catch((err) => {
      cachedPromise = null;
      throw err;
    });
  }
  return cachedPromise;
}

export type GpuModelsState =
  | { status: 'loading' }
  | { status: 'ready'; models: GpuModelOption[] }
  | { status: 'error'; error: string };

export function useGpuModels(): GpuModelsState {
  const [state, setState] = useState<GpuModelsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchOnce().then(
      (models) => {
        if (!cancelled) setState({ status: 'ready', models });
      },
      (err) => {
        if (!cancelled) setState({ status: 'error', error: String(err) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
