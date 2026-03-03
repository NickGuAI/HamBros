import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchJson, getAccessToken } from '@/lib/api'
import { getWsBase } from '@/lib/api-base'

interface RealtimeTranscriptionConfig {
  openaiConfigured: boolean
}

interface RealtimeProxyMessage {
  type?: unknown
  text?: unknown
  message?: unknown
}

interface ActiveTranscriptionSession {
  ws: WebSocket
  mediaStream: MediaStream
  audioContext: AudioContext
  sourceNode: MediaStreamAudioSourceNode
  workletNode: AudioWorkletNode
  pendingStop: boolean
  finalizationTimer: number | null
  ready: boolean
}

type AudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext
type AudioWindow = Window & {
  webkitAudioContext?: AudioContextConstructor
}

export interface UseOpenAITranscriptionOptions {
  enabled?: boolean
  language?: string
}

export interface UseOpenAITranscriptionResult {
  isListening: boolean
  transcript: string
  startListening: () => void
  stopListening: () => void
  isSupported: boolean
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeLanguage(value: string): string {
  const normalized = value.trim()
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(normalized)) {
    return 'en'
  }
  return normalized
}

function resolveAudioContextConstructor(targetWindow: AudioWindow): AudioContextConstructor | null {
  return targetWindow.AudioContext ?? targetWindow.webkitAudioContext ?? null
}

function browserSupportsOpenAITranscription(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false
  }

  const audioWindow = window as AudioWindow
  return (
    Boolean(resolveAudioContextConstructor(audioWindow)) &&
    typeof window.AudioWorkletNode !== 'undefined' &&
    typeof window.WebSocket !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  )
}

