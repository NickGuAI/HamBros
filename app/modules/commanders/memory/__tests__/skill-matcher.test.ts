import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSkillManifests,
  matchSkill,
  parseSkillManifest,
  rankMatchingSkills,
  type GHIssue,
} from '../skill-matcher.js'

describe('parseSkillManifest()', () => {
  it('parses auto-match arrays from inline frontmatter', () => {
    const content = `---
name: auth-token-fix
auto-match:
  labels: [bug, auth, authentication]
  keywords: [token, refresh, cert]
---
# Fix auth token refresh
`
    const parsed = parseSkillManifest(content, '/tmp/skills/auth-token-fix/SKILL.md')
    expect(parsed.name).toBe('auth-token-fix')
    expect(parsed.autoMatch.labels).toEqual(['bug', 'auth', 'authentication'])
    expect(parsed.autoMatch.keywords).toEqual(['token', 'refresh', 'cert'])
  })

  it('parses block-list auto-match fields', () => {
    const content = `---
auto-match:
  labels:
    - bug
    - websocket
  keywords:
    - race condition
    - reconnect
---
# WS handler guide
`
    const parsed = parseSkillManifest(content, '/tmp/skills/ws-race/SKILL.md')
    expect(parsed.name).toBe('ws-race')
    expect(parsed.autoMatch.labels).toEqual(['bug', 'websocket'])
    expect(parsed.autoMatch.keywords).toEqual(['race condition', 'reconnect'])
  })
})

describe('matchSkill()', () => {
  const task: GHIssue = {
    number: 247,
    title: 'Fix auth token refresh flow',
    body: 'Refresh tokens fail when certificate chain rotates unexpectedly.',
    labels: [{ name: 'bug' }],
    owner: 'example-user',
    repo: 'example-repo',
  }

  it('matches on labels', () => {
    const skill = parseSkillManifest(
      `---
name: label-skill
auto-match:
  labels: [bug]
  keywords: []
---
Label skill content`,
      '/tmp/skills/label-skill/SKILL.md',
    )
    expect(matchSkill(skill, task)).toBe(true)
  })

  it('matches on keywords', () => {
    const skill = parseSkillManifest(
      `---
name: keyword-skill
auto-match:
  labels: [infra]
  keywords: [certificate]
---
Keyword skill content`,
      '/tmp/skills/keyword-skill/SKILL.md',
    )
    expect(matchSkill(skill, task)).toBe(true)
  })

  it('does not match when neither labels nor keywords match', () => {
    const skill = parseSkillManifest(
      `---
name: no-match
auto-match:
  labels: [frontend]
  keywords: [css]
---
No match skill content`,
      '/tmp/skills/no-match/SKILL.md',
    )
    expect(matchSkill(skill, task)).toBe(false)
  })
})

describe('rankMatchingSkills()', () => {
  const task: GHIssue = {
    number: 11,
    title: 'Fix token refresh race',
    body: 'Refresh token and cert validation race condition in auth middleware.',
    labels: [{ name: 'bug' }],
    owner: 'example-user',
    repo: 'example-repo',
  }

  it('sorts by strongest match score', () => {
    const weak = parseSkillManifest(
      `---
name: weak
auto-match:
  labels: [infra]
  keywords: [token]
---
weak`,
      '/tmp/skills/weak/SKILL.md',
    )
    const strong = parseSkillManifest(
      `---
name: strong
auto-match:
  labels: [bug]
  keywords: [token, refresh, cert]
---
strong`,
      '/tmp/skills/strong/SKILL.md',
    )

    const ranked = rankMatchingSkills([weak, strong], task)
    expect(ranked.map((s) => s.name)).toEqual(['strong', 'weak'])
  })
})

describe('loadSkillManifests()', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'skill-matcher-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('loads SKILL.md files from child directories', async () => {
    const skillDir = join(tmpDir, 'auth-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: auth-skill
auto-match:
  labels: [auth]
  keywords: [token]
---
skill body`,
      'utf-8',
    )

    const skills = await loadSkillManifests(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('auth-skill')
  })
})
