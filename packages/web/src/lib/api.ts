// API client — single entry point for all backend-bound operations.
// Two modes: 'mock' (localStorage-backed for offline UX dev) and 'live' (real backend).

import type {
  Session,
  FunctionRecord,
  CodeSample,
  AkashMLConnection,
  UsageInfo,
  DeploymentRecord,
  TokenLine,
} from '@shared/types';
import {
  AKASHML_KEY,
  SERVICES_KEY,
  SESSION_KEY,
  readJSON,
  removeKey,
  writeJSON,
} from './storage';

export interface ApiClient {
  getSession(): Session | null;
  connect(key: string): Promise<Session>;
  connectSample(): Promise<Session>;
  disconnect(): void;

  listServices(): Promise<FunctionRecord[]>;
  deploy(sample: CodeSample): Promise<FunctionRecord>;
  remove(id: string): Promise<void>;

  getDeployment(fnId: string, depId: string): Promise<DeploymentRecord>;

  getAkashMLConnection(): AkashMLConnection | null;
  saveAkashMLConnection(key: string): AkashMLConnection;
  clearAkashMLConnection(): void;

  getUsage(): Promise<UsageInfo>;
}

// CodeSample.code is tokenized for the syntax-highlighted preview. Concatenating
// the [_, text] tuples reconstitutes the original source the runner should boot.
function tokensToSource(code: TokenLine[]): string {
  return code.map((line) => line.map((tok) => tok[1]).join('')).join('\n');
}

