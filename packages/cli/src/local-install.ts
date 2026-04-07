import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_HAMBROS_HOME_DIRNAME = '.hambros'
export const DEFAULT_HAMBROS_LOCAL_ORIGIN = 'http://localhost:5173'

function resolveHambrosHomeFromInvocation(invocationPath: string | undefined): string | null {
  const trimmed = invocationPath?.trim()
  if (!trimmed) {
    return null
  }

  let resolvedInvocationPath: string
  try {
    resolvedInvocationPath = realpathSync(trimmed)
  } catch {
    resolvedInvocationPath = path.resolve(trimmed)
  }

  let current = path.dirname(resolvedInvocationPath)
  while (true) {
    if (path.basename(current) === 'app' && existsSync(path.join(current, 'package.json'))) {
      return path.dirname(current)
    }

    if (existsSync(path.join(current, 'app', 'package.json'))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }

    current = parent
  }
}

export function resolveHambrosHome(
  env: NodeJS.ProcessEnv = process.env,
  invocationPath: string | undefined = process.argv[1],
): string {
  const override = env.HAMBROS_HOME?.trim()
  if (override && override.length > 0) {
    return path.resolve(override)
  }

  const inferred = resolveHambrosHomeFromInvocation(invocationPath)
  if (inferred) {
    return inferred
  }

  return path.join(homedir(), DEFAULT_HAMBROS_HOME_DIRNAME)
}

export function resolveHambrosAppRoot(
  env: NodeJS.ProcessEnv = process.env,
  invocationPath: string | undefined = process.argv[1],
): string {
  return path.join(resolveHambrosHome(env, invocationPath), 'app')
}

export function resolveHambrosEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  invocationPath: string | undefined = process.argv[1],
): string {
  return path.join(resolveHambrosAppRoot(env, invocationPath), '.env')
}
