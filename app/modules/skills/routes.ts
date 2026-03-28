import { Router } from 'express'
import { homedir } from 'node:os'
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ApiKeyStoreLike } from '../../server/api-keys/store.js'
import { combinedAuth } from '../../server/middleware/combined-auth.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string
  dirName: string
  description: string
  userInvocable: boolean
  argumentHint?: string
  allowedTools?: string
  /** Source package (e.g. "pkos", "general-skills") */
  source: string
  /** Whether a .conf file exists at ~/.config/gehirn/<name>.conf */
  hasConfig: boolean
  /** Absolute path to the config file */
  configPath: string
}

export interface SkillConfig {
  /** Raw key-value pairs from the .conf file */
  fields: Record<string, string>
  /** Path to the config file */
  configPath: string
  /** Whether the file existed before reading */
  exists: boolean
  /** Path to the template file (if exists) */
  templatePath?: string
}

export interface SkillsRouterOptions {
  apiKeyStore?: ApiKeyStoreLike
  auth0Domain?: string
  auth0Audience?: string
  auth0ClientId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_SKILLS_DIR = path.join(homedir(), 'App', 'agent-skills')
const CONFIG_DIR = path.join(homedir(), '.config', 'gehirn')

function parseFrontmatter(content: string): Record<string, string | boolean> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result: Record<string, string | boolean> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    let val = line.slice(colonIdx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (val === 'true') {
      result[key] = true
    } else if (val === 'false') {
      result[key] = false
    } else {
      result[key] = val
    }
  }
  return result
}

function parseConfFile(content: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    fields[key] = val
  }
  return fields
}

function serializeConfFile(
  fields: Record<string, string>,
  templateContent?: string,
): string {
  // If we have a template, preserve comments and structure, just update values
  if (templateContent) {
    const lines = templateContent.split('\n')
    const result: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        result.push(line)
        continue
      }
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) {
        result.push(line)
        continue
      }
      const key = trimmed.slice(0, eqIdx).trim()
      if (key in fields) {
        const val = fields[key]
        // Quote values that contain spaces or special chars
        const needsQuotes = val.includes(' ') || val.includes(',') || val.includes('$')
        result.push(`${key}=${needsQuotes ? `"${val}"` : val}`)
      } else {
        result.push(line)
      }
    }
    // Add any new keys not in template
    const templateKeys = new Set<string>()
    for (const line of lines) {
      const eqIdx = line.trim().indexOf('=')
      if (eqIdx > 0 && !line.trim().startsWith('#')) {
        templateKeys.add(line.trim().slice(0, eqIdx).trim())
      }
    }
    for (const [key, val] of Object.entries(fields)) {
      if (!templateKeys.has(key)) {
        const needsQuotes = val.includes(' ') || val.includes(',') || val.includes('$')
        result.push(`${key}=${needsQuotes ? `"${val}"` : val}`)
      }
    }
    return result.join('\n')
  }

  // No template — generate fresh
  const lines: string[] = []
  for (const [key, val] of Object.entries(fields)) {
    const needsQuotes = val.includes(' ') || val.includes(',') || val.includes('$')
    lines.push(`${key}=${needsQuotes ? `"${val}"` : val}`)
  }
  return lines.join('\n') + '\n'
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** Validate that a skill name is safe (no path traversal). */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name)
}

/** Derive config file name from skill directory name. */
function configFileName(dirName: string): string {
  return `${dirName}.conf`
}

// ---------------------------------------------------------------------------
// Skill discovery — scans ~/App/agent-skills/{pkg}/{skill}/SKILL.md
// ---------------------------------------------------------------------------

