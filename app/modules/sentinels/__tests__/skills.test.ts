import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

vi.mock('node:os', () => ({
  homedir: () => '/home/tester',
}))

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}))

import * as fs from 'node:fs/promises'
import { resolveSkill, resolveSkills, stripYamlFrontmatter } from '../skills.js'

const accessMock = vi.mocked(fs.access)
const readFileMock = vi.mocked(fs.readFile)
const readdirMock = vi.mocked(fs.readdir)

function createErrno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

function dirEntry(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => true }
}

describe('sentinel skill resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: agent-skills contains general-skills, gehirn-skills, pkos
    readdirMock.mockResolvedValue([
      dirEntry('general-skills'),
      dirEntry('gehirn-skills'),
      dirEntry('pkos'),
    ] as never)
  })

  it('resolves commander-local skills before global and repo paths', async () => {
    const commanderSkillsDir = '/tmp/commanders/cmd-1/skills'
    const localPath = path.join(commanderSkillsDir, 'gog', 'SKILL.md')

    accessMock.mockImplementation(async (candidate) => {
      if (candidate === localPath) {
        return
      }
      throw createErrno('ENOENT')
    })
    readFileMock.mockResolvedValue('---\nname: gog\n---\nLocal skill body')

    const result = await resolveSkill('gog', commanderSkillsDir)

    expect(result).toBe('Local skill body')
    expect(accessMock.mock.calls[0]?.[0]).toBe(localPath)
    expect(readFileMock).toHaveBeenCalledWith(localPath, 'utf8')
  })

  it('uses the first matching path (global before repo)', async () => {
    const globalPath = '/home/tester/.claude/skills/write-report/SKILL.md'
    const repoPath = '/home/tester/App/agent-skills/general-skills/write-report/SKILL.md'

    accessMock.mockImplementation(async (candidate) => {
      if (candidate === globalPath) {
        return
      }
      throw createErrno('ENOENT')
    })
    readFileMock.mockResolvedValue('Global body')

    const result = await resolveSkill('write-report')

    expect(result).toBe('Global body')
    expect(accessMock).toHaveBeenCalledWith(globalPath)
    expect(accessMock).not.toHaveBeenCalledWith(repoPath)
    expect(readFileMock).toHaveBeenCalledWith(globalPath, 'utf8')
  })

  it('strips YAML frontmatter from SKILL.md content', () => {
    const content = [
      '---',
      'name: write-email',
      'description: email helper',
      '---',
      '# Write Email',
      '',
      'Use this skill when writing external email updates.',
      '',
    ].join('\n')

    const stripped = stripYamlFrontmatter(content)

    expect(stripped).toBe('# Write Email\n\nUse this skill when writing external email updates.')
  })

  it('rejects invalid skill names', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await resolveSkill('../evil')

    expect(result).toBeNull()
    expect(accessMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid skill name'))
  })

  it('returns null and logs warning when a skill is missing', async () => {
    accessMock.mockRejectedValue(createErrno('ENOENT'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await resolveSkill('missing-skill')

    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('[sentinels] Skill not found: missing-skill')
  })

  it('resolveSkills returns only found skills as a map', async () => {
    const alphaPath = '/home/tester/.claude/skills/alpha/SKILL.md'
    const betaPath = '/home/tester/App/agent-skills/pkos/beta/SKILL.md'

    accessMock.mockImplementation(async (candidate) => {
      if (candidate === alphaPath || candidate === betaPath) {
        return
      }
      throw createErrno('ENOENT')
    })

    readFileMock.mockImplementation(async (candidate) => {
      if (candidate === alphaPath) {
        return '---\nname: alpha\n---\nAlpha body'
      }
      if (candidate === betaPath) {
        return 'Beta body'
      }
      throw createErrno('ENOENT')
    })

    const result = await resolveSkills(['alpha', 'missing', 'beta', 'alpha'])

    expect([...result.keys()]).toEqual(['alpha', 'beta'])
    expect(result.get('alpha')).toBe('Alpha body')
    expect(result.get('beta')).toBe('Beta body')
  })
})
