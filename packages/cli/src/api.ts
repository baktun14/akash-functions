import type {
  BuiltFunction,
  DeploymentPollResponse,
  UpsertResponse,
} from './types.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export async function healthCheck(apiBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${trimBase(apiBase)}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function upsertFunction(
  apiBase: string,
  apiKey: string,
  project: string,
  built: BuiltFunction,
  dryRun: boolean,
): Promise<UpsertResponse> {
  if (dryRun) {
    return {
      function: { id: `dry-${built.route.name}`, name: built.route.name },
      versionId: 'dry-run',
      action: 'dry-run',
    };
  }

  return requestJson<UpsertResponse>(
    apiBase,
    '/api/functions/vercel/upsert',
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        project,
        name: built.route.name,
        route: built.route.nextPattern,
        kind: built.route.kind,
        source: built.source,
        resources: built.resources,
        envVars: built.envVars,
        message: `Deploy ${built.route.nextPattern}`,
        deploy: true,
      }),
    },
  );
}

export async function getDeployment(
  apiBase: string,
  apiKey: string,
  functionId: string,
  deploymentId: string,
): Promise<DeploymentPollResponse> {
  return requestJson<DeploymentPollResponse>(
    apiBase,
    `/api/functions/${functionId}/deployments/${deploymentId}`,
    apiKey,
  );
}

export async function waitForDeploymentVersion(
  apiBase: string,
  apiKey: string,
  functionId: string,
  deploymentId: string,
  versionId: string,
  timeoutMs = 180_000,
): Promise<DeploymentPollResponse> {
  const started = Date.now();
  let last: DeploymentPollResponse | null = null;
  while (Date.now() - started < timeoutMs) {
    last = await getDeployment(apiBase, apiKey, functionId, deploymentId);
    if (last.state === 'failed') {
      throw new Error(last.errorMessage ?? `Deployment ${deploymentId} failed`);
    }
    if (last.state === 'closed') {
      throw new Error(`Deployment ${deploymentId} closed before version ${versionId} went live`);
    }
    if (last.errorMessage && last.versionId !== versionId) {
      throw new Error(`Deployment kept serving ${last.versionId}; new version ${versionId} failed probe: ${last.errorMessage}`);
    }
    if (last.state === 'live' && last.versionId === versionId && !last.errorMessage) {
      return last;
    }
    await sleep(3000);
  }
  throw new Error(
    `Timed out waiting for ${functionId} deployment ${deploymentId} to serve version ${versionId}` +
      (last ? ` (last state=${last.state}, version=${last.versionId})` : ''),
  );
}

async function requestJson<T>(
  apiBase: string,
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${trimBase(apiBase)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(`API request failed: ${res.status} ${res.statusText}`, res.status, text);
  }
  return JSON.parse(text) as T;
}

export function trimBase(apiBase: string): string {
  return apiBase.replace(/\/$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