async function discoverSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  const seen = new Set<string>()

  let packages: string[]
  try {
    const entries = await readdir(AGENT_SKILLS_DIR, { withFileTypes: true })
    packages = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return skills
  }

  for (const pkg of packages) {
    const pkgDir = path.join(AGENT_SKILLS_DIR, pkg)
    let skillDirs: string[]
    try {
      const entries = await readdir(pkgDir, { withFileTypes: true })
      skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }

    for (const dirName of skillDirs) {
      if (seen.has(dirName)) continue
      const skillMd = path.join(pkgDir, dirName, 'SKILL.md')
      try {
        const content = await readFile(skillMd, 'utf-8')
        const fm = parseFrontmatter(content)
        const name = typeof fm.name === 'string' ? fm.name : dirName
        const confPath = path.join(CONFIG_DIR, configFileName(dirName))
        const confExists = await fileExists(confPath)

        seen.add(dirName)
        skills.push({
          name,
          dirName,
          description: typeof fm.description === 'string' ? fm.description : '',
          userInvocable: fm['user-invocable'] === true || fm['user-invocable'] === 'true',
          argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : undefined,
          allowedTools: typeof fm['allowed-tools'] === 'string' ? fm['allowed-tools'] : undefined,
          source: pkg,
          hasConfig: confExists,
          configPath: confPath,
        })
      } catch {
        // No valid SKILL.md — skip
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

async function readSkillConfig(dirName: string): Promise<SkillConfig> {
  const confPath = path.join(CONFIG_DIR, configFileName(dirName))
  const result: SkillConfig = {
    fields: {},
    configPath: confPath,
    exists: false,
  }

  // Try to find template in agent-skills for structure/comments
  try {
    const entries = await readdir(AGENT_SKILLS_DIR, { withFileTypes: true })
    for (const pkg of entries.filter((e) => e.isDirectory())) {
      const templatePath = path.join(AGENT_SKILLS_DIR, pkg.name, dirName, `${dirName}.conf`)
      if (await fileExists(templatePath)) {
        result.templatePath = templatePath
        break
      }
      // Also check .conf.template
      const templatePath2 = path.join(AGENT_SKILLS_DIR, pkg.name, dirName, `${dirName}.conf.template`)
      if (await fileExists(templatePath2)) {
        result.templatePath = templatePath2
        break
      }
    }
  } catch {
    // ignore
  }

  // Read the active config file
  try {
    const content = await readFile(confPath, 'utf-8')
    result.fields = parseConfFile(content)
    result.exists = true
  } catch {
    // Config doesn't exist yet — try reading the template for defaults
    if (result.templatePath) {
      try {
        const tmpl = await readFile(result.templatePath, 'utf-8')
        result.fields = parseConfFile(tmpl)
      } catch {
        // no defaults available
      }
    }
  }

  return result
}

async function writeSkillConfig(
  dirName: string,
  fields: Record<string, string>,
): Promise<void> {
  const confPath = path.join(CONFIG_DIR, configFileName(dirName))

  // Read template for comment preservation
  let templateContent: string | undefined
  try {
    const entries = await readdir(AGENT_SKILLS_DIR, { withFileTypes: true })
    for (const pkg of entries.filter((e) => e.isDirectory())) {
      for (const candidate of [
        path.join(AGENT_SKILLS_DIR, pkg.name, dirName, `${dirName}.conf`),
        path.join(AGENT_SKILLS_DIR, pkg.name, dirName, `${dirName}.conf.template`),
      ]) {
        if (await fileExists(candidate)) {
          templateContent = await readFile(candidate, 'utf-8')
          break
        }
      }
      if (templateContent) break
    }
  } catch {
    // ignore
  }

  // Try reading existing file as template if no skill template found
  if (!templateContent) {
    try {
      templateContent = await readFile(confPath, 'utf-8')
    } catch {
      // fresh write
    }
  }

  await mkdir(path.dirname(confPath), { recursive: true })
  const content = serializeConfFile(fields, templateContent)
  await writeFile(confPath, content, 'utf-8')
}

// ---------------------------------------------------------------------------
// Run history — reads from command-room run logs
// ---------------------------------------------------------------------------

async function getSkillHistory(
  skillName: string,
  limit: number = 20,
): Promise<Array<{ id: string; status: string; startedAt: string; finishedAt?: string; trigger: string }>> {
  // Look for command-room runs that match this skill name
  const commanderDataDir = process.env.COMMANDER_DATA_DIR
    || path.join(homedir(), '.hammurabi', 'commander')
  const runsDir = path.join(commanderDataDir, 'command-room', 'runs')

  const runs: Array<{
    id: string
    status: string
    startedAt: string
    finishedAt?: string
    trigger: string
  }> = []

  try {
    const entries = await readdir(runsDir, { withFileTypes: true })
    // Sort by name descending (newer first)
    const sorted = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()

    for (const runId of sorted) {
      if (runs.length >= limit) break
      const metaPath = path.join(runsDir, runId, 'meta.json')
      try {
        const raw = await readFile(metaPath, 'utf-8')
        const meta = JSON.parse(raw) as Record<string, unknown>
        const taskName = String(meta.taskName || meta.skill || meta.name || '')
        // Match by skill name (with or without leading /)
        if (
          taskName === skillName ||
          taskName === `/${skillName}` ||
          taskName.includes(skillName)
        ) {
          runs.push({
            id: runId,
            status: String(meta.status || 'unknown'),
            startedAt: String(meta.startedAt || meta.createdAt || ''),
            finishedAt: meta.finishedAt ? String(meta.finishedAt) : undefined,
            trigger: String(meta.trigger || 'manual'),
          })
        }
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // runs dir doesn't exist
  }

  return runs
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSkillsRouter(options: SkillsRouterOptions = {}): Router {
  const router = Router()

  const requireReadAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['skills:read'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
  })

  const requireWriteAccess = combinedAuth({
    apiKeyStore: options.apiKeyStore,
    requiredApiKeyScopes: ['skills:write'],
    domain: options.auth0Domain,
    audience: options.auth0Audience,
    clientId: options.auth0ClientId,
  })

  // GET /api/skills — list all installed skills
  router.get('/', requireReadAccess, async (_req, res) => {
    try {
      const skills = await discoverSkills()
      res.json(skills)
    } catch (err) {
      res.status(500).json({ error: 'Failed to discover skills', detail: String(err) })
    }
  })

  // GET /api/skills/:name/config — read config as JSON
  router.get('/:name/config', requireReadAccess, async (req, res) => {
    const name = String(req.params.name)
    if (!isValidSkillName(name)) {
      res.status(400).json({ error: 'Invalid skill name' })
      return
    }

    try {
      const config = await readSkillConfig(name)
      res.json(config)
    } catch (err) {
      res.status(500).json({ error: 'Failed to read config', detail: String(err) })
    }
  })

  // PUT /api/skills/:name/config — write config from JSON
  router.put('/:name/config', requireWriteAccess, async (req, res) => {
    const name = String(req.params.name)
    if (!isValidSkillName(name)) {
      res.status(400).json({ error: 'Invalid skill name' })
      return
    }

    const { fields } = req.body as { fields?: Record<string, string> }
    if (!fields || typeof fields !== 'object') {
      res.status(400).json({ error: 'Request body must include a "fields" object' })
      return
    }

    // Validate all values are strings (no injection)
    for (const [key, val] of Object.entries(fields)) {
      if (typeof key !== 'string' || typeof val !== 'string') {
        res.status(400).json({ error: `Field "${key}" must be a string` })
        return
      }
      // Reject shell-dangerous characters in values
      if (/[`$\\]/.test(val) && !val.startsWith('$HOME')) {
        res.status(400).json({
          error: `Field "${key}" contains potentially unsafe characters`,
        })
        return
      }
    }

    try {
      await writeSkillConfig(name, fields)
      const updated = await readSkillConfig(name)
      res.json(updated)
    } catch (err) {
      res.status(500).json({ error: 'Failed to write config', detail: String(err) })
    }
  })

  // GET /api/skills/:name/history — recent runs
  router.get('/:name/history', requireReadAccess, async (req, res) => {
    const name = String(req.params.name)
    if (!isValidSkillName(name)) {
      res.status(400).json({ error: 'Invalid skill name' })
      return
    }

    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 100)

    try {
      const history = await getSkillHistory(name, limit)
      res.json(history)
    } catch (err) {
      res.status(500).json({ error: 'Failed to read history', detail: String(err) })
    }
  })

  return router
}
