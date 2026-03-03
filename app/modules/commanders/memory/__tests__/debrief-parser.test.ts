import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DebriefParser } from '../debrief-parser.js'

describe('DebriefParser.parseForDate()', () => {
  let dir: string
  const parser = new DebriefParser()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'debrief-parser-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('parses hotwash and AAR style files for a date', async () => {
    await writeFile(
      join(dir, '2026-03-01-hotwash-auth.md'),
      `# HOTWASH: Auth Incident
Session Topic: Auth token expiry

## DOCTRINE UPDATES
- Always validate token audience and issuer.

## SUSTAIN
- Keep focused reproductions.

## IMPROVE
- Root cause: Missing audience env in staging.
- Why chain -> no startup validation.

## EVAL UPDATES
- Added startup env assertion test.

## RISKS
- Future key rotation outage.
`,
      'utf-8',
    )

    await writeFile(
      join(dir, '2026-03-01-aar-cache.md'),
      `# AAR: Cache Latency

### Doctrine Updates
- Prefer mtimeMs for file change checks.

### Improve
- Root Cause: Rounded mtime precision caused false changes.

### Eval Updates
- Added regression around stable scans.
`,
      'utf-8',
    )

    const parsed = await parser.parseForDate('2026-03-01', dir)
    expect(parsed).toHaveLength(2)

    const doctrine = parsed.flatMap((item) => item.doctrineUpdates)
    expect(doctrine).toContain('Always validate token audience and issuer.')
    expect(doctrine).toContain('Prefer mtimeMs for file change checks.')

    const sustain = parsed.flatMap((item) => item.sustainPatterns)
    expect(sustain).toContain('Keep focused reproductions.')

    const improve = parsed.flatMap((item) => item.improveRootCauses)
    expect(improve).toContain('Missing audience env in staging.')
    expect(improve).toContain('no startup validation.')

    const evals = parsed.flatMap((item) => item.evalCases)
    expect(evals).toContain('Added startup env assertion test.')
    expect(evals).toContain('Added regression around stable scans.')
  })

  it('returns empty when directory does not exist', async () => {
    const missing = join(tmpdir(), `missing-${Date.now()}-${Math.random()}`)
    await expect(parser.parseForDate('2026-03-01', missing)).resolves.toEqual([])
  })

  it('parses bold section labels and extracts deepest improve cause-chain root cause', async () => {
    await writeFile(
      join(dir, '2026-03-01-aar-style.md'),
      `# AAR: Reliability

- **SUSTAIN:**
  - Kept rollback instructions up to date.

- **IMPROVE:**
  - We saw request storms because retries piled up; retries piled up was enabled by missing circuit breaker.

- **DOCTRINE UPDATES:**
  - Gate deploys on canary health.

- **EVAL UPDATES:**
  - Add regression load test for retry storms.

- **RISKS:**
  - Circuit-breaker thresholds are still not tuned.
`,
      'utf-8',
    )

    const parsed = await parser.parseForDate('2026-03-01', dir)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].sustainPatterns).toContain('Kept rollback instructions up to date.')
    expect(parsed[0].doctrineUpdates).toContain('Gate deploys on canary health.')
    expect(parsed[0].evalCases).toContain('Add regression load test for retry storms.')
    expect(parsed[0].risks).toContain('Circuit-breaker thresholds are still not tuned.')
    expect(parsed[0].improveRootCauses).toContain('missing circuit breaker')
  })
})
