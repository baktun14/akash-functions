// In-place SDL push (MsgUpdateDeployment) used to (a) roll out a new runner
// image and (b) recover a deployment whose runner has gone silent because
// BACKEND_BASE_URL is stale (typical dev case: trycloudflare quick-tunnel
// rotated and the SDL still bakes the old hostname).
//
// Same physical operation for both reasons: rebuild the SDL from scratch
// using the current env.CODE_HOST_BASE and submit it on the existing dseq.
// The Akash provider re-pulls the image and restarts the container while
// keeping the lease, gseq, oseq, and ingress URIs intact.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { deployments, functionVersions, type DeploymentRow } from '../db/schema';
import { log } from '../lib/log';
import { signRunner } from '../lib/signing';
import { consoleApi } from './console-client';
import { buildSdl } from './sdl';

export type RebindReason = 'manual' | 'auto-stale';

export type RebindOutcome =
  | { ok: true; deployment: DeploymentRow }
  | { ok: false; status: number; message: string };

/**
 * Rebuild this deployment's SDL with the current backend URL + runner image
 * and submit it on-chain via MsgUpdateDeployment. Returns the updated row on
 * success.
 *
 * Callers are expected to have already authorized the request (e.g. confirmed
 * the deployment belongs to the wallet). This function does not enforce
 * ownership — pass the right ids.
 */
export async function rebuildAndUpdateSdl(args: {
  akashKey: string;
  fnId: string;
  dep: DeploymentRow;
  reason: RebindReason;
}): Promise<RebindOutcome> {
  const { akashKey, fnId, dep, reason } = args;

  if (dep.state !== 'live' || !dep.dseq) {
    return {
      ok: false,
      status: 409,
      message: `Deployment is ${dep.state}; only live deployments can be updated`,
    };
  }

  const [version] = await db
    .select()
    .from(functionVersions)
    .where(eq(functionVersions.id, dep.versionId))
    .limit(1);
  if (!version) {
    return { ok: false, status: 500, message: 'Version row missing for deployment' };
  }

  // Fresh runner token + fresh resolveRunnerImage() pick up the new :latest tag.
  // The previous token stays valid until expiry, so any in-flight runner→server
  // calls during the container swap won't 401.
  const runnerToken = signRunner({ fnId });
  const sdl = await buildSdl({
    functionId: fnId,
    initialVersionId: dep.versionId,
    runnerToken,
    resources: version.resources,
  });

  await consoleApi.updateDeployment(akashKey, dep.dseq, sdl);
  log.info('sdl update submitted', {
    fnId,
    depId: dep.id,
    dseq: dep.dseq,
    versionId: dep.versionId,
    reason,
  });

  // Optimistically clear errorMessage. The new container's health probe will
  // re-write it if the new image breaks anything; otherwise the old text would
  // sit there during the restart window even though it no longer applies.
  await db
    .update(deployments)
    .set({ errorMessage: null })
    .where(and(eq(deployments.id, dep.id), eq(deployments.state, 'live')));

  return { ok: true, deployment: { ...dep, errorMessage: null } };
}
