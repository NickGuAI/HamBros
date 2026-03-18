import { describe, expect, it, vi } from 'vitest'
import {
  COMMANDER_FULL_SYNC_CRON,
  COMMANDER_MEMORY_ONLY_SYNC_CRON,
  MORNING_BRIEFING_CRON,
  MICRO_RESET_CRON,
  NIGHTLY_CONSOLIDATION_CRON,
  registerCommanderCron,
} from '../cron.js'
import { CommanderSessionStore } from '../store.js'

describe('registerCommanderCron()', () => {
  it('registers only commander nightly consolidation at 02:00', () => {
    const schedule = vi.fn()
    const consolidation = registerCommanderCron(
      { schedule },
      { commanderIdsForCron: ['commander-1'] },
    )
    // nightly consolidation + morning briefing + micro reset
    expect(schedule).toHaveBeenCalledTimes(3)
    const expressions = schedule.mock.calls.map((call) => call[0])
    expect(expressions).toContain(NIGHTLY_CONSOLIDATION_CRON)
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
      { commanderIdsForCron },
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

    const consolidation = registerCommanderCron({ schedule })
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

    // nightly consolidation + memory-only sync + full sync + morning briefing + micro reset
    expect(schedule).toHaveBeenCalledTimes(5)

    const expressions = schedule.mock.calls.map((call) => call[0])
    expect(expressions).toEqual(
      expect.arrayContaining([
        NIGHTLY_CONSOLIDATION_CRON,
        COMMANDER_MEMORY_ONLY_SYNC_CRON,
        COMMANDER_FULL_SYNC_CRON,
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
})
