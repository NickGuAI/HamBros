import { describe, expect, it, vi } from 'vitest'
import { registerCommanderCron } from '../cron.js'

describe('registerCommanderCron()', () => {
  it('registers nightly consolidation at 02:00', () => {
    const schedule = vi.fn()
    const consolidation = registerCommanderCron(
      { schedule },
      { commanderIdsForCron: ['commander-1'] },
    )
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][0]).toBe('0 2 * * *')
    expect(typeof schedule.mock.calls[0][1]).toBe('function')
    expect(consolidation).toBeDefined()
  })
})
