import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform as readPlatform } from 'node:os'
import path from 'node:path'
import { formatStatusLine, printHervaldBrand } from './terminal-style.js'
import { loadDotenv, resolveAppDir } from './up.js'

interface Writable {
  write(chunk: string): boolean
}

interface CommandResult {
  status?: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: Error
}

type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    encoding: 'utf8'
  },
) => CommandResult

export interface UpdateCliDependencies {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  runCommand?: CommandRunner
  stdout?: Writable
  stderr?: Writable
}

export interface ParsedUpdateArgs {
  tag?: string
  repo?: string
  noRestart: boolean
  help: boolean
  error?: string
}

interface UpdateContext {
  appDir: string
  repoRoot: string
  dataDir: string
  dbPath: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  runCommand: CommandRunner
  stdout: Writable
  stderr: Writable
}

function commandOutputToString(output: string | Buffer | null | undefined): string {
  if (!output) {
    return ''
  }
  return typeof output === 'string' ? output : output.toString('utf8')
}

function runDefaultCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; encoding: 'utf8' },
): CommandResult {
  return spawnSync(command, args, options)
}

function expandHome(value: string): string {
  return value.replace(/^~(?=$|\/)/u, homedir())
}

function readEnvValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }
  return null
}

function readPackageName(appDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed && 'name' in parsed && typeof parsed.name === 'string') {
      return parsed.name.trim() || null
    }
  } catch {
    return null
  }
  return null
}

function defaultDbFileName(appDir: string): string {
  const packageName = readPackageName(appDir)
  if (packageName === 'herd' || path.basename(appDir) === 'herd') {
    return 'herd.sqlite'
  }
  return 'herd.sqlite'
}

function resolveUpdateDataDir(env: NodeJS.ProcessEnv): string {
  const configured = readEnvValue(env, ['HERD_DATA_DIR', 'HERD_DATA_DIR'])
  return path.resolve(configured ? expandHome(configured) : path.join(homedir(), '.herd'))
}

function resolveUpdateDbPath(appDir: string, dataDir: string, env: NodeJS.ProcessEnv): string {
  const configured = readEnvValue(env, ['HERD_DB_PATH', 'HERD_DB_PATH'])
  return path.resolve(configured ? expandHome(configured) : path.join(dataDir, defaultDbFileName(appDir)))
}

function toAppDirResolutionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolutionEnv = { ...env }
  if (!resolutionEnv.HERD_APP_DIR && resolutionEnv.HERD_APP_DIR) {
    resolutionEnv.HERD_APP_DIR = resolutionEnv.HERD_APP_DIR
  }
  if (!resolutionEnv.HERD_DATA_DIR && resolutionEnv.HERD_DATA_DIR) {
    resolutionEnv.HERD_DATA_DIR = resolutionEnv.HERD_DATA_DIR
  }
  return resolutionEnv
}

function readOptionValue(
  args: readonly string[],
  index: number,
  flag: string,
): { value?: string; nextIndex: number; error?: string } {
  const current = args[index]
  const inlinePrefix = `${flag}=`
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length).trim()
    return value && !value.startsWith('-')
      ? { value, nextIndex: index }
      : { nextIndex: index, error: `${flag} requires a value` }
  }

  const value = args[index + 1]?.trim()
  if (!value || value.startsWith('-')) {
    return { nextIndex: index, error: `${flag} requires a value` }
  }

  return { value, nextIndex: index + 1 }
}

export function parseUpdateArgs(args: readonly string[]): ParsedUpdateArgs {
  const parsed: ParsedUpdateArgs = {
    noRestart: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') {
      parsed.help = true
      continue
    }
    if (arg === '--no-restart') {
      parsed.noRestart = true
      continue
    }
    if (arg === '--tag' || arg.startsWith('--tag=')) {
      const result = readOptionValue(args, index, '--tag')
      if (result.error) {
        return { ...parsed, error: result.error }
      }
      parsed.tag = result.value
      index = result.nextIndex
      continue
    }
    if (arg === '--repo' || arg.startsWith('--repo=')) {
      const result = readOptionValue(args, index, '--repo')
      if (result.error) {
        return { ...parsed, error: result.error }
      }
      parsed.repo = result.value
      index = result.nextIndex
      continue
    }
    return { ...parsed, error: `Unknown option: ${arg}` }
  }

  return parsed
}

function printUpdateUsage(write: (chunk: string) => void): void {
  write('Usage: herd update [--tag <release-tag>] [--repo <git-url>] [--no-restart]\n')
  write('\n')
  write('  Upgrade the installed Herd checkout in place.\n')
  write('\n')
  write('Options:\n')
  write('  --tag <release-tag>  Release tag to install, for example v0.0.13-beta\n')
  write('  --repo <git-url>     Override the checkout origin before fetching\n')
  write('  --no-restart         Update and verify without restarting the service\n')
  write('  -h, --help           Show this help\n')
}

