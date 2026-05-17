import { useEffect, useState } from 'react';
import { api } from './api';
import { sessionDeploys } from './sessionDeploys';

const POLL_INTERVAL_MS = 2000;
// Belt-and-suspenders cap on the in-session probe loop. The server's probe
// already trusts the runner heartbeat (see routes/deploy.ts), so the common
// "slow boot" case flips to reachable within a few seconds of state='live'.
// This budget covers the pathological case where the runner never reports at
// all — without it, the UI would sit on "Finalizing your endpoint" forever.
// After the budget elapses we adopt the same trust the post-refresh code path
// uses: if the server says state='live', show the URL/routes.
// 90s matches the reconciler's RUNNER_FRESH_MS — same threshold either side.
const PROBE_BUDGET_MS = 90_000;

// Akash flips a deployment to 'live' as soon as the manifest is accepted, but
// the provider's nginx keeps returning 503 for ~10-30s until the upstream
// container is actually serving. The browser can't see 5xx status in `no-cors`
// fetches, so we ask the server to probe (it can read status codes) and gate
// "ready" UI on the result.
//
// Returns `true` when there's nothing to probe — `active` is false, or this
// fnId was already confirmed reachable earlier in the session. Otherwise
// returns `false` until the server confirms the ingress is reachable, then
// stops. Callers should pass `active=true` only when a deploy has been
// initiated in the current session (see sessionDeploys); for already-live
// functions loaded from the server we trust the status and skip probing.
//
// Reachability is *derived per render* from the module-scope sessionDeploys
// set rather than mirrored into React state. Mirroring caused a single-frame
// flicker on the bidding → live transition: the previous render had
// `reachable=true` (carried over from when active=false), and the new render
// saw `active=true` but kept the stale true until useEffect committed
// `setReachable(false)` on the next tick. The result was one frame of "live +
// reachable" UI (URL bar, routes panel) appearing between "Starting" and
// "Finishing up". The forceRender below is purely a bridge that lets us
// notify React when sessionDeploys.confirm() flips the underlying set.
export function useReachable(fnId: string, active: boolean): boolean {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!active || sessionDeploys.confirmed(fnId)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const { reachable: ok } = await api.getIngressReachable(fnId);
        if (cancelled) return;
        if (ok) {
          sessionDeploys.confirm(fnId);
          forceRender((n) => n + 1);
          return;
        }
      } catch {
        /* keep polling */
      }
      if (cancelled) return;
      if (Date.now() - startedAt >= PROBE_BUDGET_MS) {
        sessionDeploys.confirm(fnId);
        forceRender((n) => n + 1);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fnId, active]);

  return !active || sessionDeploys.confirmed(fnId);
}
