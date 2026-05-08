// Typed wrapper around console-api.akash.network/v1.
// Auth: the user's Console API key is sent in the `x-api-key` header (the API
// key scheme). We also forward it as `Authorization: Bearer` for users whose
// token is a JWT — the API accepts whichever scheme matches.

import { env } from '../env';

type Money = { denom: string; amount: string };

export type DeploymentCreated = {
  dseq: string;
  manifest: string;
  signTx: { code: number; transactionHash: string; rawLog: string };
};

export type BidId = {
  owner: string;
  dseq: string;
  gseq: number;
  oseq: number;
  provider: string;
  bseq: number;
};

export type Bid = {
  id: BidId;
  state: string;
  price: Money;
  created_at: string;
};

export type LeaseId = {
  owner: string;
  dseq: string;
  gseq: number;
  oseq: number;
  provider: string;
  bseq: number;
};

export type ServiceStatus = {
  name: string;
  available: number;
  total: number;
  uris: string[];
  ready_replicas: number;
  available_replicas: number;
};

export type LeaseStatus = {
  forwarded_ports?: Record<string, unknown>;
  ips?: Record<string, unknown>;
  services: Record<string, ServiceStatus>;
};

export type Lease = {
  id: LeaseId;
  state: string;
  price: Money;
  created_at: string;
  closed_on?: string;
  reason?: string;
  status: LeaseStatus | null;
};

export type DeploymentDetail = {
  deployment: {
    id: { owner: string; dseq: string };
    state: string;
    hash: string;
    created_at: string;
  };
  leases: Lease[];
};

export type LeaseAcceptResp = {
  deployment: DeploymentDetail['deployment'];
  leases: Lease[];
};

export class ConsoleApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function call<T>(
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  // Console API authenticates programmatic clients via `x-api-key`. Sending
  // Authorization too is a 400 ("headers are mutually exclusive").
  const res = await fetch(env.AKASH_API_BASE + path, {
    method,
    headers: {
      'x-api-key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let payload: unknown = null;
    let text = '';
    try {
      text = await res.text();
      payload = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body
    }
    const code =
      (payload as { error?: { code?: string }; code?: string })?.error?.code ??
      (payload as { code?: string })?.code ??
      `HTTP_${res.status}`;
    const message =
      (payload as { error?: { message?: string }; message?: string })?.error?.message ??
      (payload as { message?: string })?.message ??
      (text || res.statusText);
    throw new ConsoleApiError(res.status, code, message, payload);
  }

  // Most endpoints return { data: T }. Some (legacy) return T directly.
  const json = (await res.json()) as { data?: T } | T;
  if (json && typeof json === 'object' && 'data' in (json as Record<string, unknown>)) {
    return (json as { data: T }).data;
  }
  return json as T;
}

export const consoleApi = {
  // POST /v1/deployments  body: { data: { sdl, deposit } }
  // deposit is a number in dollars (e.g. 5 = $5 of USDC at current price).
  createDeployment: (
    apiKey: string,
    args: { sdl: string; deposit: number }
  ) =>
    call<DeploymentCreated>(apiKey, 'POST', '/deployments', {
      data: { sdl: args.sdl, deposit: args.deposit },
    }),

  // GET /v1/deployments/{dseq}
  getDeployment: (apiKey: string, dseq: string) =>
    call<DeploymentDetail>(apiKey, 'GET', `/deployments/${dseq}`),

  // PUT /v1/deployments/{dseq}  body: { data: { sdl } }
  updateDeployment: (apiKey: string, dseq: string, sdl: string) =>
    call<DeploymentDetail>(apiKey, 'PUT', `/deployments/${dseq}`, {
      data: { sdl },
    }),

  // DELETE /v1/deployments/{dseq}
  closeDeployment: (apiKey: string, dseq: string) =>
    call<{ success: boolean }>(apiKey, 'DELETE', `/deployments/${dseq}`),

  // GET /v1/bids/{dseq}
  getBids: (apiKey: string, dseq: string) =>
    call<{ bid: Bid }[]>(apiKey, 'GET', `/bids/${dseq}`).then((rows) =>
      rows.map((r) => r.bid)
    ),

  // POST /v1/leases  body (NOT wrapped in data): { manifest, leases: [...] }
  acceptLeases: (
    apiKey: string,
    args: {
      manifest: string;
      leases: Array<{ dseq: string; gseq: number; oseq: number; provider: string }>;
    }
  ) => call<LeaseAcceptResp>(apiKey, 'POST', '/leases', args),

  // GET /v1/balances — returns USD-equivalent balances for the API key's wallet.
  getBalances: (apiKey: string) =>
    call<{ balance: number; deployments: number; total: number }>(
      apiKey,
      'GET',
      '/balances'
    ),
};
