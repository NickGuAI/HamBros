import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  resolveCommanderDataDir,
  resolveCommanderEmailConfigPath,
  resolveCommanderEmailSeenPath,
  resolveCommanderMachineId,
  resolveCommanderNamesPath,
  resolveCommanderPaths,
  resolveCommanderSessionStorePath,
} from '../paths.js'

describe('commander paths', () => {
  it('prefers COMMANDER_DATA_DIR over legacy env var', () => {
    const resolved = resolveCommanderDataDir({
      COMMANDER_DATA_DIR: '/tmp/new-root',
      HAMBROS_COMMANDER_MEMORY_DIR: '/tmp/legacy-root',
    } as NodeJS.ProcessEnv)

    expect(resolved).toBe(path.resolve('/tmp/new-root'))
  })

  it('falls back to legacy env var when COMMANDER_DATA_DIR is unset', () => {
    const resolved = resolveCommanderDataDir({
      HAMBROS_COMMANDER_MEMORY_DIR: '/tmp/legacy-root',
    } as NodeJS.ProcessEnv)

    expect(resolved).toBe(path.resolve('/tmp/legacy-root'))
  })

  it('builds commander-specific memory and skills paths', () => {
    const paths = resolveCommanderPaths('cmdr-1', '/tmp/cmdr-data')

    expect(paths.dataDir).toBe(path.resolve('/tmp/cmdr-data'))
    expect(paths.commanderRoot).toBe(path.resolve('/tmp/cmdr-data/cmdr-1'))
    expect(paths.memoryRoot).toBe(path.resolve('/tmp/cmdr-data/cmdr-1/.memory'))
    expect(paths.skillsRoot).toBe(path.resolve('/tmp/cmdr-data/cmdr-1/skills'))
    expect(resolveCommanderSessionStorePath('/tmp/cmdr-data')).toBe(
      path.resolve('/tmp/cmdr-data/sessions.json'),
    )
    expect(resolveCommanderNamesPath('/tmp/cmdr-data')).toBe(
      path.resolve('/tmp/cmdr-data/names.json'),
    )
    expect(resolveCommanderEmailConfigPath('cmdr-1', '/tmp/cmdr-data')).toBe(
      path.resolve('/tmp/cmdr-data/cmdr-1/email-config.json'),
    )
    expect(resolveCommanderEmailSeenPath('cmdr-1', '/tmp/cmdr-data')).toBe(
      path.resolve('/tmp/cmdr-data/cmdr-1/email-seen.json'),
    )
  })

  it('sanitizes machine id for S3 prefix usage', () => {
    const machineId = resolveCommanderMachineId({
      COMMANDER_MACHINE_ID: 'Athena Main/Prod',
    } as NodeJS.ProcessEnv)

    expect(machineId).toBe('athena-main-prod')
  })
})
