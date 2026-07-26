import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import {
  ALLOWED_MESSAGE_IMAGE_TYPES,
  MAX_MESSAGE_IMAGE_B64_LEN,
  MAX_MESSAGE_IMAGE_COUNT,
} from '../message-images'

const DRAFT_STORAGE_PREFIX = 'herd:draft:'
const DRAFT_IMAGES_STORAGE_PREFIX = 'herd:draft-images:'
const DRAFT_MODE_STORAGE_PREFIX = 'herd:draft-mode:'
const DRAFT_MAX_BYTES = 50 * 1024
const DRAFT_IMAGES_MAX_BYTES = 12 * 1024 * 1024
const DRAFT_SAVE_DEBOUNCE_MS = 500
const DRAFT_SAVED_LABEL_MS = 2000
export type SessionDraftMode = 'quick' | 'markdown'

export function buildSessionDraftStorageKey(sessionName: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sessionName}`
}

export function buildSessionDraftImagesStorageKey(sessionName: string): string {
  return `${DRAFT_IMAGES_STORAGE_PREFIX}${sessionName}`
}

export function buildSessionDraftModeStorageKey(sessionName: string): string {
  return `${DRAFT_MODE_STORAGE_PREFIX}${sessionName}`
}

export interface SessionDraftImage {
  mediaType: string
  data: string
}

interface SessionDraftOptions {
  variant?: 'desktop' | 'mobile'
}

function normalizeDraftMode(value: unknown): SessionDraftMode {
  return value === 'markdown' ? 'markdown' : 'quick'
}

function getTextareaMaxHeight(textarea: HTMLTextAreaElement, mode: SessionDraftMode, variant: 'desktop' | 'mobile'): number {
  const compactMaxHeight = variant === 'mobile' ? 148 : 120
  if (mode === 'quick') {
    return compactMaxHeight
  }

  const pane = textarea.closest<HTMLElement>('[data-composer-resize-root], .session-view-overlay, .mobile-session-shell, .hervald-chat-pane')
  const paneHeight = pane?.getBoundingClientRect().height || window.innerHeight || 800
  return Math.max(compactMaxHeight, Math.round(paneHeight * 0.45))
}

function normalizeDraftImages(value: unknown): SessionDraftImage[] {
  const rawImages = Array.isArray(value)
    ? value
    : (
        value
        && typeof value === 'object'
        && Array.isArray((value as { images?: unknown }).images)
          ? (value as { images: unknown[] }).images
          : []
      )
  const images: SessionDraftImage[] = []
  for (const rawImage of rawImages) {
    if (!rawImage || typeof rawImage !== 'object') {
      continue
    }
    const mediaType = (rawImage as { mediaType?: unknown }).mediaType
    const data = (rawImage as { data?: unknown }).data
    if (
      typeof mediaType === 'string'
      && ALLOWED_MESSAGE_IMAGE_TYPES.has(mediaType)
      && typeof data === 'string'
      && data.length > 0
      && data.length <= MAX_MESSAGE_IMAGE_B64_LEN
    ) {
      images.push({ mediaType, data })
    }
    if (images.length >= MAX_MESSAGE_IMAGE_COUNT) {
      break
    }
  }
  return images
}

export function useSessionDraft(sessionName: string, options: SessionDraftOptions = {}) {
  const [inputText, setInputTextState] = useState('')
  const [draftMode, setDraftModeState] = useState<SessionDraftMode>('quick')
  const [pendingImages, setPendingImagesState] = useState<SessionDraftImage[]>([])
  const [showDraftSaved, setShowDraftSaved] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const latestInputTextRef = useRef('')
  const latestDraftModeRef = useRef<SessionDraftMode>('quick')
  const latestPendingImagesRef = useRef<SessionDraftImage[]>([])
  const draftSaveTimerRef = useRef<number | null>(null)
  const draftSavedIndicatorTimerRef = useRef<number | null>(null)
  const skipDraftSaveCountRef = useRef(1)

  const draftStorageKey = useMemo(() => buildSessionDraftStorageKey(sessionName), [sessionName])
  const draftImagesStorageKey = useMemo(() => buildSessionDraftImagesStorageKey(sessionName), [sessionName])
  const draftModeStorageKey = useMemo(() => buildSessionDraftModeStorageKey(sessionName), [sessionName])

  const setInputText = useCallback((nextInputText: SetStateAction<string>) => {
    const resolvedInputText = typeof nextInputText === 'function'
      ? (nextInputText as (previousInputText: string) => string)(latestInputTextRef.current)
      : nextInputText

    latestInputTextRef.current = resolvedInputText
    setInputTextState(resolvedInputText)
  }, [])

  const setPendingImages = useCallback((nextPendingImages: SetStateAction<SessionDraftImage[]>) => {
    const resolvedPendingImages = typeof nextPendingImages === 'function'
      ? (nextPendingImages as (previousPendingImages: SessionDraftImage[]) => SessionDraftImage[])(latestPendingImagesRef.current)
      : nextPendingImages
    const normalizedPendingImages = normalizeDraftImages(resolvedPendingImages)

    latestPendingImagesRef.current = normalizedPendingImages
    setPendingImagesState(normalizedPendingImages)
  }, [])

  const setDraftMode = useCallback((nextDraftMode: SetStateAction<SessionDraftMode>) => {
    const resolvedDraftMode = typeof nextDraftMode === 'function'
      ? (nextDraftMode as (previousDraftMode: SessionDraftMode) => SessionDraftMode)(latestDraftModeRef.current)
      : nextDraftMode
    const normalizedMode = normalizeDraftMode(resolvedDraftMode)

    latestDraftModeRef.current = normalizedMode
    setDraftModeState(normalizedMode)
  }, [])

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    const variant = options.variant === 'mobile' ? 'mobile' : 'desktop'
    const maxHeight = getTextareaMaxHeight(textarea, latestDraftModeRef.current, variant)
    textarea.style.height = 'auto'
    textarea.style.maxHeight = `${maxHeight}px`
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  }, [options.variant])

  const clearDraftSavedIndicatorTimer = useCallback(() => {
    if (draftSavedIndicatorTimerRef.current !== null) {
      window.clearTimeout(draftSavedIndicatorTimerRef.current)
      draftSavedIndicatorTimerRef.current = null
    }
  }, [])

  const clearDraftSaveTimer = useCallback(() => {
    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current)
      draftSaveTimerRef.current = null
    }
  }, [])

  const showDraftSavedIndicator = useCallback(() => {
    setShowDraftSaved(true)
    clearDraftSavedIndicatorTimer()
    draftSavedIndicatorTimerRef.current = window.setTimeout(() => {
      setShowDraftSaved(false)
      draftSavedIndicatorTimerRef.current = null
    }, DRAFT_SAVED_LABEL_MS)
  }, [clearDraftSavedIndicatorTimer])

  const persistDraft = useCallback((value: string, images: SessionDraftImage[], mode: SessionDraftMode, showIndicator = true) => {
    let persistedSomething = false
    try {
      if (!value) {
        localStorage.removeItem(draftStorageKey)
      } else if (new Blob([value]).size > DRAFT_MAX_BYTES) {
        localStorage.removeItem(draftStorageKey)
      } else {
        localStorage.setItem(draftStorageKey, value)
        persistedSomething = true
      }
    } catch {
      // Ignore localStorage errors (quota, private mode, etc.)
    }

    try {
      if (images.length === 0) {
        localStorage.removeItem(draftImagesStorageKey)
      } else {
        const payload = JSON.stringify({ images })
        if (new Blob([payload]).size > DRAFT_IMAGES_MAX_BYTES) {
          localStorage.removeItem(draftImagesStorageKey)
        } else {
          localStorage.setItem(draftImagesStorageKey, payload)
          persistedSomething = true
        }
      }
    } catch {
      // Ignore localStorage errors (quota, private mode, etc.)
    }

    try {
      if (mode === 'markdown') {
        localStorage.setItem(draftModeStorageKey, mode)
        persistedSomething = true
      } else {
        localStorage.removeItem(draftModeStorageKey)
      }
    } catch {
      // Ignore localStorage errors (quota, private mode, etc.)
    }

    if (showIndicator) {
      if (persistedSomething) {
        showDraftSavedIndicator()
      } else {
        setShowDraftSaved(false)
      }
    }
  }, [draftImagesStorageKey, draftModeStorageKey, draftStorageKey, showDraftSavedIndicator])

  const focusTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      resizeTextarea()
      textareaRef.current?.focus()
    })
  }, [resizeTextarea])

  const clearDraft = useCallback(() => {
    latestInputTextRef.current = ''
    latestDraftModeRef.current = 'quick'
    latestPendingImagesRef.current = []
    clearDraftSaveTimer()
    clearDraftSavedIndicatorTimer()
    try {
      localStorage.removeItem(draftStorageKey)
      localStorage.removeItem(draftImagesStorageKey)
      localStorage.removeItem(draftModeStorageKey)
    } catch {
      // Ignore localStorage errors.
    }
    setInputTextState('')
    setDraftModeState('quick')
    setPendingImagesState([])
    setShowDraftSaved(false)
    requestAnimationFrame(() => {
      resizeTextarea()
    })
  }, [clearDraftSaveTimer, clearDraftSavedIndicatorTimer, draftImagesStorageKey, draftModeStorageKey, draftStorageKey, resizeTextarea])

  const restoreDraft = useCallback((value: string, images: SessionDraftImage[], mode: SessionDraftMode = 'quick') => {
    const normalizedImages = normalizeDraftImages(images)
    const normalizedMode = normalizeDraftMode(mode)
    latestInputTextRef.current = value
    latestDraftModeRef.current = normalizedMode
    latestPendingImagesRef.current = normalizedImages
    clearDraftSaveTimer()
    clearDraftSavedIndicatorTimer()
    persistDraft(value, normalizedImages, normalizedMode, false)
    setInputTextState(value)
    setDraftModeState(normalizedMode)
    setPendingImagesState(normalizedImages)
    setShowDraftSaved(false)
    requestAnimationFrame(() => {
      resizeTextarea()
    })
  }, [clearDraftSaveTimer, clearDraftSavedIndicatorTimer, persistDraft, resizeTextarea])

  useEffect(() => {
    resizeTextarea()
  }, [draftMode, inputText, resizeTextarea])

  useLayoutEffect(() => {
    const previousInput = latestInputTextRef.current
    setShowDraftSaved(false)

    let restoredDraft = ''
    let restoredMode: SessionDraftMode = 'quick'
    let restoredImages: SessionDraftImage[] = []
    try {
      restoredDraft = localStorage.getItem(draftStorageKey) ?? ''
    } catch {
      restoredDraft = ''
    }
    try {
      const rawImages = localStorage.getItem(draftImagesStorageKey)
      restoredImages = rawImages && new Blob([rawImages]).size <= DRAFT_IMAGES_MAX_BYTES
        ? normalizeDraftImages(JSON.parse(rawImages))
        : []
    } catch {
      restoredImages = []
    }
    try {
      restoredMode = normalizeDraftMode(localStorage.getItem(draftModeStorageKey))
    } catch {
      restoredMode = 'quick'
    }

    const previousImages = latestPendingImagesRef.current
    const imagesUnchanged = JSON.stringify(restoredImages) === JSON.stringify(previousImages)
    const modeUnchanged = restoredMode === latestDraftModeRef.current
    skipDraftSaveCountRef.current = restoredDraft === previousInput && imagesUnchanged && modeUnchanged ? 1 : 2
    latestInputTextRef.current = restoredDraft
    latestDraftModeRef.current = restoredMode
    latestPendingImagesRef.current = restoredImages
    setInputTextState(restoredDraft)
    setDraftModeState(restoredMode)
    setPendingImagesState(restoredImages)
    requestAnimationFrame(() => {
      resizeTextarea()
    })
  }, [draftImagesStorageKey, draftModeStorageKey, draftStorageKey, resizeTextarea])

  useEffect(() => {
    if (skipDraftSaveCountRef.current > 0) {
      skipDraftSaveCountRef.current -= 1
      return
    }

    clearDraftSaveTimer()
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null
      persistDraft(inputText, pendingImages, draftMode)
    }, DRAFT_SAVE_DEBOUNCE_MS)

    return () => {
      clearDraftSaveTimer()
    }
  }, [clearDraftSaveTimer, draftMode, inputText, pendingImages, persistDraft])

  const flushLatestDraft = useCallback(() => {
    clearDraftSaveTimer()
    persistDraft(latestInputTextRef.current, latestPendingImagesRef.current, latestDraftModeRef.current, false)
  }, [clearDraftSaveTimer, persistDraft])

  useLayoutEffect(() => {
    return () => {
      flushLatestDraft()
    }
  }, [flushLatestDraft])

  useEffect(() => {
    window.addEventListener('beforeunload', flushLatestDraft)
    window.addEventListener('pagehide', flushLatestDraft)
    return () => {
      window.removeEventListener('beforeunload', flushLatestDraft)
      window.removeEventListener('pagehide', flushLatestDraft)
    }
  }, [flushLatestDraft])

  useEffect(() => {
    return () => {
      clearDraftSavedIndicatorTimer()
    }
  }, [clearDraftSavedIndicatorTimer])

  return {
    inputText,
    latestInputTextRef,
    draftMode,
    latestDraftModeRef,
    pendingImages,
    latestPendingImagesRef,
    resizeTextarea,
    setInputText,
    setDraftMode,
    setPendingImages,
    showDraftSaved,
    focusTextarea,
    textareaRef,
    clearDraft,
    restoreDraft,
  }
}
