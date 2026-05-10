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
  FunctionVersionSummary,
  FunctionVersionDetail,
  FunctionVariablesResponse,
  PutFunctionVariableResponse,
  DeleteFunctionVariableResponse,
  UpdateCodeRequest,
  ApiKeyRecord,
  CreateApiKeyResponse,
  ProtectedRouteKey,
  ProtectedRoutesResponse,
} from '@shared/types';
import {
  AKASHML_KEY,
  API_KEYS_KEY,
  PROTECTED_ROUTES_KEY_PREFIX,
  SERVICES_KEY,
  SESSION_KEY,
  VARIABLES_KEY_PREFIX,
  VERSIONS_KEY_PREFIX,
  readJSON,
  removeKey,
  writeJSON,
} from './storage';

export type UpdateCodeResult = {
  id: string;
  createdAt: string;
  message: string | null;
};

export interface ApiClient {
  getSession(): Session | null;
  connect(key: string): Promise<Session>;
  connectSample(): Promise<Session>;
  disconnect(): void;

  listServices(): Promise<FunctionRecord[]>;
  deploy(sample: CodeSample): Promise<FunctionRecord>;
  // Creates a new function from an existing one's source and fires deploy.
  // Returns the NEW function record (not the source). 1 function = 1 deployment.
  cloneAndDeploy(fnId: string): Promise<FunctionRecord>;
  // Closes the active Akash lease but keeps the function record + version
  // history. After this, the function shows up as `idle` and Save & Deploy
  // will spin up a fresh deployment with the current runner image.
  closeDeployment(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<FunctionRecord>;

  getDeployment(fnId: string, depId: string): Promise<DeploymentRecord>;
  // Submits a fresh SDL on the same dseq so the provider re-pulls the runner
  // image and restarts the container. Lease, dseq, gseq, oseq, uris stay put.
  updateRunnerImage(fnId: string, depId: string): Promise<DeploymentRecord>;

  // Version history & code editing.
  listVersions(fnId: string): Promise<FunctionVersionSummary[]>;
  getVersion(fnId: string, versionId: string): Promise<FunctionVersionDetail>;
  getLatestVersion(fnId: string): Promise<FunctionVersionDetail>;
  updateCode(fnId: string, body: UpdateCodeRequest): Promise<UpdateCodeResult>;
  restoreVersion(
    fnId: string,
    versionId: string,
    opts?: { message?: string }
  ): Promise<UpdateCodeResult>;
  deployVersion(fnId: string, versionId?: string): Promise<DeploymentRecord>;

  // Function variables (write-only API: list returns only keys, never values).
  listVariables(fnId: string): Promise<FunctionVariablesResponse>;
  putVariable(fnId: string, key: string, value: string): Promise<PutFunctionVariableResponse>;
  deleteVariable(fnId: string, key: string): Promise<DeleteFunctionVariableResponse>;

  // Wallet-scoped API keys for protecting function routes.
  listApiKeys(): Promise<ApiKeyRecord[]>;
  createApiKey(name: string): Promise<CreateApiKeyResponse>;
  deleteApiKey(id: string): Promise<void>;

  // Per-function protected-routes set.
  getProtectedRoutes(fnId: string): Promise<ProtectedRoutesResponse>;
  updateProtectedRoutes(
    fnId: string,
    protectedRoutes: ProtectedRouteKey[]
  ): Promise<ProtectedRoutesResponse>;

  getAkashMLConnection(): AkashMLConnection | null;
  saveAkashMLConnection(key: string): AkashMLConnection;
  clearAkashMLConnection(): void;

  getUsage(): Promise<UsageInfo>;
}

// CodeSample.code is tokenized for the template preview. Concatenating the
// [_, text] tuples reconstitutes the original source string. Exposed so the
// builder can seed its editor when the user picks an unedited template.
export function tokensToSource(code: TokenLine[]): string {
  return code.map((line) => line.map((tok) => tok[1]).join('')).join('\n');
}

// Builds the path → contents map sent to the deploy endpoint. The server
// derives the route list from this source on every deployment fetch, so the
// entry file is the single source of truth.
function buildSourceMap(sample: CodeSample): Record<string, string> {
  return {
    'src/index.ts': sample.source ?? tokensToSource(sample.code),
  };
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

// Default Hono sample for seeding mock-mode functions that have no recorded
// versions yet (e.g. the static demo function in DEFAULT_SERVICES).
const DEFAULT_MOCK_SOURCE = `// index.tsx (Bun v1.3 runtime)
import { Hono } from "hono@4";
import { cors } from "hono/cors";

const app = new Hono();

app.use("/*", cors());
app.get("/", (c) => c.text("Hello world!"));
app.get("/api/health", (c) => c.json({ status: "ok" }));

Bun.serve({
  port: import.meta.env.PORT ?? 3000,
  fetch: app.fetch,
});
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMockVersions(fnId: string): FunctionVersionDetail[] {
  return readJSON<FunctionVersionDetail[]>(VERSIONS_KEY_PREFIX + fnId) ?? [];
}

function writeMockVersions(fnId: string, list: FunctionVersionDetail[]): void {
  // Recompute isLatest so only the topmost row is flagged.
  const tagged = list.map((v, i) => ({ ...v, isLatest: i === 0 }));
  writeJSON(VERSIONS_KEY_PREFIX + fnId, tagged);
}

type MockVarsState = {
  rev: number;
  items: { key: string; value: string; updatedAt: string }[];
};

function readMockVars(fnId: string): MockVarsState {
  return readJSON<MockVarsState>(VARIABLES_KEY_PREFIX + fnId) ?? { rev: 0, items: [] };
}

function writeMockVars(fnId: string, data: MockVarsState): void {
  writeJSON(VARIABLES_KEY_PREFIX + fnId, data);
}

function seedMockVersionsIfEmpty(fnId: string): FunctionVersionDetail[] {
  const existing = readMockVersions(fnId);
  if (existing.length > 0) return existing;
  const seed: FunctionVersionDetail = {
    id: 'v-' + Math.random().toString(36).slice(2, 9),
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    message: 'Initial version',
    preset: 'rest',
    isLatest: true,
    deploymentCount: 1,
    source: { 'src/index.ts': DEFAULT_MOCK_SOURCE },
    resources: { cpu: '0.5', memory: '512Mi', storage: '1Gi' },
    envVars: {},
  };
  writeMockVersions(fnId, [seed]);
  return [seed];
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

    // Seed an initial version so the History/SourceCode tabs have content.
    const initial: FunctionVersionDetail = {
      id: 'v-' + Math.random().toString(36).slice(2, 9),
      createdAt: new Date().toISOString(),
      message: 'Initial version',
      preset: 'rest',
      isLatest: true,
      deploymentCount: 1,
      source: buildSourceMap(sample),
      resources: { cpu: sample.res.cpu, memory: sample.res.mem, storage: '1Gi' },
      envVars: {},
    };
    writeMockVersions(id, [initial]);

    return svc;
  }

  async closeDeployment(id: string): Promise<void> {
    // Mock: flip the service to idle but keep the record.
    const services = (await this.listServices()).map((s) =>
      s.id === id ? { ...s, status: 'idle' as const, latestDeploymentId: undefined } : s
    );
    writeJSON(SERVICES_KEY, services);
  }

  async remove(id: string): Promise<void> {
    const services = (await this.listServices()).filter((s) => s.id !== id);
    writeJSON(SERVICES_KEY, services);
    removeKey(VERSIONS_KEY_PREFIX + id);
  }

  async rename(id: string, name: string): Promise<FunctionRecord> {
    const services = await this.listServices();
    const target = services.find((s) => s.id === id);
    if (!target) throw new Error('Function not found');
    const next: FunctionRecord = { ...target, name, updatedAt: new Date().toISOString() };
    writeJSON(SERVICES_KEY, services.map((s) => (s.id === id ? next : s)));
    return next;
  }

  async cloneAndDeploy(fnId: string): Promise<FunctionRecord> {
    await delay(600);
    const services = (await this.listServices()).slice();
    const source = services.find((s) => s.id === fnId);
    const baseName = source?.name ?? 'function-clone';
    const id = 'fn-' + Math.random().toString(36).slice(2, 7);
    const svc: FunctionRecord = {
      id,
      name: baseName,
      kind: 'function',
      subdomain: `${baseName}-prod-${Math.random().toString(36).slice(2, 6)}.akash-functions.io`,
      image: `ghcr.io/akash-network/${baseName}:1.0.0`,
      status: 'pending',
      deploymentId: 'dep-' + Math.random().toString(36).slice(2, 8),
    };
    services.push(svc);
    writeJSON(SERVICES_KEY, services);

    // Carry over latest version from source so the cloned fn has code to show.
    const sourceVersions = readMockVersions(fnId);
    const sourceLatest = sourceVersions[0];
    const cloneVersion: FunctionVersionDetail = {
      id: 'v-' + Math.random().toString(36).slice(2, 9),
      createdAt: new Date().toISOString(),
      message: `Cloned from ${sourceLatest?.id.slice(0, 7) ?? 'unknown'}`,
      preset: sourceLatest?.preset ?? 'rest',
      isLatest: true,
      deploymentCount: 1,
      source: sourceLatest?.source ?? { 'src/index.ts': DEFAULT_MOCK_SOURCE },
      resources: sourceLatest?.resources ?? { cpu: '0.5', memory: '512Mi', storage: '1Gi' },
      envVars: sourceLatest?.envVars ?? {},
    };
    writeMockVersions(id, [cloneVersion]);

    return svc;
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

  async updateRunnerImage(fnId: string, depId: string): Promise<DeploymentRecord> {
    await delay(150);
    const dep = await this.getDeployment(fnId, depId);
    return { ...dep, errorMessage: undefined };
  }

  async listVersions(fnId: string): Promise<FunctionVersionSummary[]> {
    await delay(120);
    const versions = seedMockVersionsIfEmpty(fnId);
    return versions.map(({ source: _s, resources: _r, envVars: _e, ...summary }) => summary);
  }

  async getVersion(fnId: string, versionId: string): Promise<FunctionVersionDetail> {
    await delay(120);
    const versions = seedMockVersionsIfEmpty(fnId);
    const v = versions.find((x) => x.id === versionId);
    if (!v) throw new Error('Version not found');
    return v;
  }

  async getLatestVersion(fnId: string): Promise<FunctionVersionDetail> {
    await delay(120);
    const versions = seedMockVersionsIfEmpty(fnId);
    const latest = versions[0];
    if (!latest) throw new Error('No versions for function');
    return latest;
  }

  async updateCode(fnId: string, body: UpdateCodeRequest): Promise<UpdateCodeResult> {
    await delay(400);
    const versions = seedMockVersionsIfEmpty(fnId);
    const prev = versions[0];
    const created: FunctionVersionDetail = {
      id: 'v-' + Math.random().toString(36).slice(2, 9),
      createdAt: new Date().toISOString(),
      message: body.message ?? null,
      preset: prev?.preset ?? 'rest',
      isLatest: true,
      deploymentCount: 0,
      source: body.source,
      resources: body.resources ?? prev?.resources ?? { cpu: '0.5', memory: '512Mi', storage: '1Gi' },
      envVars: body.envVars ?? prev?.envVars ?? {},
    };
    writeMockVersions(fnId, [created, ...versions]);
    return { id: created.id, createdAt: created.createdAt, message: created.message };
  }

  async restoreVersion(
    fnId: string,
    versionId: string,
    opts?: { message?: string }
  ): Promise<UpdateCodeResult> {
    await delay(400);
    const versions = seedMockVersionsIfEmpty(fnId);
    const target = versions.find((v) => v.id === versionId);
    if (!target) throw new Error('Version not found');
    const defaultMessage = `Restored from ${target.id.slice(0, 7)} @ ${target.createdAt}`;
    const created: FunctionVersionDetail = {
      id: 'v-' + Math.random().toString(36).slice(2, 9),
      createdAt: new Date().toISOString(),
      message: opts?.message ?? defaultMessage,
      preset: target.preset,
      isLatest: true,
      deploymentCount: 0,
      source: target.source,
      resources: target.resources,
      envVars: target.envVars,
    };
    writeMockVersions(fnId, [created, ...versions]);
    return { id: created.id, createdAt: created.createdAt, message: created.message };
  }

  async deployVersion(_fnId: string, _versionId?: string): Promise<DeploymentRecord> {
    await delay(500);
    return {
      id: 'dep-' + Math.random().toString(36).slice(2, 8),
      functionId: 'mock',
      versionId: 'mock',
      state: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  async listVariables(fnId: string): Promise<FunctionVariablesResponse> {
    await delay(80);
    const { rev, items } = readMockVars(fnId);
    return {
      variablesRevision: rev,
      variables: items.map(({ key, updatedAt }) => ({ key, updatedAt })),
    };
  }

  async putVariable(
    fnId: string,
    key: string,
    value: string
  ): Promise<PutFunctionVariableResponse> {
    await delay(120);
    const data = readMockVars(fnId);
    const updatedAt = new Date().toISOString();
    const idx = data.items.findIndex((v) => v.key === key);
    if (idx >= 0) {
      data.items[idx] = { key, value, updatedAt };
    } else {
      data.items.push({ key, value, updatedAt });
    }
    data.rev += 1;
    writeMockVars(fnId, data);
    return { key, updatedAt, variablesRevision: data.rev };
  }

  async deleteVariable(fnId: string, key: string): Promise<DeleteFunctionVariableResponse> {
    await delay(120);
    const data = readMockVars(fnId);
    const next = data.items.filter((v) => v.key !== key);
    if (next.length !== data.items.length) {
      data.items = next;
      data.rev += 1;
      writeMockVars(fnId, data);
    }
    return { key, variablesRevision: data.rev };
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    await delay(80);
    return readJSON<ApiKeyRecord[]>(API_KEYS_KEY) ?? [];
  }

  async createApiKey(name: string): Promise<CreateApiKeyResponse> {
    await delay(160);
    const list = (await this.listApiKeys()).slice();
    const plaintext =
      'akf_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const record: CreateApiKeyResponse = {
      id: 'key-' + Math.random().toString(36).slice(2, 9),
      name: name.trim(),
      key: plaintext,
      maskedTail: plaintext.slice(-4),
      createdAt: new Date().toISOString(),
    };
    list.push({
      id: record.id,
      name: record.name,
      maskedTail: record.maskedTail,
      createdAt: record.createdAt,
    });
    writeJSON(API_KEYS_KEY, list);
    return record;
  }

  async deleteApiKey(id: string): Promise<void> {
    await delay(80);
    const list = (await this.listApiKeys()).filter((k) => k.id !== id);
    writeJSON(API_KEYS_KEY, list);
  }

  async getProtectedRoutes(fnId: string): Promise<ProtectedRoutesResponse> {
    await delay(40);
    return {
      protectedRoutes:
        readJSON<ProtectedRouteKey[]>(PROTECTED_ROUTES_KEY_PREFIX + fnId) ?? [],
    };
  }

  async updateProtectedRoutes(
    fnId: string,
    protectedRoutes: ProtectedRouteKey[]
  ): Promise<ProtectedRoutesResponse> {
    await delay(80);
    const dedup = Array.from(new Set(protectedRoutes));
    writeJSON(PROTECTED_ROUTES_KEY_PREFIX + fnId, dedup);
    return { protectedRoutes: dedup };
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
    // 204 (and any other empty body) — return undefined cast as T. Callers that
    // type the response as `void` get nothing; callers that expect JSON on a
    // 200 still get parsed JSON below.
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
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
    // If the second call fails, tombstone the function so it doesn't show up
    // in the list as an "idle" zombie the user has to clean up by hand.
    const fn = await this.req<FunctionRecord>('/api/functions', {
      method: 'POST',
      body: JSON.stringify({
        name: sample.name,
        preset: 'rest',
        prompt: sample.prompt,
        source: buildSourceMap(sample),
        resources: {
          cpu: sample.res.cpu,
          memory: sample.res.mem,
          storage: '1Gi',
        },
      }),
    });
    try {
      const dep = await this.req<DeploymentRecord>(
        `/api/functions/${fn.id}/deploy`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      return { ...fn, deploymentId: dep.id };
    } catch (err) {
      await this.req(`/api/functions/${fn.id}`, { method: 'DELETE' }).catch(() => undefined);
      throw err;
    }
  }

  async closeDeployment(id: string): Promise<void> {
    await this.req(`/api/functions/${id}/close-deployment`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async remove(id: string): Promise<void> {
    await this.req(`/api/functions/${id}`, { method: 'DELETE' });
  }

  async rename(id: string, name: string): Promise<FunctionRecord> {
    return this.req<FunctionRecord>(`/api/functions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
  }

