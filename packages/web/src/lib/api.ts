// API client — single entry point for all backend-bound operations.
// Two modes: 'mock' (localStorage-backed for offline UX dev) and 'live' (real backend).

import type {
  Session,
  FunctionRecord,
  CodeSample,
  AkashMLConnection,
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
  ResourceRequest,
  GpuModelOption,
  FeasibilityCheck,
  AgentChatRequest,
  AgentChatChunk,
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
  /**
   * Deploy a brand-new function. `customResources` overrides preset defaults;
   * `envVars` carries any user-supplied secrets the source references (e.g.
   * AKASHML_API_KEY). Both default to undefined — keep the wire payload lean.
   */
  deploy(
    sample: CodeSample,
    customResources?: ResourceRequest,
    envVars?: Record<string, string>
  ): Promise<FunctionRecord>;

  /** Live GPU inventory across online+audited providers. */
  listGpuModels(): Promise<GpuModelOption[]>;
  /** "How many online+audited providers can fulfill this spec right now?" */
  checkFeasibility(spec: ResourceRequest): Promise<FeasibilityCheck>;
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
  // Server-side probe of the function's live ingress. Akash marks state='live'
  // before the provider's nginx actually serves traffic, so we use this to
  // gate UI elements (URL bar, routes, "Online" pill) until the upstream is
  // really ready.
  getIngressReachable(fnId: string): Promise<{ reachable: boolean }>;
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

  // Streams the agent chat reply from POST /api/agent/chat as SSE chunks.
  // Generator yields one chunk per server-sent event; aborts when the
  // caller's AbortSignal fires.
  agentChatStream(
    req: AgentChatRequest,
    signal?: AbortSignal
  ): AsyncIterable<AgentChatChunk>;
}

// CodeSample.code is tokenized for the template preview. Concatenating the
// [_, text] tuples reconstitutes the original source string. Exposed so the
// builder can seed its editor when the user picks an unedited template.
export function tokensToSource(code: TokenLine[]): string {
  return code.map((line) => line.map((tok) => tok[1]).join('')).join('\n');
}

// Detects JSX content via an unambiguous closing-tag (or self-closing) pattern.
// TS generics like `Promise<T>` lack `</T>` and never carry attributes, so they
// don't match. Used to route the entry to .tsx when JSX is present, since Bun
// rejects JSX inside .ts files.
const JSX_TAG = /<\/[A-Za-z][\w-]*\s*>|<[A-Za-z][\w-]*[^<>]*\/>/;

export function pickEntryPath(code: string): 'src/index.tsx' | 'src/index.ts' {
  return JSX_TAG.test(code) ? 'src/index.tsx' : 'src/index.ts';
}

// Builds the path → contents map sent to the deploy endpoint. The server
// derives the route list from this source on every deployment fetch, so the
// entry file is the single source of truth.
function buildSourceMap(sample: CodeSample): Record<string, string> {
  const code = sample.source ?? tokensToSource(sample.code);
  return { [pickEntryPath(code)]: code };
}

