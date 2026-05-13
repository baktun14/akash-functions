// Shared type contract between web frontend and server backend.

export type Session = {
  key: string;
  email: string;
  workspace: string;
  sample?: boolean;
  connectedAt: number;
};

// idle  — function exists but has no deployment (never attempted or orphaned)
// pending — deployment row in pending/bidding/leased
// online — deployment is live
// degraded — deployment alive but unhealthy (reserved; not used yet)
// offline — deployment failed or closed
export type ServiceStatus = 'online' | 'degraded' | 'offline' | 'pending' | 'idle';

export type FunctionRecord = {
  id: string;
  name: string;
  kind: 'function';
  subdomain: string;
  image: string;
  status: ServiceStatus;
  region?: string;
  replicas?: number;
  createdAt?: string;
  updatedAt?: string;
  // Set when deploy() returns — lets the UI start polling immediately.
  deploymentId?: string;
  // Set by GET /api/functions list query — survives reload so the UI can
  // resume polling for an in-flight or failed deployment.
  latestDeploymentId?: string;
  /** Decorated by GET /api/functions when the latest deployment is live and
   *  the runner reported a version older than EXPECTED_RUNNER_VERSION (or
   *  never reported and the deployment is past the grace window). */
  runnerOutdated?: boolean;
  /** Decorated by GET /api/functions when the latest deployment is live but
   *  the runner has stopped reporting on the poll loop. Distinct from
   *  `runnerOutdated` — recovery is the same in-place SDL push, but the reason
   *  the UI surfaces ("rebind to current host") is different. */
  runnerStale?: boolean;
};

export type PresetId = 'rest' | 'jsx' | 'cron' | 'gpu';

export type Preset = {
  id: PresetId;
  label: string;
  icon: string;
  akash?: boolean;
};

// Tokenized lines used as the seed for template previews. Display-only — the
// canonical text the runner boots is `CodeSample.source` (or, for templates
// that haven't been edited yet, the concatenation of these tokens).
// Each line is an array of [class, text] tuples.
export type CodeToken = readonly [string, string];
export type TokenLine = ReadonlyArray<CodeToken>;

export type Resources = {
  cpu: string;     // e.g. "0.5 vCPU" (display) — backend stores normalized
  mem: string;     // e.g. "512 Mi"
  gpu: string;     // e.g. "no GPU" | "AkashML"
};

export type CodeSample = {
  prompt: string;
  name: string;
  needsAkashML?: boolean;
  code: TokenLine[];
  source?: string;
  res: Resources;
};

export type AkashMLConnection = {
  // Full key, stored locally. Sent to the backend only when the user explicitly
  // triggers an action that needs it (deploy with GPU preset, agent chat).
  key: string;
  last4: string;
  connectedAt: number;
};

// Agent chat — natural-language function authoring.

export type AgentChatRole = 'user' | 'assistant';

export type AgentChatMessage = {
  role: AgentChatRole;
  content: string;
};

// Snapshot of whichever function editor is currently mounted in the UI. The
// backend uses this to prime the model with the relevant source.
export type AgentChatContext =
  | { mode: 'create'; preset: PresetId; name?: string; currentSource: string }
  | { mode: 'edit'; functionId: string; functionName: string; primaryPath: string; currentSource: string }
  | { mode: 'none' };

export type AgentChatRequest = {
  messages: AgentChatMessage[];
  context: AgentChatContext;
  akashmlKey: string;
  model?: string;
};

// Streamed chunks the route emits as SSE `data: {json}` frames.
export type AgentChatChunk =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ToastKind = 'ok' | 'error';
export type ToastMsg = { kind: ToastKind; text: string };

export type TemplateCategory =
  | 'all' | 'api' | 'web' | 'worker' | 'ai' | 'data';

export type Template = {
  id: string;
  cat: Exclude<TemplateCategory, 'all'>;
  preset: PresetId;
  icon: string;
  name: string;
  desc: string;
  runtime: string;
  tags: string[];
  akashml?: boolean;
};

// Backend-only, but lives here so both sides agree on the shape.
export type DeploymentState =
  | 'pending' | 'bidding' | 'leased' | 'live' | 'failed' | 'closed';

// HTTP route detected from the function's source code. The server scans the
// source map for `<router>.<verb>("/path", ...)` registrations and surfaces
// the result on the deployment so the UI can render an at-a-glance API
// surface and runnable snippets.
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// 'public' — anyone can call the route.
// 'apiKey' — caller must present a valid wallet-scoped API key via either
//           `Authorization: Bearer <key>` or `x-api-key: <key>`. The runner
//           sidecar enforces this before the request reaches user code.
// `auth` is decorated onto extracted routes from the function's per-function
// `protectedRoutes` set; it is NOT detected from source code itself.
export type RouteAuth = 'public' | 'apiKey';

export type FunctionRoute = {
  method: RouteMethod;
  path: string;
  description?: string;
  body?: unknown;
  auth?: RouteAuth;
};

// Wire format for the per-function protected-routes set: array of
// `"<METHOD> <path>"` strings (e.g. `"POST /api/secret"`). Stored on
// functions.protected_routes and applied to the auto-detected route list
// at fetch time.
export type ProtectedRouteKey = string;

