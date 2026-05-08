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
  path?: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown, path?: string) {
    super(path ? `[${path}] ${message}` : message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.path = path;
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
    // When the upstream returned non-JSON (Cloudflare/nginx error pages on
    // 5xx, etc.), there's no useful structured message. Falling back to the
    // raw body would dump HTML into the deployment's errorMessage, so we
    // synthesise a short status-line message instead.
    const jsonMessage =
      (payload as { error?: { message?: string }; message?: string })?.error?.message ??
      (payload as { message?: string })?.message;
    const message = jsonMessage ?? `${res.status} ${res.statusText || 'upstream error'}`.trim();
    throw new ConsoleApiError(res.status, code, message, payload, path);
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

  // GET /v1/user/me — returns the authenticated user. We need `userId` (the
  // external auth-provider sub) to query /wallets.
  getCurrentUser: (apiKey: string) =>
    call<{ id: string; userId: string; email?: string; username?: string }>(
      apiKey,
      'GET',
      '/user/me'
    ),

  // GET /v1/wallets?userId=… — returns the wallet rows owned by the user. The
  // `address` (akash1…) is the stable identity we scope functions by.
  getWallets: (apiKey: string, userId: string) =>
    call<Array<{ id: number | null; userId: string | null; address: string | null; denom: string; isTrialing: boolean }>>(
      apiKey,
      'GET',
      `/wallets?userId=${encodeURIComponent(userId)}`
    ),
};

// Resolve the wallet address for an API key. Two Console hits, but the caller
// caches the result so this is a once-per-fresh-key cost.
//
// /user/me returns two IDs: `id` (internal UUID) and `userId` (auth-provider
// sub, e.g. "google-oauth2|123…"). /wallets?userId= expects the UUID `id`,
// not the provider sub — Console reuses the param name confusingly.
export async function resolveWalletAddress(apiKey: string): Promise<string> {
  const user = await consoleApi.getCurrentUser(apiKey);
  if (!user?.id) {
    throw new ConsoleApiError(500, 'NO_USER_ID', 'Console /user/me did not return a user id');
  }
  const wallets = await consoleApi.getWallets(apiKey, user.id);
  const withAddress = (wallets ?? []).filter((w) => typeof w.address === 'string' && w.address.length > 0);
  if (withAddress.length === 0) {
    throw new ConsoleApiError(404, 'NO_WALLET', 'No wallet with an address is associated with this API key');
  }
  // If multiple wallets exist, prefer a non-trialing one (production), then the first.
  // withAddress is non-empty (checked above), and every entry has a string address.
  const active = withAddress.find((w) => !w.isTrialing) ?? withAddress[0]!;
  return active.address!;
}
