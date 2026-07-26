import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const AGENT_SKILLS_DIR_ENV = 'HERD_AGENT_SKILLS_DIR'
export const DIRECT_SKILLS_DIRS_ENV = 'HERD_DIRECT_SKILLS_DIRS'
const APP_PATH_FILE = path.join(homedir(), '.herd', 'app-path')
const BUNDLED_AGENT_SKILLS_RELATIVE_PATH = path.join('runtime', 'defaults', 'agent-skills')
const BUNDLED_STARTER_SKILLS_RELATIVE_PATH = path.join(
  'public',
  'repo-root',
  'agent-skills',
  'herd-starter',
)

export interface SkillDirectorySource {
  dir: string
  source: string
}

function pushUnique(candidates: string[], candidate: string | null | undefined): void {
  const trimmed = candidate?.trim()
  if (!trimmed) {
    return
  }

  const resolved = path.resolve(trimmed)
  if (!candidates.includes(resolved)) {
    candidates.push(resolved)
  }
}

function pushUniqueSource(
  candidates: SkillDirectorySource[],
  candidate: string | null | undefined,
  source: string,
): void {
  const trimmed = candidate?.trim()
  if (!trimmed) {
    return
  }

  const resolved = path.resolve(trimmed)
  if (!candidates.some((entry) => entry.dir === resolved)) {
    candidates.push({ dir: resolved, source })
  }
}

function splitPathList(raw: string | undefined): string[] {
  return raw
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? []
}

async function readInstalledAppDir(): Promise<string | null> {
  try {
    const raw = await readFile(APP_PATH_FILE, 'utf8')
    return raw.trim() || null
  } catch {
    return null
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

export function resolveBundledAgentSkillsDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, BUNDLED_AGENT_SKILLS_RELATIVE_PATH)
}

export function resolveBundledStarterSkillsDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, BUNDLED_STARTER_SKILLS_RELATIVE_PATH)
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  )
}

export async function isBundledAgentSkillPath(
  candidate: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  const bundledRoots = [
    resolveBundledAgentSkillsDir(cwd),
    resolveBundledStarterSkillsDir(cwd),
  ]
  const resolvedCandidate = path.resolve(candidate)
  const isLexicallyBundled = bundledRoots.some((root) => isPathWithin(root, resolvedCandidate))

  for (const bundledRoot of bundledRoots) {
    try {
      const [canonicalBundledRoot, canonicalCandidate] = await Promise.all([
        realpath(bundledRoot),
        realpath(resolvedCandidate),
      ])
      if (isPathWithin(canonicalBundledRoot, canonicalCandidate)) {
        return true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  return isLexicallyBundled
}

export async function resolveAgentSkillsDirCandidates(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const candidates: string[] = []
  pushUnique(candidates, env[AGENT_SKILLS_DIR_ENV])

  pushUnique(candidates, path.join(cwd, 'agent-skills'))
  pushUnique(candidates, path.join(cwd, '..', 'agent-skills'))
  pushUnique(candidates, path.join(cwd, '..', '..', 'agent-skills'))

  const installedAppDir = await readInstalledAppDir()
  if (installedAppDir) {
    pushUnique(candidates, path.join(installedAppDir, '..', '..', 'agent-skills'))
  }

  pushUnique(candidates, path.join(homedir(), 'Herd', 'agent-skills'))
  pushUnique(candidates, path.join(homedir(), 'App', 'agent-skills'))
  pushUnique(candidates, resolveBundledAgentSkillsDir(cwd))

  return candidates
}

export async function resolveAgentSkillsDir(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const candidates = await resolveAgentSkillsDirCandidates(cwd, env)
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      return candidate
    }
  }
  return null
}

export async function discoverAgentSkillPackageDirs(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const packageDirs: string[] = []
  const agentSkillsDirs = await resolveAgentSkillsDirCandidates(cwd, env)

  for (const agentSkillsDir of agentSkillsDirs) {
    if (!await isDirectory(agentSkillsDir)) {
      continue
    }

    try {
      const entries = await readdir(agentSkillsDir, { withFileTypes: true })
      const packageNames = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      for (const packageName of packageNames) {
        pushUnique(packageDirs, path.join(agentSkillsDir, packageName))
      }
    } catch {
      // Continue to lower-precedence roots.
    }
  }

  const starterSkillsDir = resolveBundledStarterSkillsDir(cwd)
  if (await isDirectory(starterSkillsDir)) {
    pushUnique(packageDirs, starterSkillsDir)
  }

  return packageDirs
}

export async function resolveDirectSkillDirCandidates(
  _cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillDirectorySource[]> {
  const candidates: SkillDirectorySource[] = []

  for (const directDir of splitPathList(env[DIRECT_SKILLS_DIRS_ENV])) {
    pushUniqueSource(candidates, directDir, path.basename(directDir) || 'direct')
  }

  pushUniqueSource(candidates, path.join(homedir(), '.claude', 'skills'), '.claude')
  pushUniqueSource(candidates, path.join(homedir(), '.codex', 'skills'), '.codex')
  pushUniqueSource(candidates, path.join(homedir(), '.openclaw', 'skills'), '.openclaw')

  return candidates
}

export async function discoverSkillDirectorySources(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillDirectorySource[]> {
  const sources: SkillDirectorySource[] = []

  for (const candidate of await resolveDirectSkillDirCandidates(cwd, env)) {
    if (await isDirectory(candidate.dir)) {
      pushUniqueSource(sources, candidate.dir, candidate.source)
    }
  }

  for (const packageDir of await discoverAgentSkillPackageDirs(cwd, env)) {
    pushUniqueSource(sources, packageDir, path.basename(packageDir))
  }

  return sources
}
