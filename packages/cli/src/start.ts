import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveHambrosAppRoot } from './local-install.js'

interface Writable {
  write(chunk: string): boolean
}

export interface StartTarget {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

interface StartCliDependencies {
  env?: NodeJS.ProcessEnv
  fileExists?: (path: string) => boolean
  runCommand?: (target: StartTarget) => Promise<number>
  stdout?: Writable
  stderr?: Writable
}

function printUsage(stdout: Writable): void {
  stdout.write('Usage: hambros start\n')
}

function normalizeNodeEnv(
  env: NodeJS.ProcessEnv,
  fallback?: string,
): string | undefined {
  const current = env.NODE_ENV?.trim()
  if (current && current.length > 0) {
    return current
  }

  return fallback
}

export function resolveStartTarget(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): StartTarget | null {
  const sourceEntry = path.join(appRoot, 'server', 'index.ts')
  const startupWrapper = path.join(appRoot, 'scripts', 'start-with-memory-restore.sh')
  if (fileExists(sourceEntry)) {
    const hasBuiltClient = fileExists(path.join(appRoot, 'dist', 'index.html'))
    const nodeEnv = normalizeNodeEnv(env, hasBuiltClient ? 'production' : undefined)
    const nextEnv = nodeEnv
      ? {
          ...env,
          NODE_ENV: nodeEnv,
        }
      : { ...env }

    if (fileExists(startupWrapper)) {
      return {
        command: 'bash',
        args: [startupWrapper],
        cwd: appRoot,
        env: nextEnv,
      }
    }

    return {
      command: 'pnpm',
      args: ['tsx', 'server/index.ts'],
      cwd: appRoot,
      env: nextEnv,
    }
  }

  const builtCandidates = [
    path.join(appRoot, 'dist-server', 'server', 'index.js'),
    path.join(appRoot, 'dist-server', 'index.js'),
  ]
  const builtEntry = builtCandidates.find((candidate) => fileExists(candidate))
  if (builtEntry) {
    const nodeEnv = normalizeNodeEnv(env, 'production') ?? 'production'
    return {
      command: process.execPath,
      args: [builtEntry],
      cwd: appRoot,
      env: {
        ...env,
        NODE_ENV: nodeEnv,
      },
    }
  }

  return null
}

async function defaultRunCommand(target: StartTarget): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: target.env,
      stdio: 'inherit',
    })

    child.on('error', () => resolve(1))
    child.on('exit', (code) => resolve(code ?? 0))
  })
}

export async function runStartCli(
  args: readonly string[],
  dependencies: StartCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env
  const fileExists = dependencies.fileExists ?? existsSync
  const runCommand = dependencies.runCommand ?? defaultRunCommand
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr

  if (args.length > 0) {
    printUsage(stdout)
    return 1
  }

  const appRoot = resolveHambrosAppRoot(env)
  const appPackagePath = path.join(appRoot, 'package.json')
  const envPath = path.join(appRoot, '.env')

  if (!fileExists(appPackagePath)) {
    stderr.write(`HamBros install not found at ${appRoot}. Run install.sh first.\n`)
    return 1
  }

  if (!fileExists(envPath)) {
    stderr.write(`App config not found at ${envPath}. Run 'hambros init' first.\n`)
    return 1
  }

  const target = resolveStartTarget(appRoot, env, fileExists)
  if (!target) {
    stderr.write(`Could not find a runnable HamBros server entry under ${appRoot}.\n`)
    return 1
  }

  return runCommand(target)
}
