export type DeploymentTarget = 'vercel';

export type ResourceConfig = {
  cpu: string;
  memory: string;
  storage: string;
};

export type AkashFunctionsConfig = {
  project?: string;
  apiBase?: string;
  target?: DeploymentTarget;
  functions?: {
    include?: string[];
    exclude?: string[];
    env?: string[];
    resources?: ResourceConfig;
    wait?: boolean;
  };
};

export type RouteKind = 'pages-api' | 'app-route';

export type DiscoveredRoute = {
  kind: RouteKind;
  file: string;
  routePath: string;
  nextPattern: string;
  vercelSource: string;
  name: string;
};

export type BuiltFunction = {
  route: DiscoveredRoute;
  source: Record<string, string>;
  envVars: Record<string, string>;
  resources: ResourceConfig;
};

export type UpsertResponse = {
  function: {
    id: string;
    name: string;
    ingressUrl?: string;
    status?: string;
    latestDeploymentId?: string;
  };
  versionId: string;
  deploymentId?: string;
  ingressUrl?: string;
  stableUrl?: string;
  originToken?: string;
  action: 'created' | 'updated' | 'deployed' | 'reused-deployment' | 'dry-run';
};

export type DeploymentPollResponse = {
  id: string;
  functionId: string;
  versionId: string;
  state: 'pending' | 'bidding' | 'leased' | 'live' | 'failed' | 'closed';
  uris?: string[];
  errorMessage?: string;
};

export type RewriteEntry = {
  source: string;
  destination: string;
};

export type DeploymentState = {
  generatedAt: string;
  project: string;
  target: DeploymentTarget;
  functions: Array<{
    name: string;
    route: string;
    source: string;
    functionId: string;
    versionId: string;
    deploymentId?: string;
    ingressUrl?: string;
    stableUrl?: string;
  }>;
  rewrites: RewriteEntry[];
};
