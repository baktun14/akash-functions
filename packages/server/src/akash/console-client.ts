// Typed wrapper around console-api.akash.network/v1.
// Every method takes a bearerToken — possession of a Console API key is auth.

import { env } from '../env';

type Money = { denom: string; amount: string };

export type DeploymentResp = {
  dseq: string;
  owner: string;
  state: string;
  deposit?: Money;
  txHash?: string;
};

export type Bid = {
  provider: string;
  price: Money;
  state: string;
  attributes?: Record<string, string>;
};

export type LeaseResp = {
  dseq: string;
  gseq: number;
  oseq: number;
  provider: string;
  state: string;
  price?: Money;
  txHash?: string;
};

export type LeaseStatus = {
  services: Record<
    string,
    {
      name: string;
      available: number;
      total: number;
      uris?: string[];
      ips?: unknown;
    }
  >;
  forwardedPorts?: Record<string, unknown>;
};

export type WalletBalance = {
  address: string;
  balances: Money[];
};

export type SdlValidateResp = {
  valid: boolean;
  version?: string;
  services?: string[];
  profiles?: string[];
  placements?: string[];
};

export type SdlPriceResp = {
  estimatedMonthlyUakt: string;
  estimatedMonthlyUsd: string;
  resources: { cpu: number; memory: string; storage: string };
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
  bearerToken: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(env.AKASH_API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    const code =
      (payload as { error?: { code?: string } })?.error?.code ??
      `HTTP_${res.status}`;
    const message =
      (payload as { error?: { message?: string } })?.error?.message ??
      res.statusText;
    throw new ConsoleApiError(res.status, code, message, payload);
  }

  const json = (await res.json()) as { success?: boolean; data?: T };
  if (json && json.success === false) {
    throw new ConsoleApiError(res.status, 'API_ERROR', 'Console API returned failure', json);
  }
  return (json?.data ?? json) as T;
}

export const consoleApi = {
  validateSdl: (token: string, sdl: string) =>
    call<SdlValidateResp>(token, 'POST', '/sdl/validate', { sdl }),

  estimatePrice: (token: string, sdl: string) =>
    call<SdlPriceResp>(token, 'POST', '/sdl/price', { sdl }),

  getWalletBalance: (token: string) =>
    call<WalletBalance>(token, 'GET', '/wallet/balance'),

  createDeployment: (
    token: string,
    args: { sdl: string; deposit: string; walletId?: string }
  ) => call<DeploymentResp>(token, 'POST', '/deployment', args),

  getDeployment: (token: string, dseq: string) =>
    call<DeploymentResp>(token, 'GET', `/deployment/${dseq}`),

  updateDeployment: (token: string, dseq: string, sdl: string) =>
    call<DeploymentResp>(token, 'PUT', `/deployment/${dseq}`, { sdl }),

  closeDeployment: (token: string, dseq: string) =>
    call<DeploymentResp>(token, 'DELETE', `/deployment/${dseq}`),

  getBids: (token: string, dseq: string, gseq = 1) =>
    call<Bid[]>(token, 'GET', `/bids/${dseq}?gseq=${gseq}`),

  acceptLease: (
    token: string,
    args: { dseq: string; gseq: number; oseq: number; provider: string }
  ) => call<LeaseResp>(token, 'POST', '/lease', args),

  getLease: (token: string, dseq: string, gseq: number, oseq: number) =>
    call<LeaseResp>(token, 'GET', `/lease/${dseq}/${gseq}/${oseq}`),

  getLeaseStatus: (token: string, dseq: string, gseq: number, oseq: number) =>
    call<LeaseStatus>(token, 'GET', `/lease/${dseq}/${gseq}/${oseq}/status`),

  closeLease: (token: string, dseq: string, gseq: number, oseq: number) =>
    call<LeaseResp>(token, 'DELETE', `/lease/${dseq}/${gseq}/${oseq}`),
};
