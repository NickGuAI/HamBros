import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OpenAITranscriptionKeyStore } from '../transcription-store'

const testDirectories: string[] = []

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hammurabi-transcription-store-'))
  testDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('OpenAITranscriptionKeyStore', () => {
  it('stores and retrieves an encrypted key', async () => {
    const directory = await createTempDirectory()
    const filePath = path.join(directory, 'transcription-secrets.json')
    const keyFilePath = path.join(directory, 'transcription-secrets.key')
    const store = new OpenAITranscriptionKeyStore({
      filePath,
      keyFilePath,
      encryptionKey: 'test-secret',
    })

    expect(await store.getStatus()).toEqual({
      configured: false,
      updatedAt: null,
    })

    const createdAt = new Date('2026-02-28T02:20:00.000Z')
    await store.setOpenAIApiKey('sk-test-openai-key', { now: createdAt })

    expect(await store.getOpenAIApiKey()).toBe('sk-test-openai-key')
    expect(await store.getStatus()).toEqual({
      configured: true,
      updatedAt: createdAt.toISOString(),
    })

    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('sk-test-openai-key')
    expect(persisted).toContain('ciphertext')
  })

  it('clears the configured key', async () => {
    const directory = await createTempDirectory()
    const store = new OpenAITranscriptionKeyStore({
      filePath: path.join(directory, 'transcription-secrets.json'),
      keyFilePath: path.join(directory, 'transcription-secrets.key'),
      encryptionKey: 'test-secret',
    })

    await store.setOpenAIApiKey('sk-key-to-clear')
    expect(await store.clearOpenAIApiKey()).toBe(true)
    expect(await store.getOpenAIApiKey()).toBeNull()
    expect(await store.getStatus()).toEqual({
      configured: false,
      updatedAt: null,
    })
    expect(await store.clearOpenAIApiKey()).toBe(false)
  })

  it('generates and persists a local encryption key file when no env key is configured', async () => {
    const directory = await createTempDirectory()
    const keyFilePath = path.join(directory, 'transcription-secrets.key')
    const store = new OpenAITranscriptionKeyStore({
      filePath: path.join(directory, 'transcription-secrets.json'),
      keyFilePath,
      envKeyName: 'UNSET_TRANSCRIPTION_ENCRYPTION_KEY_FOR_TEST',
    })

    await store.setOpenAIApiKey('sk-generated-file-key')
    const persistedKey = (await readFile(keyFilePath, 'utf8')).trim()
    const decoded = Buffer.from(persistedKey, 'base64')
    expect(decoded).toHaveLength(32)
    expect(await store.getOpenAIApiKey()).toBe('sk-generated-file-key')
  })
})
