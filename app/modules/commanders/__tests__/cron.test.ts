import { describe, expect, it, vi } from 'vitest'
import {
  COMMANDER_EMAIL_POLL_CRON,
  COMMANDER_FULL_SYNC_CRON,
  COMMANDER_MEMORY_ONLY_SYNC_CRON,
  COMMANDER_TRANSCRIPT_MAINTENANCE_CRON,
  MORNING_BRIEFING_CRON,
  MICRO_RESET_CRON,
  NIGHTLY_CONSOLIDATION_CRON,
  registerCommanderCron,
} from '../cron.js'
import { CommanderSessionStore } from '../store.js'

describe('registerCommanderCron()', () => {
  it('does not register hidden nightly consolidation by default', () => {
    const schedule = vi.fn()
    const consolidation = registerCommanderCron(
      { schedule },
      { commanderIdsForCron: ['commander-1'] },
    )
    // transcript maintenance + morning briefing + micro reset
    expect(schedule).toHaveBeenCalledTimes(3)
    const expressions = schedule.mock.calls.map((call) => call[0])
    expect(expressions).not.toContain(NIGHTLY_CONSOLIDATION_CRON)
    expect(expressions).toContain(COMMANDER_TRANSCRIPT_MAINTENANCE_CRON)
    expect(typeof schedule.mock.calls[0][1]).toBe('function')
    expect(consolidation).toBeDefined()
  })

  it('resolves commander ids from the latest nightly list at execution time', async () => {
    let nightlyJob: (() => Promise<void> | void) | null = null
    const schedule = vi.fn((expression: string, task: () => Promise<void> | void) => {
      if (expression === NIGHTLY_CONSOLIDATION_CRON) {
        nightlyJob = task
      }
    })

    const commanderIdsForCron = ['commander-initial']
    const consolidation = registerCommanderCron(
      { schedule },
      {
        commanderIdsForCron,
        enableNightlyConsolidation: true,
      },
    )

    const runSpy = vi.spyOn(consolidation, 'run').mockResolvedValue({
      factsExtracted: 0,
      memoryMdLineCount: 0,
      entriesCompressed: { spike: 0, notable: 0, routine: 0 },
      entriesDeleted: 0,
      debrifsProcessed: 0,
    })

    commanderIdsForCron.splice(0, commanderIdsForCron.length, 'commander-a', 'commander-b')

    if (!nightlyJob) {
      throw new Error('nightly consolidation job was not registered')
    }
    await nightlyJob()

    expect(runSpy).toHaveBeenCalledTimes(2)
    expect(runSpy).toHaveBeenNthCalledWith(1, 'commander-a')
    expect(runSpy).toHaveBeenNthCalledWith(2, 'commander-b')

    commanderIdsForCron.splice(0, commanderIdsForCron.length, 'commander-c')
    await nightlyJob()

    expect(runSpy).toHaveBeenCalledTimes(3)
    expect(runSpy).toHaveBeenNthCalledWith(3, 'commander-c')
  })

  it('uses CommanderSessionStore list at cron runtime when ids are not provided', async () => {
    let nightlyJob: (() => Promise<void> | void) | null = null
    const schedule = vi.fn((expression: string, task: () => Promise<void> | void) => {
      if (expression === NIGHTLY_CONSOLIDATION_CRON) {
        nightlyJob = task
      }
    })

    const listSpy = vi.spyOn(CommanderSessionStore.prototype, 'list')
      .mockResolvedValueOnce([
        { id: 'commander-101' } as never,
        { id: 'commander-102' } as never,
      ])
      .mockResolvedValueOnce([
        { id: 'commander-201' } as never,
      ])

    const consolidation = registerCommanderCron({
      schedule,
    }, {
      enableNightlyConsolidation: true,
    })
    const runSpy = vi.spyOn(consolidation, 'run').mockResolvedValue({
      factsExtracted: 0,
      memoryMdLineCount: 0,
      entriesCompressed: { spike: 0, notable: 0, routine: 0 },
      entriesDeleted: 0,
      debrifsProcessed: 0,
    })

    if (!nightlyJob) {
      throw new Error('nightly consolidation job was not registered')
    }

    await nightlyJob()
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(runSpy).toHaveBeenCalledTimes(2)
    expect(runSpy).toHaveBeenNthCalledWith(1, 'commander-101')
    expect(runSpy).toHaveBeenNthCalledWith(2, 'commander-102')

    await nightlyJob()
    expect(listSpy).toHaveBeenCalledTimes(2)
    expect(runSpy).toHaveBeenCalledTimes(3)
    expect(runSpy).toHaveBeenNthCalledWith(3, 'commander-201')
  })

  it('registers memory-only and full S3 sync jobs when sync is enabled', async () => {
    const schedule = vi.fn()
    const syncRunner = vi.fn(async () => {})

    registerCommanderCron(
      { schedule },
      {
        commanderIdsForCron: ['commander-1'],
        enableS3Sync: true,
        memorySyncRunner: syncRunner,
      },
    )

    // memory-only sync + full sync + transcript maintenance + morning briefing + micro reset
    expect(schedule).toHaveBeenCalledTimes(5)

    const expressions = schedule.mock.calls.map((call) => call[0])
    expect(expressions).toEqual(
      expect.arrayContaining([
        COMMANDER_MEMORY_ONLY_SYNC_CRON,
        COMMANDER_FULL_SYNC_CRON,
        COMMANDER_TRANSCRIPT_MAINTENANCE_CRON,
        MORNING_BRIEFING_CRON,
        MICRO_RESET_CRON,
      ]),
    )

    const memoryJob = schedule.mock.calls.find(
      (call) => call[0] === COMMANDER_MEMORY_ONLY_SYNC_CRON,
    )?.[1]
    const fullJob = schedule.mock.calls.find(
      (call) => call[0] === COMMANDER_FULL_SYNC_CRON,
    )?.[1]
    if (!memoryJob || !fullJob) {
      throw new Error('sync jobs were not registered')
    }

    await memoryJob()
    await fullJob()

    expect(syncRunner).toHaveBeenNthCalledWith(1, 'memory')
    expect(syncRunner).toHaveBeenNthCalledWith(2, 'full')
  })

  it('runs transcript maintenance for each commander at the maintenance cron', async () => {
    let transcriptJob: (() => Promise<void> | void) | null = null
    const schedule = vi.fn((expression: string, task: () => Promise<void> | void) => {
      if (expression === COMMANDER_TRANSCRIPT_MAINTENANCE_CRON) {
        transcriptJob = task
      }
    })
    const transcriptMaintenanceRunner = vi.fn(async () => {})

    registerCommanderCron(
      { schedule },
      {
        commanderIdsForCron: ['commander-a', 'commander-b'],
        transcriptMaintenanceRunner,
      },
    )

    if (!transcriptJob) {
      throw new Error('transcript maintenance job was not registered')
    }

    await transcriptJob()

    expect(transcriptMaintenanceRunner).toHaveBeenCalledTimes(2)
    expect(transcriptMaintenanceRunner).toHaveBeenNthCalledWith(1, 'commander-a')
    expect(transcriptMaintenanceRunner).toHaveBeenNthCalledWith(2, 'commander-b')
  })

  it('registers commander email polling when enabled', async () => {
    const schedule = vi.fn()
    const emailPoller = {
      pollAll: vi.fn(async () => undefined),
    }

    registerCommanderCron(
      { schedule },
      {
        commanderIdsForCron: ['commander-1'],
        enableEmailPoll: true,
        emailPoller,
      },
    )

    const pollJob = schedule.mock.calls.find(
      (call) => call[0] === COMMANDER_EMAIL_POLL_CRON,
    )?.[1]
    expect(typeof pollJob).toBe('function')

    if (!pollJob) {
      throw new Error('email poll job was not registered')
    }

    await pollJob()
    expect(emailPoller.pollAll).toHaveBeenCalledTimes(1)
  })

  it('does not start overlapping commander email polls', async () => {
    const schedule = vi.fn()
    let resolveFirstPoll: (() => void) | null = null
    const firstPoll = new Promise<void>((resolve) => {
      resolveFirstPoll = resolve
    })
    const emailPoller = {
      pollAll: vi.fn(() => firstPoll),
    }

    registerCommanderCron(
      { schedule },
      {
        commanderIdsForCron: ['commander-1'],
        enableEmailPoll: true,
        emailPoller,
      },
    )

    const pollJob = schedule.mock.calls.find(
      (call) => call[0] === COMMANDER_EMAIL_POLL_CRON,
    )?.[1]
    if (!pollJob) {
      throw new Error('email poll job was not registered')
    }

    pollJob()
    pollJob()
    expect(emailPoller.pollAll).toHaveBeenCalledTimes(1)

    if (!resolveFirstPoll) {
      throw new Error('first poll promise was not created')
    }
    resolveFirstPoll()
    await firstPoll
    await Promise.resolve()

    pollJob()
    expect(emailPoller.pollAll).toHaveBeenCalledTimes(2)
  })
})
