/**
 * One-time seed script: writes human-readable display names for known commanders
 * into names.json. Existing entries for these commander IDs are overwritten;
 * entries for other commanders are preserved.
 *
 * Usage:
 *   npx tsx apps/hammurabi/scripts/seed-commander-names.ts
 *
 * Respects COMMANDER_DATA_DIR env var (falls back to data/commanders).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const KNOWN_COMMANDERS: Record<string, string> = {
  '5fab87d0-1348-44de-b1f0-4c9cf33383e7': 'Jarvis',
  'd66a5217-ace6-4f00-b2ac-bbd64a9a7e7e': 'Athena',
  'df5eb54a-8b36-41d1-9164-300d11e6da79': 'Jake',
}

async function main(): Promise<void> {
  const dataDir = process.env.COMMANDER_DATA_DIR
    ?? process.env.HAMMURABI_COMMANDER_MEMORY_DIR
    ?? path.resolve(process.cwd(), 'data/commanders')

  const namesPath = path.join(path.resolve(dataDir), 'names.json')

  let names: Record<string, string> = {}
  try {
    names = JSON.parse(await readFile(namesPath, 'utf8')) as Record<string, string>
  } catch {
    // names.json may not exist yet
  }

  let updated = 0
  for (const [id, displayName] of Object.entries(KNOWN_COMMANDERS)) {
    if (names[id] !== displayName) {
      names[id] = displayName
      updated++
    }
  }

  if (updated === 0) {
    console.log('All known commander names are already up to date.')
    return
  }

  await mkdir(path.dirname(namesPath), { recursive: true })
  await writeFile(namesPath, JSON.stringify(names, null, 2), 'utf8')
  console.log(`Seeded ${updated} commander name(s) in ${namesPath}`)
}

main().catch((err) => {
  console.error('Failed to seed commander names:', err)
  process.exitCode = 1
})
