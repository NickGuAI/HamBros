import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function seedMemoryFile(
  sentinelDir: string,
  name: string,
  seedContent: string,
): Promise<string> {
  await mkdir(sentinelDir, { recursive: true })
  await mkdir(path.join(sentinelDir, 'runs'), { recursive: true })
  await mkdir(path.join(sentinelDir, 'artifacts'), { recursive: true })

  const memoryPath = path.join(sentinelDir, 'memory.md')
  const content = [
    `# Sentinel Memory: ${name}`,
    '',
    '## Seed Context',
    seedContent || '(No seed context provided)',
    '',
    '## Learned Facts',
    '<!-- Updated by the sentinel across runs. Add new discoveries below. -->',
    '',
    '## Status Notes',
    '<!-- Track evolving state of the task here. -->',
    '',
  ].join('\n')

  await writeFile(memoryPath, content, 'utf8')
  return memoryPath
}
