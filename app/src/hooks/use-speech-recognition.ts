import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionAlternativeLike
  [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultListLike {
  length: number
  item(index: number): SpeechRecognitionResultLike
  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: Event) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export function getSpeechRecognitionConstructor(
  targetWindow?: SpeechRecognitionWindow,
): SpeechRecognitionConstructor | null {
  if (!targetWindow) return null
  return targetWindow.SpeechRecognition ?? targetWindow.webkitSpeechRecognition ?? null
}

export interface UseSpeechRecognitionResult {
  isListening: boolean
  transcript: string
  startListening: () => void
  stopListening: () => void
  isSupported: boolean
}

export function useSpeechRecognition(language = 'en-US'): UseSpeechRecognitionResult {
  const recognitionConstructor = useMemo(
    () =>
      getSpeechRecognitionConstructor(
        typeof window === 'undefined' ? undefined : (window as SpeechRecognitionWindow),
      ),
    [],
  )
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const transcriptPartsRef = useRef<string[]>([])
  const interimRef = useRef('')

  useEffect(() => {
    if (!recognitionConstructor) return

    const recognition = new recognitionConstructor()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = language

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcriptPart = (result[0]?.transcript ?? result.item(0)?.transcript ?? '').trim()
        if (result.isFinal && transcriptPart) {
          transcriptPartsRef.current.push(transcriptPart)
          interimRef.current = ''
        } else if (transcriptPart) {
          interimRef.current = transcriptPart
        }
      }
    }

    recognition.onerror = () => {
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
      let finalTranscript = transcriptPartsRef.current.join(' ').replace(/\s+/g, ' ').trim()
      // Fallback: on mobile browsers, isFinal may never be true when manually stopped
      if (!finalTranscript && interimRef.current) {
        finalTranscript = interimRef.current
      }
      transcriptPartsRef.current = []
      interimRef.current = ''
      if (finalTranscript) {
        setTranscript(finalTranscript)
      }
    }

    recognitionRef.current = recognition

    return () => {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.stop()
      recognitionRef.current = null
      transcriptPartsRef.current = []
      interimRef.current = ''
    }
  }, [language, recognitionConstructor])

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current
    if (!recognition || isListening) return

    setTranscript('')
    transcriptPartsRef.current = []
    interimRef.current = ''

    try {
      recognition.start()
      setIsListening(true)
    } catch {
      setIsListening(false)
    }
  }, [isListening])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  return {
    isListening,
    transcript,
    startListening,
    stopListening,
    isSupported: Boolean(recognitionConstructor),
  }
}
