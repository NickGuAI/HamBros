import path from 'node:path'
import {
  acquireFileLock,
  type FileLockHandoffOptions,
  type HeldFileLock,
} from '../modules/durable-file.js'
import { resolveHerdDataDir } from '../modules/data-dir.js'

const MALFORMED_LOCK_STALE_MS = 60 * 60 * 1000
const RAILWAY_VOLUME_LOCK_NAMESPACE = 'railway-volume'

function nonEmptyEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function resolveRailwayStoreLockHandoff(
  env: NodeJS.ProcessEnv,
): FileLockHandoffOptions | undefined {
  const projectId = nonEmptyEnvValue(env, 'RAILWAY_PROJECT_ID')
  const environmentId = nonEmptyEnvValue(env, 'RAILWAY_ENVIRONMENT_ID')
  const serviceId = nonEmptyEnvValue(env, 'RAILWAY_SERVICE_ID')
  const deploymentId = nonEmptyEnvValue(env, 'RAILWAY_DEPLOYMENT_ID')
  const volumeName = nonEmptyEnvValue(env, 'RAILWAY_VOLUME_NAME')
  const volumeMountPath = nonEmptyEnvValue(env, 'RAILWAY_VOLUME_MOUNT_PATH')
  const dataDir = resolveHerdDataDir(env)

  if (
    !projectId ||
    !environmentId ||
    !serviceId ||
    !deploymentId ||
    !volumeName ||
    !volumeMountPath ||
    !path.isAbsolute(volumeMountPath) ||
    path.resolve(volumeMountPath) !== dataDir
  ) {
    return undefined
  }

  return {
    scope: {
      namespace: RAILWAY_VOLUME_LOCK_NAMESPACE,
      resourceId: JSON.stringify({
        projectId,
        environmentId,
        serviceId,
        volumeName,
        mountPath: dataDir,
      }),
      instanceId: deploymentId,
    },
    // Locks created before scoped handoff metadata existed are recoverable only
    // after the complete Railway volume identity above has been validated.
    reclaimLegacyForeignHost: true,
  }
}

export function resolveHerdStoreLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHerdDataDir(env), '.store-writer.lock')
}

export async function acquireHerdStoreProcessLock(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeldFileLock> {
  return acquireFileLock(resolveHerdStoreLockPath(env), {
    staleMs: MALFORMED_LOCK_STALE_MS,
    handoff: resolveRailwayStoreLockHandoff(env),
  })
}
