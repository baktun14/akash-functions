import { useEffect, useState } from 'react';
import { api } from './api';

const POLL_INTERVAL_MS = 2000;

// Akash flips a deployment to 'live' as soon as the manifest is accepted, but
// the provider's nginx keeps returning 503 for ~10-30s until the upstream
// container is actually serving. The browser can't see 5xx status in `no-cors`
// fetches, so we ask the server to probe (it can read status codes) and gate
// "ready" UI on the result. Returns false until the server confirms the
// ingress is reachable; stops polling once it is.
export function useReachable(fnId: string, active: boolean): boolean {
  const [reachable, setReachable] = useState(false);

  useEffect(() => {
    setReachable(false);
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const { reachable: ok } = await api.getIngressReachable(fnId);
        if (cancelled) return;
        if (ok) {
          setReachable(true);
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fnId, active]);

  return reachable;
}