export type DeploymentRecord = {
  id: string;
  functionId: string;
  versionId: string;
  state: DeploymentState;
  dseq?: string;
  gseq?: number;
  oseq?: number;
  provider?: string;
  uris?: string[];
  errorMessage?: string;
  routes?: FunctionRoute[];
  /** Semver self-reported by the running runner on its last successful poll. */
  runnerVersion?: string;
  /** ISO timestamp of the last poll that reported runnerVersion. */
  runnerSeenAt?: string;
  /** The version the platform currently expects runners to be at. */
  expectedRunnerVersion?: string;
  /** True when the runner is on an older version (or never reported and the
   *  deployment is past the "just came up" grace window). UI uses this to
   *  surface a nudge to click the in-place Update runner image button. */
  runnerOutdated?: boolean;
  /** True when the runner has gone silent on the poll loop while the deployment
   *  is still live — almost always means BACKEND_BASE_URL is stale (e.g. dev
   *  cloudflared tunnel rotated). Recover by pushing a fresh SDL via the same
   *  in-place /update-image flow. */
  runnerStale?: boolean;
  createdAt: string;
  liveAt?: string;
  closedAt?: string;
};

// API request/response shapes

// GPU spec carried in the resources block. Optional — when absent, no GPU is
// requested. One vendor + one model per request (matches the Console API's
// per-model availability granularity).
export type GpuSpec = {
  vendor: 'nvidia' | 'amd';
  model: string;       // e.g. 'a100', 'h100', 'rtx4090'
  units?: number;      // default 1
};

export type ResourceRequest = {
  cpu: string;
  memory: string;
  storage: string;
  gpu?: GpuSpec;
};

export type CreateFunctionRequest = {
  name: string;
  preset: PresetId;
  prompt?: string;
  source: Record<string, string>; // path → contents
  resources: ResourceRequest;
  envVars?: Record<string, string>;
};

export type UpdateCodeRequest = {
  source: Record<string, string>;
  message?: string;
  resources?: ResourceRequest;
  envVars?: Record<string, string>;
};

// Surface for the GPU dropdown in the builder. Returned from /api/gpu-models.
export type GpuModelOption = {
  vendor: 'nvidia' | 'amd';
  model: string;
  ram: string | null;       // e.g. "80Gi" — null for unknown
  interface: string | null; // e.g. "SXM4" | "PCIe"
  allocatable: number;
  allocated: number;
  available: number;        // allocatable - allocated
};

// `bottleneck` names the single constraint filtering the pool the most.
// When matchingProviders is 0, it's the dimension to relax first.
export type FeasibilityCheck = {
  matchingProviders: number;
  totalActiveProviders: number;
  bottleneck?: 'cpu' | 'memory' | 'storage' | 'gpu';
};

export type DeployRequest = {
  versionId?: string;
  akashmlKey?: string;
};

export type FunctionVersionSummary = {
  id: string;
  createdAt: string;
  message: string | null;
  preset: PresetId;
  isLatest: boolean;
  deploymentCount: number;
};

export type FunctionVersionDetail = FunctionVersionSummary & {
  source: Record<string, string>;
  resources: ResourceRequest;
  envVars: Record<string, string>;
};

export type RestoreVersionRequest = {
  message?: string;
};

export type UpdateCodeResponse = {
  id: string;
  createdAt: string;
  message: string | null;
};

export type ApiError = {
  code: string;
  message: string;
};

// Wallet-scoped API key. Plaintext is only ever returned in
// CreateApiKeyResponse — the UI shows it once at creation and forgets it.
export type ApiKeyRecord = {
  id: string;
  name: string;
  /** Last 4 chars of the plaintext key, used for UI display. */
  maskedTail: string;
  createdAt: string;
};

export type CreateApiKeyRequest = {
  name: string;
};

export type CreateApiKeyResponse = ApiKeyRecord & {
  /** Plaintext, returned exactly once on POST /api/keys. Never persisted. */
  key: string;
};

// Per-function protected-routes set. Stored on the function and applied at
// deployment-record fetch time.
export type ProtectedRoutesResponse = {
  protectedRoutes: ProtectedRouteKey[];
};

export type UpdateProtectedRoutesRequest = {
  protectedRoutes: ProtectedRouteKey[];
};

// User-defined function variables. The browser-facing API is write-only:
// `value` is set on PUT, but list/get responses NEVER return it. To "view"
// a value, you can't — to "change" it, you overwrite.
export type FunctionVariableSummary = {
  key: string;
  /** ISO timestamp of the last create/update for this variable. */
  updatedAt: string;
};

export type FunctionVariablesResponse = {
  variables: FunctionVariableSummary[];
  /**
   * Monotonic counter on the function. The runner polls
   * /api/runner/current/:fnId; when this changes it refetches env and
   * respawns the user process.
   */
  variablesRevision: number;
};

export type PutFunctionVariableRequest = {
  value: string;
};

export type PutFunctionVariableResponse = {
  key: string;
  updatedAt: string;
  variablesRevision: number;
};

export type DeleteFunctionVariableResponse = {
  key: string;
  variablesRevision: number;
};
