import { describe, expect, it } from 'vitest'
import { getSpeechRecognitionConstructor } from '@/hooks/use-speech-recognition'

type RecognitionCtor = new () => unknown

describe('getSpeechRecognitionConstructor', () => {
  it('returns null when no window object is available', () => {
    expect(getSpeechRecognitionConstructor(undefined)).toBeNull()
  })

  it('prefers unprefixed SpeechRecognition when available', () => {
    const standardCtor = class StandardRecognition {} as RecognitionCtor
    const webkitCtor = class WebkitRecognition {} as RecognitionCtor
    const mockWindow = {
      SpeechRecognition: standardCtor,
      webkitSpeechRecognition: webkitCtor,
    } as Window & {
      SpeechRecognition?: RecognitionCtor
      webkitSpeechRecognition?: RecognitionCtor
    }

    expect(getSpeechRecognitionConstructor(mockWindow)).toBe(standardCtor)
  })

  it('falls back to webkitSpeechRecognition when needed', () => {
    const webkitCtor = class WebkitRecognition {} as RecognitionCtor
    const mockWindow = {
      webkitSpeechRecognition: webkitCtor,
    } as Window & {
      SpeechRecognition?: RecognitionCtor
      webkitSpeechRecognition?: RecognitionCtor
    }

    expect(getSpeechRecognitionConstructor(mockWindow)).toBe(webkitCtor)
  })
})