function buildRealtimeTranscriptionUrl(token: string | null, language: string): string {
  const params = new URLSearchParams()
  if (token) {
    params.set('access_token', token)
  }
  params.set('language', normalizeLanguage(language))
  const query = params.toString()
  const querySuffix = query.length > 0 ? `?${query}` : ''
  const wsBase = getWsBase()

  if (wsBase) {
    return `${wsBase}/api/realtime/transcription${querySuffix}`
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/realtime/transcription${querySuffix}`
}

async function fetchRealtimeTranscriptionConfig(): Promise<RealtimeTranscriptionConfig> {
  return fetchJson<RealtimeTranscriptionConfig>('/api/realtime/config')
}

export function useOpenAITranscriptionConfig() {
  return useQuery({
    queryKey: ['realtime', 'transcription', 'config'],
    queryFn: fetchRealtimeTranscriptionConfig,
    refetchInterval: 15_000,
  })
}

export function useOpenAITranscription(
  options: UseOpenAITranscriptionOptions = {},
): UseOpenAITranscriptionResult {
  const enabled = options.enabled ?? true
  const language = options.language ?? 'en'
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const sessionRef = useRef<ActiveTranscriptionSession | null>(null)
  const partialTranscriptRef = useRef('')
  const transcriptSegmentsRef = useRef<string[]>([])

  const isSupported = useMemo(
    () => enabled && browserSupportsOpenAITranscription(),
    [enabled],
  )

  const releaseAudioCapture = useCallback((session: ActiveTranscriptionSession) => {
    session.workletNode.port.onmessage = null
    try {
      session.sourceNode.disconnect()
    } catch {
      // no-op
    }
    try {
      session.workletNode.disconnect()
    } catch {
      // no-op
    }
    for (const track of session.mediaStream.getTracks()) {
      track.stop()
    }
    void session.audioContext.close().catch(() => undefined)
  }, [])

  const closeSession = useCallback((options: { closeSocket?: boolean } = {}) => {
    const session = sessionRef.current
    if (!session) {
      return
    }

    sessionRef.current = null
    if (session.finalizationTimer !== null) {
      window.clearTimeout(session.finalizationTimer)
      session.finalizationTimer = null
    }

    releaseAudioCapture(session)

    if (options.closeSocket !== false && session.ws.readyState <= WebSocket.OPEN) {
      session.ws.close()
    }

    setIsListening(false)
  }, [releaseAudioCapture])

  useEffect(() => {
    return () => {
      closeSession()
    }
  }, [closeSession])

  const startListening = useCallback(() => {
    if (!isSupported || sessionRef.current) {
      return
    }

    let mediaStream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    let sourceNode: MediaStreamAudioSourceNode | null = null
    let workletNode: AudioWorkletNode | null = null
    let ws: WebSocket | null = null

    const setup = async () => {
      setTranscript('')
      partialTranscriptRef.current = ''
      transcriptSegmentsRef.current = []

      const audioWindow = window as AudioWindow
      const AudioContextCtor = resolveAudioContextConstructor(audioWindow)
      if (!AudioContextCtor) {
        throw new Error('AudioContext is not available')
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      audioContext = new AudioContextCtor({ sampleRate: 24000 })
      await audioContext.audioWorklet.addModule('/audio-processor.js')
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      sourceNode = audioContext.createMediaStreamSource(mediaStream)
      workletNode = new AudioWorkletNode(audioContext, 'pcm16-worklet', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: {
          targetSampleRate: 24000,
        },
      })
      sourceNode.connect(workletNode)

      const token = await getAccessToken()
      ws = new WebSocket(buildRealtimeTranscriptionUrl(token, language))
      ws.binaryType = 'arraybuffer'

      const activeSession: ActiveTranscriptionSession = {
        ws,
        mediaStream,
        audioContext,
        sourceNode,
        workletNode,
        pendingStop: false,
        finalizationTimer: null,
        ready: false,
      }
      sessionRef.current = activeSession

      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (sessionRef.current !== activeSession || activeSession.pendingStop) {
          return
        }
        if (!activeSession.ready) {
          return
        }
        if (event.data instanceof ArrayBuffer && ws?.readyState === WebSocket.OPEN) {
          ws.send(event.data)
        }
      }

      ws.onopen = () => {
        if (sessionRef.current !== activeSession) {
          return
        }
        setIsListening(true)
      }

      ws.onmessage = (event) => {
        if (sessionRef.current !== activeSession) {
          return
        }

        let message: RealtimeProxyMessage
        try {
          message = JSON.parse(event.data as string) as RealtimeProxyMessage
        } catch {
          return
        }

        const messageType = asNonEmptyString(message.type)
        if (!messageType) {
          return
        }

        if (messageType === 'ready') {
          activeSession.ready = true
          return
        }

        if (messageType === 'partial') {
          const partialText = asNonEmptyString(message.text)
          if (partialText) {
            partialTranscriptRef.current = partialText
          }
          return
        }

        if (messageType === 'final') {
          const finalText = asNonEmptyString(message.text)
          const fallback = partialTranscriptRef.current.trim()
          const segment = finalText ?? (fallback.length > 0 ? fallback : null)
          if (segment) {
            transcriptSegmentsRef.current.push(segment)
          }
          partialTranscriptRef.current = ''

          // With server_vad, multiple finals arrive per recording session.
          // Only tear down once the user has pressed stop.
          if (activeSession.pendingStop) {
            const combinedTranscript = transcriptSegmentsRef.current.join(' ').trim()
            if (combinedTranscript) {
              setTranscript(combinedTranscript)
            }
            closeSession({ closeSocket: false })
          }
          return
        }

        if (messageType === 'error') {
          const fallbackText = partialTranscriptRef.current.trim()
          const proxyMessage = asNonEmptyString(message.message)
          if (!fallbackText && proxyMessage) {
            // Keep UX simple: surface proxy errors in transcript input only
            // when no transcript has been produced yet.
            setTranscript(proxyMessage)
          } else if (fallbackText) {
            setTranscript(fallbackText)
          }
          closeSession({ closeSocket: false })
        }
      }

      ws.onclose = () => {
        if (sessionRef.current !== activeSession) {
          return
        }
        const combinedTranscript = transcriptSegmentsRef.current.join(' ').trim()
        const fallback = partialTranscriptRef.current.trim()
        if (activeSession.pendingStop) {
          if (combinedTranscript) {
            setTranscript(combinedTranscript)
          } else if (fallback) {
            setTranscript(fallback)
          }
        }
        closeSession({ closeSocket: false })
      }

      ws.onerror = () => {
        if (sessionRef.current !== activeSession) {
          return
        }
        closeSession({ closeSocket: false })
      }
    }

    void setup().catch(() => {
      if (workletNode) {
        workletNode.port.onmessage = null
        try {
          workletNode.disconnect()
        } catch {
          // no-op
        }
      }

      if (sourceNode) {
        try {
          sourceNode.disconnect()
        } catch {
          // no-op
        }
      }

      if (mediaStream) {
        for (const track of mediaStream.getTracks()) {
          track.stop()
        }
      }

      if (audioContext) {
        void audioContext.close().catch(() => undefined)
      }

      ws?.close()
      setIsListening(false)
    })
  }, [closeSession, isSupported, language])

  const stopListening = useCallback(() => {
    const session = sessionRef.current
    if (!session) {
      return
    }

    session.pendingStop = true
    setIsListening(false)
    releaseAudioCapture(session)

    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'stop' }))
    }

    session.finalizationTimer = window.setTimeout(() => {
      if (sessionRef.current !== session) {
        return
      }
      const combinedTranscript = transcriptSegmentsRef.current.join(' ').trim()
      const fallback = partialTranscriptRef.current.trim()
      if (combinedTranscript) {
        setTranscript(combinedTranscript)
      } else if (fallback) {
        setTranscript(fallback)
      }
      closeSession()
    }, 2500)
  }, [closeSession, releaseAudioCapture])

  return {
    isListening,
    transcript,
    startListening,
    stopListening,
    isSupported,
  }
}
