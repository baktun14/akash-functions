import { useEffect, useState } from 'react';
import { api } from './api';
import { sessionDeploys } from './sessionDeploys';

const POLL_INTERVAL_MS = 2000;

// Akash flips a deployment to 'live' as soon as the manifest is accepted, but
// the provider's nginx keeps returning 503 for ~10-30s until the upstream
// container is actually serving. The browser can't see 5xx status in `no-cors`
// fetches, so we ask the server to probe (it can read status codes) and gate
// "ready" UI on the result.
//
// Returns `true` when there's nothing to probe — `active` is false, or this
// fnId was already confirmed reachable earlier in the session. Otherwise
// starts at `false` and polls until the server confirms the ingress is
// reachable, then stops. Callers should pass `active=true` only when a deploy
// has been initiated in the current session (see sessionDeploys); for already-
// live functions loaded from the server we trust the status and skip probing.
export function useReachable(fnId: string, active: boolean): boolean {
  const [reachable, setReachable] = useState(() => !active || sessionDeploys.confirmed(fnId));

  useEffect(() => {
    if (!active || sessionDeploys.confirmed(fnId)) {
      setReachable(true);
      return;
    }
    setReachable(false);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const { reachable: ok } = await api.getIngressReachable(fnId);
        if (cancelled) return;
        if (ok) {
          sessionDeploys.confirm(fnId);
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
