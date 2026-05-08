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
};

export type PresetId = 'rest' | 'jsx' | 'cron' | 'gpu';

export type Preset = {
  id: PresetId;
  label: string;
  icon: string;
  akash?: boolean;
};

// Tokenized lines for the syntax-highlighted code preview in the function builder
// and source-code tab. Each line is an array of [class, text] tuples.
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
  res: Resources;
};

export type AkashMLConnection = {
  last4: string;
  connectedAt: number;
};

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
  createdAt: string;
  liveAt?: string;
  closedAt?: string;
};

export type UsageInfo = {
  usd: number;
  act: number;
  burnRatePerDay: number;
};

// API request/response shapes
export type CreateFunctionRequest = {
  name: string;
  preset: PresetId;
  prompt?: string;
  source: Record<string, string>; // path → contents
  resources: { cpu: string; memory: string; storage: string };
  envVars?: Record<string, string>;
};

export type UpdateCodeRequest = {
  source: Record<string, string>;
  message?: string;
  resources?: { cpu: string; memory: string; storage: string };
  envVars?: Record<string, string>;
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
  resources: { cpu: string; memory: string; storage: string };
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