  async cloneAndDeploy(fnId: string): Promise<FunctionRecord> {
    return this.req<FunctionRecord>(`/api/functions/${fnId}/clone`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getDeployment(fnId: string, depId: string): Promise<DeploymentRecord> {
    return this.req<DeploymentRecord>(`/api/functions/${fnId}/deployments/${depId}`);
  }

  async updateRunnerImage(fnId: string, depId: string): Promise<DeploymentRecord> {
    return this.req<DeploymentRecord>(
      `/api/functions/${fnId}/deployments/${depId}/update-image`,
      { method: 'POST' }
    );
  }

  async listVersions(fnId: string): Promise<FunctionVersionSummary[]> {
    return this.req<FunctionVersionSummary[]>(`/api/functions/${fnId}/versions`);
  }

  async getVersion(fnId: string, versionId: string): Promise<FunctionVersionDetail> {
    return this.req<FunctionVersionDetail>(`/api/functions/${fnId}/versions/${versionId}`);
  }

  async getLatestVersion(fnId: string): Promise<FunctionVersionDetail> {
    const list = await this.listVersions(fnId);
    const latest = list[0];
    if (!latest) throw new Error('No versions for function');
    return this.getVersion(fnId, latest.id);
  }

  async updateCode(fnId: string, body: UpdateCodeRequest): Promise<UpdateCodeResult> {
    return this.req<UpdateCodeResult>(`/api/functions/${fnId}/code`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async restoreVersion(
    fnId: string,
    versionId: string,
    opts?: { message?: string }
  ): Promise<UpdateCodeResult> {
    return this.req<UpdateCodeResult>(
      `/api/functions/${fnId}/versions/${versionId}/restore`,
      {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }
    );
  }

  async deployVersion(fnId: string, versionId?: string): Promise<DeploymentRecord> {
    return this.req<DeploymentRecord>(`/api/functions/${fnId}/deploy`, {
      method: 'POST',
      body: JSON.stringify(versionId ? { versionId } : {}),
    });
  }

  async listVariables(fnId: string): Promise<FunctionVariablesResponse> {
    return this.req<FunctionVariablesResponse>(`/api/functions/${fnId}/variables`);
  }

  async putVariable(
    fnId: string,
    key: string,
    value: string
  ): Promise<PutFunctionVariableResponse> {
    return this.req<PutFunctionVariableResponse>(
      `/api/functions/${fnId}/variables/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify({ value }) }
    );
  }

  async deleteVariable(
    fnId: string,
    key: string
  ): Promise<DeleteFunctionVariableResponse> {
    return this.req<DeleteFunctionVariableResponse>(
      `/api/functions/${fnId}/variables/${encodeURIComponent(key)}`,
      { method: 'DELETE' }
    );
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    return this.req<ApiKeyRecord[]>('/api/keys');
  }

  async createApiKey(name: string): Promise<CreateApiKeyResponse> {
    return this.req<CreateApiKeyResponse>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async deleteApiKey(id: string): Promise<void> {
    await this.req(`/api/keys/${id}`, { method: 'DELETE' });
  }

  async getProtectedRoutes(fnId: string): Promise<ProtectedRoutesResponse> {
    return this.req<ProtectedRoutesResponse>(`/api/functions/${fnId}/protected-routes`);
  }

  async updateProtectedRoutes(
    fnId: string,
    protectedRoutes: ProtectedRouteKey[]
  ): Promise<ProtectedRoutesResponse> {
    return this.req<ProtectedRoutesResponse>(`/api/functions/${fnId}/protected-routes`, {
      method: 'PUT',
      body: JSON.stringify({ protectedRoutes }),
    });
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