const DEFAULT_SERVICES: FunctionRecord[] = [
  {
    id: 'fn-1',
    name: 'function-bun',
    kind: 'function',
    ingressUrl: 'function-bun-prod-fb0f.akash-functions.io',
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

function mockSizeBytes(input: string): number {
  const s = String(input).replace(/\s+/g, '').replace(/iB$/i, 'i');
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? '').toLowerCase();
  const mult: Record<string, number> = { '': 1, ki: 1024, mi: 1024 ** 2, gi: 1024 ** 3, ti: 1024 ** 4 };
  return Math.floor(n * (mult[unit] ?? 1));
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

  async deploy(
    sample: CodeSample,
    customResources?: ResourceRequest,
    envVars?: Record<string, string>
  ): Promise<FunctionRecord> {
    await delay(900);
    const services = (await this.listServices()).slice();
    const id = 'fn-' + Math.random().toString(36).slice(2, 7);
    const baseName = sample.name || 'function-new';
    const svc: FunctionRecord = {
      id,
      name: baseName,
      kind: 'function',
      ingressUrl: `${baseName}-prod.akash-functions.io`,
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
      resources: customResources ?? { cpu: sample.res.cpu, memory: sample.res.mem, storage: '1Gi' },
      envVars: envVars ?? {},
    };
    writeMockVersions(id, [initial]);

    return svc;
  }

  async listGpuModels(): Promise<GpuModelOption[]> {
    await delay(100);
    return [
      { vendor: 'nvidia', model: 'rtx4090', ram: '24Gi', interface: 'PCIe', allocatable: 15, allocated: 6, available: 9 },
      { vendor: 'nvidia', model: 'a100', ram: '80Gi', interface: 'SXM4', allocatable: 32, allocated: 3, available: 29 },
      { vendor: 'nvidia', model: 'h100', ram: '80Gi', interface: 'SXM5', allocatable: 64, allocated: 42, available: 22 },
      { vendor: 'nvidia', model: 'h200', ram: '141Gi', interface: 'SXM5', allocatable: 40, allocated: 21, available: 19 },
    ];
  }

  async checkFeasibility(spec: ResourceRequest): Promise<FeasibilityCheck> {
    await delay(80);
    // Trivial mock: arbitrarily call anything above 16 vCPU / 64 GB / 200 GB unmatched.
    const cpu = parseFloat(String(spec.cpu).replace(/[^0-9.]/g, '')) || 0;
    const memBytes = mockSizeBytes(spec.memory);
    const stoBytes = mockSizeBytes(spec.storage);
    if (cpu > 16 || memBytes > 64 * 1024 ** 3 || stoBytes > 200 * 1024 ** 3) {
      let bottleneck: FeasibilityCheck['bottleneck'] = 'cpu';
      if (memBytes > 64 * 1024 ** 3) bottleneck = 'memory';
      else if (stoBytes > 200 * 1024 ** 3) bottleneck = 'storage';
      return { matchingProviders: 0, totalActiveProviders: 12, bottleneck };
    }
    return { matchingProviders: spec.gpu ? 3 : 8, totalActiveProviders: 12 };
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
      ingressUrl: `${baseName}-prod-${Math.random().toString(36).slice(2, 6)}.akash-functions.io`,
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

  async getIngressReachable(_fnId: string): Promise<{ reachable: boolean }> {
    return { reachable: true };
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
      key: trimmed,
      last4: trimmed.slice(-4),
      connectedAt: Date.now(),
    };
    writeJSON(AKASHML_KEY, conn);
    return conn;
  }

  clearAkashMLConnection(): void {
    removeKey(AKASHML_KEY);
  }

  // Canned offline reply so the chat UI can be developed without a backend.
  async *agentChatStream(
    _req: AgentChatRequest,
    signal?: AbortSignal
  ): AsyncIterable<AgentChatChunk> {
    const reply =
      "Here's a Hono REST endpoint that returns a list of cats. " +
      'Mock mode — wire VITE_API_MODE=live for real AkashML output.\n\n' +
      '```ts\n' +
      "import { Hono } from 'hono';\n\n" +
      'const app = new Hono();\n\n' +
      "app.get('/cats', (c) => c.json([\n" +
      "  { id: 1, name: 'Whiskers' },\n" +
      "  { id: 2, name: 'Mittens' },\n" +
      ']));\n\n' +
      'export default app;\n' +
      '```\n';
    for (const chunk of reply.match(/.{1,12}/gs) ?? []) {
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'delta', text: chunk };
    }
    yield { type: 'done' };
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

  async deploy(
    sample: CodeSample,
    customResources?: ResourceRequest,
    envVars?: Record<string, string>
  ): Promise<FunctionRecord> {
    // Two-phase: create the function record, then trigger the deploy pipeline.
    // If the second call fails, tombstone the function so it doesn't show up
    // in the list as an "idle" zombie the user has to clean up by hand.
    const resources: ResourceRequest = customResources ?? {
      cpu: sample.res.cpu,
      memory: sample.res.mem,
      storage: '1Gi',
    };
    const hasEnvVars = envVars && Object.keys(envVars).length > 0;
    const fn = await this.req<FunctionRecord>('/api/functions', {
      method: 'POST',
      body: JSON.stringify({
        name: sample.name,
        preset: 'rest',
        prompt: sample.prompt,
        source: buildSourceMap(sample),
        resources,
        ...(hasEnvVars ? { envVars } : {}),
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

  async listGpuModels(): Promise<GpuModelOption[]> {
    return this.req<GpuModelOption[]>('/api/gpu-models');
  }

  async checkFeasibility(spec: ResourceRequest): Promise<FeasibilityCheck> {
    return this.req<FeasibilityCheck>('/api/check-feasibility', {
      method: 'POST',
      body: JSON.stringify(spec),
    });
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

  async getIngressReachable(fnId: string): Promise<{ reachable: boolean }> {
    return this.req<{ reachable: boolean }>(`/api/functions/${fnId}/ingress-reachable`);
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
    const trimmed = key.trim();
    const conn: AkashMLConnection = {
      key: trimmed,
      last4: trimmed.slice(-4),
      connectedAt: Date.now(),
    };
    writeJSON(AKASHML_KEY, conn);
    return conn;
  }

  clearAkashMLConnection(): void {
    removeKey(AKASHML_KEY);
  }

  async *agentChatStream(
    req: AgentChatRequest,
    signal?: AbortSignal
  ): AsyncIterable<AgentChatChunk> {
    const res = await fetch(this.base + '/api/agent/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.authHeader,
      },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events end on a blank line. Parse all complete events out of the
        // buffer; leave any partial event behind for the next read.
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as AgentChatChunk;
          } catch {
            // Tolerate malformed frames rather than killing the stream.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

const mode = (import.meta.env.VITE_API_MODE as string) || 'mock';
const base = (import.meta.env.VITE_API_BASE as string) || 'http://localhost:8080';

export const api: ApiClient = mode === 'live' ? new LiveApi(base) : new MockApi();
