import { EventEmitter } from 'node:events'
import WebSocket, { type RawData } from 'ws'
import { LIVE_TRANSCRIPTION_PROMPT } from './prompts.js'

const DEFAULT_MODEL = 'gpt-4o-transcribe'
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'

interface OpenAIRealtimeClientOptions {
  apiKey: string
  model?: string
  language?: string
  prompt?: string
}

interface OpenAIRealtimeServerEvent {
  type?: unknown
  delta?: unknown
  transcript?: unknown
  text?: unknown
  error?: {
    message?: unknown
  }
  message?: unknown
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function isLikelyLanguageCode(value: string): boolean {
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value)
}

export class OpenAIRealtimeClient extends EventEmitter {
  private readonly apiKey: string
  private readonly model: string
  private readonly prompt: string
  private readonly language: string
  private ws: WebSocket | null = null
  private connected = false
  private closed = false

  constructor(options: OpenAIRealtimeClientOptions) {
    super()
    this.apiKey = options.apiKey.trim()
    this.model = options.model?.trim() || DEFAULT_MODEL
    this.prompt = options.prompt?.trim() || LIVE_TRANSCRIPTION_PROMPT

    const normalizedLanguage = options.language?.trim() ?? 'en'
    this.language = isLikelyLanguageCode(normalizedLanguage) ? normalizedLanguage : 'en'
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }
    if (this.closed) {
      throw new Error('Realtime client is closed')
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })

      let settled = false

      const finish = (error?: Error) => {
        if (settled) {
          return
        }
        settled = true
        if (error) {
          reject(error)
          return
        }
        resolve()
      }

      ws.on('open', () => {
        this.ws = ws
        this.connected = true
        this.sendEvent({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: {
                  type: 'audio/pcm',
                  rate: 24000,
                },
                transcription: {
                  model: this.model,
                  prompt: this.prompt,
                  language: this.language,
                },
                noise_reduction: {
                  type: 'near_field',
                },
              },
            },
          },
        })
        finish()
      })

      ws.on('message', (rawData) => {
        this.handleServerEvent(rawData)
      })

      ws.on('error', (error) => {
        const message = error instanceof Error ? error.message : 'OpenAI realtime websocket error'
        this.emit('error', message)
        if (!settled) {
          finish(new Error(message))
        }
      })

      ws.on('close', () => {
        this.connected = false
        this.ws = null
        this.closed = true
        this.emit('close')
        if (!settled) {
          finish(new Error('OpenAI realtime websocket closed before initialization'))
        }
      })
    })
  }

  sendAudio(base64Audio: string): void {
    const normalized = asNonEmptyString(base64Audio)
    if (!normalized || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: normalized,
    })
  }

  commitAudioBuffer(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    this.sendEvent({
      type: 'input_audio_buffer.commit',
    })
  }

  close(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    this.connected = false
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private handleServerEvent(rawData: RawData): void {
    let parsed: OpenAIRealtimeServerEvent
    try {
      parsed = JSON.parse(rawData.toString()) as OpenAIRealtimeServerEvent
    } catch {
      return
    }

    const eventType = asNonEmptyString(parsed.type)
    if (!eventType) {
      return
    }

    if (
      eventType === 'conversation.item.input_audio_transcription.delta' ||
      eventType === 'transcript.text.delta'
    ) {
      const deltaText = asNonEmptyString(parsed.delta) ?? asNonEmptyString(parsed.text)
      if (deltaText) {
        this.emit('partial', deltaText)
      }
      return
    }

    if (
      eventType === 'conversation.item.input_audio_transcription.completed' ||
      eventType === 'transcript.text.done'
    ) {
      const completedText = asNonEmptyString(parsed.transcript) ?? asNonEmptyString(parsed.text)
      if (completedText) {
        this.emit('final', completedText)
      }
      return
    }

    if (eventType === 'error') {
      const errorMessage =
        asNonEmptyString(parsed.error?.message) ??
        asNonEmptyString(parsed.message) ??
        'OpenAI realtime transcription error'
      this.emit('error', errorMessage)
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    this.ws.send(JSON.stringify(event))
  }
}

export interface RealtimeTranscriptionClientLike {
  connect(): Promise<void>
  sendAudio(base64Audio: string): void
  commitAudioBuffer(): void
  close(): void
  on(
    event: 'partial' | 'final' | 'error' | 'close',
    listener: (...args: unknown[]) => void,
  ): this
}