function compareReleaseTags(left: string, right: string): number {
  const leftParts = left.replace(/^v/u, '').split(/[.-]/u)
  const rightParts = right.replace(/^v/u, '').split(/[.-]/u)
  const maxLength = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? ''
    const rightPart = rightParts[index] ?? ''
    const leftNumber = Number(leftPart)
    const rightNumber = Number(rightPart)
    if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber
      }
      continue
    }
    const lexical = leftPart.localeCompare(rightPart)
    if (lexical !== 0) {
      return lexical
    }
  }
  return 0
}

export function selectLatestReleaseTag(lsRemoteOutput: string): string | null {
  const tags = lsRemoteOutput
    .split(/\r?\n/u)
    .map((line) => line.trim().match(/refs\/tags\/(v[^\s^]+)$/u)?.[1] ?? null)
    .filter((tag): tag is string => Boolean(tag))
  if (tags.length === 0) {
    return null
  }
  return tags.sort(compareReleaseTags).at(-1) ?? null
}

function readInstallerDefaultRef(appDir: string): string | null {
  const installerPath = path.join(appDir, 'install.sh')
  if (!existsSync(installerPath)) {
    return null
  }
  try {
    const installer = readFileSync(installerPath, 'utf8')
    const match = installer.match(/REPO_REF="\$\{HERD_REPO_REF:-(?:\$\{HERVALD_REPO_REF:-)?([^}]+)\}?\}"/u)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

function discoverLatestReleaseTag(context: UpdateContext): string | null {
  const result = context.runCommand(
    'git',
    ['-C', context.repoRoot, 'ls-remote', '--tags', '--refs', 'origin', 'v*'],
    {
      cwd: context.repoRoot,
      env: context.env,
      encoding: 'utf8',
    },
  )
  if (result.error || result.status !== 0) {
    return null
  }
  return selectLatestReleaseTag(commandOutputToString(result.stdout))
}

function resolveTargetTag(parsed: ParsedUpdateArgs, context: UpdateContext): string | null {
  if (parsed.tag) {
    return parsed.tag
  }
  const envTag = context.env.HERD_REPO_REF?.trim() || context.env.HERVALD_REPO_REF?.trim()
  if (envTag) {
    return envTag
  }
  return discoverLatestReleaseTag(context) ?? readInstallerDefaultRef(context.appDir)
}

function runRequired(
  context: UpdateContext,
  label: string,
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): CommandResult | null {
  context.stdout.write(`${formatStatusLine('info', label, [command, ...args].join(' '))}\n`)
  const result = context.runCommand(command, args, {
    cwd: options.cwd ?? context.repoRoot,
    env: context.env,
    encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    context.stderr.write(`${formatStatusLine(
      'fail',
      label,
      result.error?.message ?? `command exited ${String(result.status ?? 'unknown')}`,
    )}\n`)
    const out = commandOutputToString(result.stdout)
    const err = commandOutputToString(result.stderr)
    if (out.trim()) {
      context.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
    }
    if (err.trim()) {
      context.stderr.write(err.endsWith('\n') ? err : `${err}\n`)
    }
    return null
  }
  return result
}

function restartServer(context: UpdateContext): boolean {
  if (context.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid === null) {
      return false
    }
    return Boolean(runRequired(
      context,
      'Restart Herd',
      'launchctl',
      ['kickstart', '-k', `gui/${uid}/io.gehirn.hervald`],
      { cwd: homedir() },
    ))
  }

  if (context.platform === 'linux') {
    const userUnits = ['io.gehirn.hervald.service', 'io.gehirn.herd.service']
    for (const unit of userUnits) {
      const result = context.runCommand('systemctl', ['--user', 'restart', unit], {
        cwd: homedir(),
        env: context.env,
        encoding: 'utf8',
      })
      if (!result.error && result.status === 0) {
        context.stdout.write(`${formatStatusLine('pass', 'Restart Herd', `systemctl --user restart ${unit}`)}\n`)
        return true
      }
    }

    const systemCommand = typeof process.getuid === 'function' && process.getuid() === 0
      ? { command: 'systemctl', args: ['restart', 'herd.service'] }
      : { command: 'sudo', args: ['-n', 'systemctl', 'restart', 'herd.service'] }
    return Boolean(runRequired(
      context,
      'Restart Herd',
      systemCommand.command,
      systemCommand.args,
      { cwd: homedir() },
    ))
  }

  return false
}

function printRollbackNote(context: UpdateContext, previousHead: string): void {
  context.stdout.write('\nRollback note:\n')
  context.stdout.write(`  git -C ${context.repoRoot} reset --hard ${previousHead}\n`)
  context.stdout.write(`  pnpm --dir ${context.repoRoot} install --frozen-lockfile\n`)
  context.stdout.write(`  pnpm --dir ${context.repoRoot} --filter herd run build\n`)
  context.stdout.write('  restart Herd with the same service manager used by this install\n')
}

function buildContext(dependencies: UpdateCliDependencies): UpdateContext | { error: string } {
  const shellEnv = dependencies.env ?? process.env
  const appDir = resolveAppDir(toAppDirResolutionEnv(shellEnv))
  if (!appDir) {
    return {
      error: 'App directory not set. Run install.sh once, or export HERD_APP_DIR.',
    }
  }
  if (!existsSync(path.join(appDir, 'package.json'))) {
    return {
      error: `${appDir} is not a Herd install: expected package.json in the app directory.`,
    }
  }
  const repoRoot = path.resolve(appDir, '../..')
  if (!existsSync(path.join(repoRoot, '.git'))) {
    return {
      error: `${repoRoot} is not a git checkout; update requires a checkout install.`,
    }
  }
  const appEnv = loadDotenv(appDir)
  const resolvedEnv = { ...shellEnv, ...appEnv }
  const dataDir = resolveUpdateDataDir(resolvedEnv)
  const dbPath = resolveUpdateDbPath(appDir, dataDir, resolvedEnv)
  const env = { ...resolvedEnv }
  env.HERD_APP_DIR = appDir
  env.HERD_DATA_DIR = dataDir
  env.HERD_DB_PATH = dbPath
  env.HERD_APP_DIR = appDir
  env.HERD_DATA_DIR = dataDir
  env.HERD_DB_PATH = dbPath
  return {
    appDir,
    repoRoot,
    dataDir,
    dbPath,
    env,
    platform: dependencies.platform ?? readPlatform(),
    runCommand: dependencies.runCommand ?? runDefaultCommand,
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
  }
}

export async function runUpdateCli(
  args: readonly string[],
  dependencies: UpdateCliDependencies = {},
): Promise<number> {
  const parsed = parseUpdateArgs(args)
  const stdout = dependencies.stdout ?? process.stdout
  const stderr = dependencies.stderr ?? process.stderr
  if (parsed.help) {
    printUpdateUsage((chunk) => stdout.write(chunk))
    return 0
  }
  if (parsed.error) {
    stderr.write(`${formatStatusLine('fail', 'herd update', parsed.error)}\n`)
    printUpdateUsage((chunk) => stderr.write(chunk))
    return 1
  }

  const context = buildContext(dependencies)
  if ('error' in context) {
    stderr.write(`${formatStatusLine('fail', 'herd update', context.error)}\n`)
    return 1
  }

  printHervaldBrand('Herd update', (chunk) => context.stdout.write(chunk))

  if (parsed.repo) {
    const configured = runRequired(
      context,
      'Configure origin',
      'git',
      ['-C', context.repoRoot, 'remote', 'set-url', 'origin', parsed.repo],
    )
    if (!configured) {
      return 1
    }
  }

  const targetTag = resolveTargetTag(parsed, context)
  if (!targetTag) {
    stderr.write(`${formatStatusLine(
      'fail',
      'Release tag',
      'could not determine latest release tag',
      'Pass --tag <release-tag> explicitly.',
    )}\n`)
    return 1
  }

  const headResult = runRequired(context, 'Current revision', 'git', ['-C', context.repoRoot, 'rev-parse', 'HEAD'])
  if (!headResult) {
    return 1
  }
  const previousHead = commandOutputToString(headResult.stdout).trim() || 'HEAD@{1}'

  const steps: Array<[string, string, string[]]> = [
    ['Fetch release', 'git', ['-C', context.repoRoot, 'fetch', '--quiet', 'origin', targetTag]],
    ['Checkout release', 'git', ['-C', context.repoRoot, 'checkout', '--quiet', 'FETCH_HEAD']],
    ['Reset checkout', 'git', ['-C', context.repoRoot, 'reset', '--quiet', '--hard', 'FETCH_HEAD']],
    ['Install dependencies', 'pnpm', ['--dir', context.repoRoot, 'install', '--frozen-lockfile']],
    ['Build app', 'pnpm', ['--dir', context.repoRoot, '--filter', 'herd', 'run', 'build']],
    ['Check JSON stores', 'pnpm', [
      '--dir',
      context.repoRoot,
      '--filter',
      'herd',
      'run',
      'store:ready',
      '--',
      '--source-root',
      context.dataDir,
    ]],
    ['Check SQLite store', 'pnpm', [
      '--dir',
      context.repoRoot,
      '--filter',
      'herd',
      'run',
      'db:ready',
      '--',
      '--source-root',
      context.dataDir,
      '--db',
      context.dbPath,
    ]],
  ]

  for (const [label, command, stepArgs] of steps) {
    if (!runRequired(context, label, command, stepArgs)) {
      printRollbackNote(context, previousHead)
      return 1
    }
  }

  if (!parsed.noRestart && !restartServer(context)) {
    stderr.write(`${formatStatusLine(
      'fail',
      'Restart Herd',
      'could not restart automatically',
      'Restart the installed service manually before serving traffic.',
    )}\n`)
    printRollbackNote(context, previousHead)
    return 2
  }

  stdout.write(`${formatStatusLine('pass', 'Herd update', `installed ${targetTag}`)}\n`)
  printRollbackNote(context, previousHead)
  return 0
}