const DEFAULT_SERVICES: FunctionRecord[] = [
  {
    id: 'fn-1',
    name: 'function-bun',
    kind: 'function',
    subdomain: 'function-bun-prod-fb0f.akash-functions.io',
    image: 'ghcr.io/akash-network/function-bun:1.3.0',
    status: 'online',
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockApi implements ApiClient {
  getSession(): Session | null {
    return readJSON<Session>(SESSION_KEY);
  }

  async connect(key: string): Promise<Session> {
    await delay(900);
    const session: Session = {
      key,
      email: 'max@akash.network',
      workspace: 'tranquil-creation',
      connectedAt: Date.now(),
    };
    writeJSON(SESSION_KEY, session);
    return session;
  }

  async connectSample(): Promise<Session> {
    const session: Session = {
      key: 'sample',
      email: 'demo@akash.network',
      workspace: 'tranquil-creation',
      sample: true,
      connectedAt: Date.now(),
    };
    writeJSON(SESSION_KEY, session);
    return session;
  }

  disconnect(): void {
    removeKey(SESSION_KEY);
  }

  async listServices(): Promise<FunctionRecord[]> {
    return readJSON<FunctionRecord[]>(SERVICES_KEY) ?? DEFAULT_SERVICES;
  }

  async deploy(sample: CodeSample): Promise<FunctionRecord> {
    await delay(900);
    const services = (await this.listServices()).slice();
    const id = 'fn-' + Math.random().toString(36).slice(2, 7);
    const baseName = sample.name || 'function-new';
    const svc: FunctionRecord = {
      id,
      name: baseName,
      kind: 'function',
      subdomain: `${baseName}-prod.akash-functions.io`,
      image: `ghcr.io/akash-network/${baseName}:1.0.0`,
      status: 'online',
      deploymentId: 'dep-' + Math.random().toString(36).slice(2, 8),
    };
    services.push(svc);
    writeJSON(SERVICES_KEY, services);
    return svc;
  }

  async remove(id: string): Promise<void> {
    const services = (await this.listServices()).filter((s) => s.id !== id);
    writeJSON(SERVICES_KEY, services);
  }

  async getDeployment(_fnId: string, depId: string): Promise<DeploymentRecord> {
    return {
      id: depId,
      functionId: 'mock',
      versionId: 'mock',
      state: 'live',
      dseq: '1234567',
      gseq: 1,
      oseq: 1,
      provider: 'akash1mockprovider',
      uris: ['mock.akash-functions.io'],
      createdAt: new Date().toISOString(),
      liveAt: new Date().toISOString(),
    };
  }

  getAkashMLConnection(): AkashMLConnection | null {
    return readJSON<AkashMLConnection>(AKASHML_KEY);
  }

  saveAkashMLConnection(key: string): AkashMLConnection {
    const trimmed = key.trim();
    const conn: AkashMLConnection = {
      last4: trimmed.slice(-4),
      connectedAt: Date.now(),
    };
    writeJSON(AKASHML_KEY, conn);
    return conn;
  }

  clearAkashMLConnection(): void {
    removeKey(AKASHML_KEY);
  }

  async getUsage(): Promise<UsageInfo> {
    return { usd: 5.04, act: 12.4, burnRatePerDay: 0.17 };
  }
}

class LiveApi implements ApiClient {
  private base: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  private get authHeader(): Record<string, string> {
    const session = this.getSession();
    return session ? { Authorization: `Bearer ${session.key}` } : {};
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeader,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  getSession(): Session | null {
    return readJSON<Session>(SESSION_KEY);
  }

  async connect(key: string): Promise<Session> {
    // The live backend doesn't pre-validate the key; possession is auth.
    // We still ping a cheap endpoint to confirm reachability.
    await fetch(this.base + '/api/health').catch(() => undefined);
    const session: Session = {
      key,
      email: 'connected@akash.network',
      workspace: 'tranquil-creation',
      connectedAt: Date.now(),
    };
    writeJSON(SESSION_KEY, session);
    return session;
  }

  async connectSample(): Promise<Session> {
    const session: Session = {
      key: 'sample',
      email: 'demo@akash.network',
      workspace: 'tranquil-creation',
      sample: true,
      connectedAt: Date.now(),
    };
    writeJSON(SESSION_KEY, session);
    return session;
  }

  disconnect(): void {
    removeKey(SESSION_KEY);
  }

  async listServices(): Promise<FunctionRecord[]> {
    return this.req<FunctionRecord[]>('/api/functions');
  }

  async deploy(sample: CodeSample): Promise<FunctionRecord> {
    // Two-phase: create the function record, then trigger the deploy pipeline.
    const fn = await this.req<FunctionRecord>('/api/functions', {
      method: 'POST',
      body: JSON.stringify({
        name: sample.name,
        preset: 'rest',
        prompt: sample.prompt,
        source: { 'src/index.ts': tokensToSource(sample.code) },
        resources: {
          cpu: sample.res.cpu,
          memory: sample.res.mem,
          storage: '1Gi',
        },
      }),
    });
    const dep = await this.req<DeploymentRecord>(
      `/api/functions/${fn.id}/deploy`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    return { ...fn, deploymentId: dep.id };
  }

  async remove(id: string): Promise<void> {
    await this.req(`/api/functions/${id}`, { method: 'DELETE' });
  }

  async getDeployment(fnId: string, depId: string): Promise<DeploymentRecord> {
    return this.req<DeploymentRecord>(`/api/functions/${fnId}/deployments/${depId}`);
  }

  getAkashMLConnection(): AkashMLConnection | null {
    return readJSON<AkashMLConnection>(AKASHML_KEY);
  }

  saveAkashMLConnection(key: string): AkashMLConnection {
    const conn: AkashMLConnection = {
      last4: key.trim().slice(-4),
      connectedAt: Date.now(),
    };
    writeJSON(AKASHML_KEY, conn);
    return conn;
  }

  clearAkashMLConnection(): void {
    removeKey(AKASHML_KEY);
  }

  async getUsage(): Promise<UsageInfo> {
    return this.req<UsageInfo>('/api/usage');
  }
}

const mode = (import.meta.env.VITE_API_MODE as string) || 'mock';
const base = (import.meta.env.VITE_API_BASE as string) || 'http://localhost:8080';

export const api: ApiClient = mode === 'live' ? new LiveApi(base) : new MockApi();
