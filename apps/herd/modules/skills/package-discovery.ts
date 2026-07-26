import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  discoverSkillDirectorySources,
  isBundledAgentSkillPath,
  resolveDirectSkillDirCandidates,
  type SkillDirectorySource,
} from './skill-roots.js'

export interface SkillInfo {
  name: string
  dirName: string
  description: string
  userInvocable: boolean
  argumentHint?: string
  allowedTools?: string
  supportedProviders?: string[]
  /** Source package (e.g. "pkos", "general-skills") */
  source: string
}

export interface SkillPackageFile {
  path: string
  type: 'directory' | 'file'
  sizeBytes?: number
}

export interface SkillPackageSymbol {
  path: string
  name: string
  kind: 'heading' | 'function' | 'class'
  line: number
}

export interface SkillPackageDetail extends SkillInfo {
  directory: string
  displayDirectory: string
  skillMd: string
  files: SkillPackageFile[]
  symbols: SkillPackageSymbol[]
}

export interface SkillExportPreview {
  skill: SkillPackageDetail
  installDestinations: Array<{
    id: 'claude' | 'codex' | 'openclaw' | 'source-tree'
    label: string
    path: string
  }>
  archiveName: string
}

export interface SkillArchive {
  skill: SkillPackageDetail
  archiveName: string
  buffer: Buffer
}

export interface CreateManualSkillInput {
  name: string
  description: string
  provider: string
}

export class SkillPackageConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillPackageConflictError'
  }
}

export class ReadOnlySkillPackageError extends Error {
  constructor(skillName: string) {
    super(`Skill "${skillName}" is app-owned and read-only`)
    this.name = 'ReadOnlySkillPackageError'
  }
}

interface DiscoveredSkillPackage {
  info: SkillInfo
  directory: string
}

const MAX_PACKAGE_FILES = 240
const MAX_SYMBOLS = 160
const MAX_SYMBOL_SOURCE_BYTES = 200_000
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', '.turbo'])
let crc32Table: Uint32Array | null = null

export function parseFrontmatter(content: string): Record<string, string | boolean> {
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

function parseStringListField(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const listSource = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed
  const providers = listSource
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)

  return providers.length > 0 ? Array.from(new Set(providers)) : undefined
}

function normalizeSkillLookup(value: string): string {
  return value.trim().toLowerCase()
}

function slugifySkillName(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return null
  }
  return slug
}

function formatDisplayPath(value: string): string {
  const home = homedir()
  return value === home || value.startsWith(home + path.sep)
    ? `~${value.slice(home.length)}`
    : value
}

function frontmatterToSkillInfo(
  source: SkillDirectorySource,
  dirName: string,
  content: string,
): SkillInfo {
  const fm = parseFrontmatter(content)
  const name = typeof fm.name === 'string' ? fm.name : dirName

  return {
    name,
    dirName,
    description: typeof fm.description === 'string' ? fm.description : '',
    userInvocable: fm['user-invocable'] === true || fm['user-invocable'] === 'true',
    argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : undefined,
    allowedTools: typeof fm['allowed-tools'] === 'string' ? fm['allowed-tools'] : undefined,
    supportedProviders: parseStringListField(fm['supported-providers']),
    source: source.source,
  }
}

async function discoverSkillPackages(): Promise<DiscoveredSkillPackage[]> {
  const skills: DiscoveredSkillPackage[] = []
  const seen = new Set<string>()

  const skillSources = await discoverSkillDirectorySources()

  for (const skillSource of skillSources) {
    let skillDirs: string[]
    try {
      const entries = await readdir(skillSource.dir, { withFileTypes: true })
      skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }

    for (const dirName of skillDirs) {
      if (seen.has(dirName)) continue
      const directory = path.join(skillSource.dir, dirName)
      const skillMd = path.join(directory, 'SKILL.md')
      try {
        const content = await readFile(skillMd, 'utf-8')
        seen.add(dirName)
        skills.push({
          info: frontmatterToSkillInfo(skillSource, dirName, content),
          directory,
        })
      } catch {
        // No valid SKILL.md — skip
      }
    }
  }

  skills.sort((a, b) => a.info.name.localeCompare(b.info.name))
  return skills
}

