import { describe, expect, it, vi } from 'vitest'
import { createHammurabiConfig } from '../config.js'
import { runMemoryCli } from '../memory.js'

interface BufferWriter {
  writer: { write: (chunk: string) => boolean }
  read: () => string
}

function createBufferWriter(): BufferWriter {
  let buffer = ''
  return {
    writer: {
      write(chunk: string): boolean {
        buffer += chunk
        return true
      },
    },
    read(): string {
      return buffer
    },
  }
}

const config = createHammurabiConfig({
  endpoint: 'https://hammurabi.gehirn.ai',
  apiKey: 'hmrb_test_key',
  agents: ['claude-code'],
  configuredAt: new Date('2026-03-01T00:00:00.000Z'),
})

describe('runMemoryCli', () => {
  it('prints usage when no subcommand is given', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMemoryCli([], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('Usage:')
    expect(stdout.read()).toContain('hambros memory compact')
    expect(stdout.read()).toContain('hambros memory find')
    expect(stdout.read()).toContain('hambros memory save')
    expect(stdout.read()).toContain('hambros memory export')
    expect(stdout.read()).toContain('hambros memory journal')
  })

  it('prints usage for unknown subcommand', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMemoryCli(['unknown'], {
      readConfig: async () => config,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stdout.read()).toContain('Usage:')
  })

  describe('compact', () => {
    it('posts to compact endpoint and prints consolidation report', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            factsExtracted: 3,
            memoryMdLineCount: 47,
            entriesCompressed: { spike: 1, notable: 2, routine: 5 },
            entriesDeleted: 0,
            debrifsProcessed: 1,
            idleDay: false,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(['compact', '--commander', 'cmdr-1'], {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      })

      expect(exitCode).toBe(0)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('Consolidation complete.')
      expect(stdout.read()).toContain('facts extracted: 3')
      expect(stdout.read()).toContain('MEMORY.md lines: 47')
      expect(stdout.read()).toContain('compressed: spike=1, notable=2, routine=5')
      expect(stdout.read()).toContain('deleted entries: 0')
      expect(stdout.read()).toContain('debriefs processed: 1')
      expect(stdout.read()).toContain('idle day: no')

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/memory/compact',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            authorization: 'Bearer hmrb_test_key',
            'content-type': 'application/json',
          }),
        }),
      )
    })

    it('prints usage when --commander is missing', async () => {
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(['compact'], {
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      })

      expect(exitCode).toBe(1)
      expect(stdout.read()).toContain('Usage:')
    })

    it('prints error on server failure', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Commander not found' }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(['compact', '--commander', 'cmdr-bad'], {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      })

      expect(exitCode).toBe(1)
      expect(stderr.read()).toContain('Request failed (404)')
      expect(stderr.read()).toContain('Commander not found')
    })
  })

  describe('find', () => {
    it('posts to recall endpoint and prints ranked hits', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            hits: [
              {
                type: 'journal',
                score: 0.923,
                title: 'Fixed Prisma migration drift on gfinance',
                excerpt: 'Applied manual SQL to realign...',
                reason: 'lexical 2.0, associative 1.5, rehearsed 3x',
              },
              {
                type: 'memory',
                score: 0.81,
                title: 'Prisma UserUpdateInput for String[] Fields',
                excerpt: 'For String[] fields, use { set: string[] }...',
                reason: 'lexical 1.5',
              },
            ],
            queryTerms: ['prisma', 'migration', 'schema'],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['find', '--commander', 'cmdr-1', 'prisma migration schema'],
        {
          fetchImpl,
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('Hits (2 found, query terms: prisma, migration, schema)')
      expect(stdout.read()).toContain('1. [journal]  0.923')
      expect(stdout.read()).toContain('Fixed Prisma migration drift')
      expect(stdout.read()).toContain('excerpt: "Applied manual SQL')
      expect(stdout.read()).toContain('2. [memory]   0.810')

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/memory/recall',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            authorization: 'Bearer hmrb_test_key',
            'content-type': 'application/json',
          }),
        }),
      )

      const sentBody = JSON.parse(
        (fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body as string,
      )
      expect(sentBody).toEqual({ cue: 'prisma migration schema' })
    })

    it('passes --top option as topK', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ hits: [], queryTerms: [] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['find', '--commander', 'cmdr-1', '--top', '3', 'prisma'],
        {
          fetchImpl,
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      const sentBody = JSON.parse(
        (fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body as string,
      )
      expect(sentBody).toEqual({ cue: 'prisma', topK: 3 })
    })

    it('runs semantic search when --semantic is passed and merges both result sections', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            hits: [
              {
                type: 'memory',
                score: 0.81,
                title: 'Prisma UserUpdateInput for String[] Fields',
                excerpt: 'For String[] fields, use { set: string[] }...',
                reason: 'lexical 1.5',
              },
            ],
            queryTerms: ['agent', 'memory'],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const runSemanticSearch = vi.fn(async () => ([
        {
          score: 0.872,
          text: 'Agent memory architecture uses a knowledge cache plus cue-based recall.',
          source_file: '/home/ec2-user/.ginsights/domains/agentic-ai/knowledge/agent-fleet-operations.md',
          section_header: 'Agent Memory Architecture',
          chunk_index: 0,
        },
      ]))
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['find', '--commander', 'cmdr-1', '--top', '3', '--semantic', 'agent memory'],
        {
          fetchImpl,
          readConfig: async () => config,
          runSemanticSearch,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('=== Commander Memory (cue-based recall) ===')
      expect(stdout.read()).toContain('Hits (1 found, query terms: agent, memory)')
      expect(stdout.read()).toContain('=== Knowledge Index (semantic search) ===')
      expect(stdout.read()).toContain('1. [87.2%] Agent Memory Architecture')
      expect(stdout.read()).toContain('Source: ~/.ginsights/domains/agentic-ai/knowledge/agent-fleet-operations.md')

      expect(runSemanticSearch).toHaveBeenCalledWith('agent memory', 3)
    })

    it('warns and keeps lexical results when semantic search cannot run', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            hits: [],
            queryTerms: ['agent', 'memory'],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const runSemanticSearch = vi.fn(async () => {
        throw new Error('GEMINI_API_KEY not found')
      })
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['find', '--commander', 'cmdr-1', '--semantic', 'agent memory'],
        {
          fetchImpl,
          readConfig: async () => config,
          runSemanticSearch,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      expect(stdout.read()).toContain('=== Commander Memory (cue-based recall) ===')
      expect(stdout.read()).not.toContain('=== Knowledge Index (semantic search) ===')
      expect(stderr.read()).toContain('Warning: semantic search skipped: GEMINI_API_KEY not found')
    })

    it('prints usage when query is missing', async () => {
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['find', '--commander', 'cmdr-1'],
        {
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(1)
      expect(stdout.read()).toContain('Usage:')
    })
  })

  describe('save', () => {
    it('posts facts to facts endpoint and prints confirmation', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            factsAdded: 2,
            lineCount: 47,
            evicted: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['save', '--commander', 'cmdr-1', 'Prisma needs set for arrays', '--fact', 'Always use pnpm'],
        {
          fetchImpl,
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('Saved 2 facts to MEMORY.md (47 total lines, 0 evicted).')

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/memory/facts',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            authorization: 'Bearer hmrb_test_key',
            'content-type': 'application/json',
          }),
        }),
      )

      const sentBody = JSON.parse(
        (fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body as string,
      )
      expect(sentBody).toEqual({
        facts: ['Prisma needs set for arrays', 'Always use pnpm'],
      })
    })

    it('prints usage when no facts are provided', async () => {
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['save', '--commander', 'cmdr-1'],
        {
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(1)
      expect(stdout.read()).toContain('Usage:')
    })

    it('prints error on server failure', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Failed to save facts' }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        ['save', '--commander', 'cmdr-1', 'some fact'],
        {
          fetchImpl,
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(1)
      expect(stderr.read()).toContain('Request failed (500)')
    })
  })

  describe('export', () => {
    it('gets memory export payload and prints json', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            memoryMd: '# Commander Memory\n\n- Fact',
            journal: { '2026-03-12': '## 2026-03-12\n- Entry' },
            repos: { 'NickGuAI/monorepo-g/README.md': 'readme' },
            skills: { 'hammurabi/skill.md': 'content' },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(['export', '--commander', 'cmdr-1'], {
        fetchImpl,
        readConfig: async () => config,
        stdout: stdout.writer,
        stderr: stderr.writer,
      })

      expect(exitCode).toBe(0)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('"memoryMd": "# Commander Memory')
      expect(stdout.read()).toContain('"journal"')

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/memory/export',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            authorization: 'Bearer hmrb_test_key',
          }),
        }),
      )
    })
  })

  describe('journal', () => {
    it('posts manual journal entry to journal endpoint', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ date: '2026-03-15', added: 1, skipped: 0 }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      const stdout = createBufferWriter()
      const stderr = createBufferWriter()

      const exitCode = await runMemoryCli(
        [
          'journal',
          '--commander',
          'cmdr-1',
          '--body',
          'Closed quest and validated behavior.',
          '--timestamp',
          '2026-03-15T10:20:30.000Z',
          '--outcome',
          'Closed issue #544 parity gap',
          '--salience',
          'SPIKE',
          '--issue-number',
          '544',
          '--repo',
          'NickGuAI/monorepo-g',
          '--duration-min',
          '25',
        ],
        {
          fetchImpl,
          readConfig: async () => config,
          stdout: stdout.writer,
          stderr: stderr.writer,
        },
      )

      expect(exitCode).toBe(0)
      expect(stderr.read()).toBe('')
      expect(stdout.read()).toContain('Journal entry appended for 2026-03-15.')

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://hammurabi.gehirn.ai/api/commanders/cmdr-1/memory/journal',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            authorization: 'Bearer hmrb_test_key',
            'content-type': 'application/json',
          }),
        }),
      )

      const sentBody = JSON.parse(
        (fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body as string,
      )
      expect(sentBody).toEqual({
        date: '2026-03-15',
        entries: [
          {
            timestamp: '2026-03-15T10:20:30.000Z',
            issueNumber: 544,
            repo: 'NickGuAI/monorepo-g',
            outcome: 'Closed issue #544 parity gap',
            durationMin: 25,
            salience: 'SPIKE',
            body: 'Closed quest and validated behavior.',
          },
        ],
      })
    })
  })

  it('reports missing config', async () => {
    const stdout = createBufferWriter()
    const stderr = createBufferWriter()

    const exitCode = await runMemoryCli(['compact', '--commander', 'cmdr-1'], {
      readConfig: async () => null,
      stdout: stdout.writer,
      stderr: stderr.writer,
    })

    expect(exitCode).toBe(1)
    expect(stderr.read()).toContain('HamBros config not found')
  })
})
