// Polls the functions list while any function is in a transient state
// (pending/bidding/leased). Stops polling once everything is settled, which
// keeps the request count down for typical idle pages.

import { useEffect, useRef, useState } from 'react';
import type { FunctionRecord, ServiceStatus } from '@shared/types';
import { api } from './api';

// 'waiting' (wait-for-capacity) is transient too — keep polling so the card
// flips to online the moment a retry burst lands a lease.
const TRANSIENT: ServiceStatus[] = ['pending', 'waiting'];
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 30_000;

export function useFunctions(): {
  services: FunctionRecord[];
  refresh: () => Promise<void>;
  setLocal: (next: FunctionRecord[] | ((prev: FunctionRecord[]) => FunctionRecord[])) => void;
} {
  const [services, setServices] = useState<FunctionRecord[]>([]);
  const cancelledRef = useRef(false);

  const refresh = async () => {
    const list = await api.listServices();
    if (!cancelledRef.current) setServices(list);
  };

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const list = await api.listServices();
        if (cancelledRef.current) return;
        setServices(list);
        const anyTransient = list.some((s) => TRANSIENT.includes(s.status));
        timer = setTimeout(tick, anyTransient ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      } catch {
        if (!cancelledRef.current) timer = setTimeout(tick, IDLE_POLL_MS);
      }
    };
    void tick();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { services, refresh, setLocal: setServices };
}