export async function discoverSkills(): Promise<SkillInfo[]> {
  return (await discoverSkillPackages()).map((skill) => skill.info)
}

async function listPackageFiles(root: string, maxFiles = MAX_PACKAGE_FILES): Promise<SkillPackageFile[]> {
  const files: SkillPackageFile[] = []

  async function walk(current: string, relativeDir = ''): Promise<void> {
    if (maxFiles > 0 && files.length >= maxFiles) {
      return
    }

    let entries: Array<{
      name: string
      isDirectory(): boolean
      isFile(): boolean
    }>
    try {
      entries = await readdir(current, { withFileTypes: true }) as typeof entries
    } catch {
      return
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (maxFiles > 0 && files.length >= maxFiles) {
        return
      }
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
        continue
      }
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name
      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        files.push({ path: relativePath, type: 'directory' })
        await walk(absolutePath, relativePath)
      } else if (entry.isFile()) {
        let sizeBytes: number | undefined
        try {
          sizeBytes = (await stat(absolutePath)).size
        } catch {
          sizeBytes = undefined
        }
        files.push({
          path: relativePath,
          type: 'file',
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        })
      }
    }
  }

  await walk(root)
  return files
}

function symbolKindForCodeDeclaration(line: string): SkillPackageSymbol['kind'] | null {
  if (/^\s*(?:export\s+)?class\s+[$A-Z_a-z][$\w]*/.test(line)) {
    return 'class'
  }
  if (/^\s*class\s+[$A-Z_a-z][$\w]*/.test(line)) {
    return 'class'
  }
  if (/^\s*(?:async\s+)?(?:def|function)\s+[$A-Z_a-z][$\w]*/.test(line)) {
    return 'function'
  }
  if (/^\s*(?:export\s+)?(?:async\s+)?function\s+[$A-Z_a-z][$\w]*/.test(line)) {
    return 'function'
  }
  if (/^\s*(?:export\s+)?const\s+[$A-Z_a-z][$\w]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>/.test(line)) {
    return 'function'
  }
  if (/^\s*[$A-Z_a-z][$\w]*\s*\(\)\s*\{/.test(line)) {
    return 'function'
  }
  return null
}

function symbolNameForCodeDeclaration(line: string): string | null {
  const match = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([$A-Z_a-z][$\w]*)/)
    ?? line.match(/^\s*(?:export\s+)?const\s+([$A-Z_a-z][$\w]*)\s*=/)
    ?? line.match(/^\s*([$A-Z_a-z][$\w]*)\s*\(\)\s*\{/)
  return match?.[1] ?? null
}

function extractSymbolsFromContent(filePath: string, content: string): SkillPackageSymbol[] {
  const extension = path.extname(filePath).toLowerCase()
  const symbols: SkillPackageSymbol[] = []

  content.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    if (extension === '.md' || filePath === 'SKILL.md') {
      const heading = line.match(/^(#{1,4})\s+(.+)$/)
      if (heading?.[2]) {
        symbols.push({
          path: filePath,
          name: heading[2].trim(),
          kind: 'heading',
          line: lineNumber,
        })
      }
      return
    }

    if (!['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.sh', '.bash'].includes(extension)) {
      return
    }

    const kind = symbolKindForCodeDeclaration(line)
    const name = symbolNameForCodeDeclaration(line)
    if (kind && name) {
      symbols.push({
        path: filePath,
        name,
        kind,
        line: lineNumber,
      })
    }
  })

  return symbols
}

async function listPackageSymbols(root: string, files: readonly SkillPackageFile[]): Promise<SkillPackageSymbol[]> {
  const symbols: SkillPackageSymbol[] = []
  for (const file of files) {
    if (file.type !== 'file' || symbols.length >= MAX_SYMBOLS) {
      continue
    }
    if ((file.sizeBytes ?? 0) > MAX_SYMBOL_SOURCE_BYTES) {
      continue
    }

    try {
      const content = await readFile(path.join(root, file.path), 'utf-8')
      symbols.push(...extractSymbolsFromContent(file.path, content))
    } catch {
      // Binary or unreadable package files still appear in the file tree.
    }
  }

  return symbols.slice(0, MAX_SYMBOLS)
}

async function findSkillPackage(name: string): Promise<DiscoveredSkillPackage | null> {
  const normalized = normalizeSkillLookup(name)
  const packages = await discoverSkillPackages()
  return packages.find((skill) => (
    normalizeSkillLookup(skill.info.name) === normalized ||
    normalizeSkillLookup(skill.info.dirName) === normalized
  )) ?? null
}

export async function getSkillPackageDetail(name: string): Promise<SkillPackageDetail | null> {
  const skill = await findSkillPackage(name)
  if (!skill) {
    return null
  }

  const skillMd = await readFile(path.join(skill.directory, 'SKILL.md'), 'utf-8')
  const files = await listPackageFiles(skill.directory)
  return {
    ...skill.info,
    directory: skill.directory,
    displayDirectory: formatDisplayPath(skill.directory),
    skillMd,
    files,
    symbols: await listPackageSymbols(skill.directory, files),
  }
}

export async function getSkillExportPreview(name: string): Promise<SkillExportPreview | null> {
  const skill = await getSkillPackageDetail(name)
  if (!skill) {
    return null
  }

  return {
    skill,
    installDestinations: [
      { id: 'claude', label: 'Claude Code', path: `~/.claude/skills/${skill.dirName}` },
      { id: 'codex', label: 'Codex', path: `~/.codex/skills/${skill.dirName}` },
      { id: 'openclaw', label: 'OpenClaw', path: `~/.openclaw/skills/${skill.dirName}` },
      { id: 'source-tree', label: 'Source tree', path: `agent-skills/${skill.source}/${skill.dirName}` },
    ],
    archiveName: `${skill.dirName}.zip`,
  }
}

function getCrc32Table(): Uint32Array {
  if (crc32Table) {
    return crc32Table
  }

  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  crc32Table = table
  return table
}

function crc32(buffer: Buffer): number {
  const table = getCrc32Table()
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function localFileHeader(args: {
  fileName: Buffer
  crc: number
  size: number
}): Buffer {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(args.crc, 14)
  header.writeUInt32LE(args.size, 18)
  header.writeUInt32LE(args.size, 22)
  header.writeUInt16LE(args.fileName.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function centralDirectoryHeader(args: {
  fileName: Buffer
  crc: number
  size: number
  offset: number
}): Buffer {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(0, 14)
  header.writeUInt32LE(args.crc, 16)
  header.writeUInt32LE(args.size, 20)
  header.writeUInt32LE(args.size, 24)
  header.writeUInt16LE(args.fileName.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(0, 38)
  header.writeUInt32LE(args.offset, 42)
  return header
}

function endOfCentralDirectory(args: {
  entryCount: number
  centralDirectorySize: number
  centralDirectoryOffset: number
}): Buffer {
  const header = Buffer.alloc(22)
  header.writeUInt32LE(0x06054b50, 0)
  header.writeUInt16LE(0, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(args.entryCount, 8)
  header.writeUInt16LE(args.entryCount, 10)
  header.writeUInt32LE(args.centralDirectorySize, 12)
  header.writeUInt32LE(args.centralDirectoryOffset, 16)
  header.writeUInt16LE(0, 20)
  return header
}

async function buildZipBuffer(
  skill: Pick<SkillPackageDetail, 'directory' | 'dirName'>,
  files: readonly SkillPackageFile[],
): Promise<Buffer> {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  let entryCount = 0

  for (const file of files) {
    if (file.type !== 'file') {
      continue
    }
    const content = await readFile(path.join(skill.directory, file.path))
    const fileName = Buffer.from(path.posix.join(skill.dirName, file.path))
    const crc = crc32(content)
    const localHeader = localFileHeader({ fileName, crc, size: content.length })
    const centralHeader = centralDirectoryHeader({ fileName, crc, size: content.length, offset })
    localParts.push(localHeader, fileName, content)
    centralParts.push(centralHeader, fileName)
    offset += localHeader.length + fileName.length + content.length
    entryCount += 1
  }

  const centralDirectoryOffset = offset
  const centralDirectorySize = centralParts.reduce((total, part) => total + part.length, 0)
  return Buffer.concat([
    ...localParts,
    ...centralParts,
    endOfCentralDirectory({ entryCount, centralDirectorySize, centralDirectoryOffset }),
  ])
}

export async function getSkillArchive(name: string): Promise<SkillArchive | null> {
  const preview = await getSkillExportPreview(name)
  if (!preview) {
    return null
  }
  const files = await listPackageFiles(preview.skill.directory, 0)

  return {
    skill: preview.skill,
    archiveName: preview.archiveName,
    buffer: await buildZipBuffer(preview.skill, files),
  }
}

export async function deleteSkillPackage(name: string): Promise<SkillPackageDetail | null> {
  const skill = await getSkillPackageDetail(name)
  if (!skill) {
    return null
  }
  if (await isBundledAgentSkillPath(skill.directory)) {
    throw new ReadOnlySkillPackageError(skill.dirName)
  }

  await rm(skill.directory, { recursive: true, force: true })
  return skill
}

async function resolveManualSkillTargetRoot(): Promise<string> {
  const candidates = await resolveDirectSkillDirCandidates()
  const configured = candidates.find((candidate) => !candidate.source.startsWith('.'))
  const preferred = configured ?? candidates.find((candidate) => candidate.source === '.codex') ?? candidates[0]
  return preferred?.dir ?? path.join(homedir(), '.codex', 'skills')
}

function buildManualSkillMd(input: Required<CreateManualSkillInput>): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    'user-invocable: true',
    'argument-hint: <task>',
    `supported-providers: ${input.provider}`,
    '---',
    '',
    `# ${input.name}`,
    '',
    '## Purpose',
    '',
    input.description,
    '',
    '## Procedure',
    '',
    '1. Confirm the input and expected output with the operator.',
    '2. Run the documented workflow using the selected provider.',
    '3. Verify the produced artifact against the acceptance criteria.',
    '',
    '## Verification',
    '',
    'Run the package verification script or inspect the generated artifact before reporting completion.',
    '',
  ].join('\n')
}

export async function createManualSkillPackage(input: CreateManualSkillInput): Promise<SkillPackageDetail> {
  const slug = slugifySkillName(input.name)
  if (!slug) {
    throw new Error('name must produce a 2-63 character lowercase slug')
  }

  const normalized: Required<CreateManualSkillInput> = {
    name: slug,
    description: input.description.trim() || 'Describe this automation skill.',
    provider: input.provider.trim() || 'codex',
  }
  const root = await resolveManualSkillTargetRoot()
  const directory = path.join(root, slug)

  try {
    await stat(directory)
    throw new SkillPackageConflictError(`Skill "${slug}" already exists`)
  } catch (error) {
    if (error instanceof SkillPackageConflictError) {
      throw error
    }
  }

  await mkdir(directory, { recursive: true })
  await mkdir(path.join(directory, 'references'), { recursive: true })
  await mkdir(path.join(directory, 'scripts'), { recursive: true })
  await mkdir(path.join(directory, 'tests'), { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), buildManualSkillMd(normalized), 'utf8')
  await writeFile(path.join(directory, 'references', 'workflow.md'), '# Workflow\n\nDocument the workflow here.\n', 'utf8')
  await writeFile(path.join(directory, 'tests', 'case-1.json'), '{\n  "input": "",\n  "expected": ""\n}\n', 'utf8')

  const detail = await getSkillPackageDetail(slug)
  if (!detail) {
    throw new Error(`Created skill "${slug}" but discovery could not reload it`)
  }
  return detail
}
