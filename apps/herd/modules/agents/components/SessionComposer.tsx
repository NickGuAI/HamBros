import {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { AlertTriangle, ArrowUp, BrainCircuit, ListChecks, ListPlus, Mic, Paperclip, Plus, X, Zap } from 'lucide-react'
import {
  preloadOpenAITranscriptionWorklet,
  useOpenAITranscription,
  useOpenAITranscriptionConfig,
} from '@/hooks/use-openai-transcription'
import { useSpeechRecognition } from '@/hooks/use-speech-recognition'
import { useComposerAbilities } from '@/hooks/use-composer-abilities'
import { useComposerSkillSlots } from '@/hooks/use-composer-skill-slots'
import type { AgentType, SessionQueueSnapshot } from '@/types'
import { cn } from '@/lib/utils'
import { getQueuePendingCount } from '../queue-state'
import { AddToChatSheet } from './AddToChatSheet'
import { SkillsPicker } from './SkillsPicker'
import { QueuePanel } from './QueuePanel'
import { useSessionDraft } from '../page-shell/use-session-draft'
import type { SessionDraftMode } from '../page-shell/use-session-draft'
import type { WorkspaceContextRequest, WorkspacePendingFileAnnotation } from '@modules/workspace/use-workspace'
import {
  applyComposerAbilitiesToText,
  type ComposerAbility,
} from '@modules/settings/composer-abilities'
import {
  ALLOWED_MESSAGE_IMAGE_TYPES,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGE_COUNT,
  MAX_MESSAGE_IMAGE_SIZE_MB,
} from '../message-images'

export interface SessionComposerImage {
  mediaType: string
  data: string
}

export interface SessionComposerSubmitPayload {
  text: string
  images?: SessionComposerImage[]
  clientSendId?: string
  context?: Pick<WorkspaceContextRequest, 'filePaths' | 'directoryPaths' | 'fileAnnotations'>
}

export interface SessionComposerContextAttachments {
  filePaths: string[]
  directoryPaths: string[]
  fileAnnotations: WorkspacePendingFileAnnotation[]
}

interface SessionComposerProps {
  sessionName: string
  agentType?: AgentType
  theme?: 'light' | 'dark'
  variant?: 'desktop' | 'mobile'
  placeholder?: string
  disabled?: boolean
  disabledMessage?: string
  sendReady?: boolean
  isStreaming?: boolean
  contextFilePaths?: string[]
  contextDirectoryPaths?: string[]
  contextFileAnnotations?: WorkspacePendingFileAnnotation[]
  onRemoveContextFilePath?: (filePath: string) => void
  onRemoveContextDirectoryPath?: (directoryPath: string) => void
  onRemoveContextFileAnnotation?: (annotationId: string) => void
  onClearContextFilePaths?: () => void
  onRestoreContextAttachments?: (context: SessionComposerContextAttachments) => void
  onOpenWorkspace?: () => void
  showWorkspaceShortcut?: boolean
  queueSnapshot?: SessionQueueSnapshot
  queueError?: string | null
  isQueueMutating?: boolean
  onClearQueue?: () => void
  onMoveQueuedMessage?: (id: string, offset: number) => void
  onRemoveQueuedMessage?: (id: string) => void
  onSend: (payload: SessionComposerSubmitPayload) => boolean | void | Promise<boolean | void>
  onQueue?: (
    payload: SessionComposerSubmitPayload,
  ) => boolean | void | Promise<boolean | void>
}

export interface SessionComposerHandle {
  seedText: (nextText: string) => void
  openImagePicker: () => void
  openSkillsPicker: () => void
}

type SkillsPickerMode = 'insert' | 'quick-slot'

function basename(filePath: string): string {
  const cleanPath = filePath.endsWith('/') ? filePath.slice(0, -1) : filePath
  const parts = cleanPath.split('/')
  const name = parts[parts.length - 1] || cleanPath
  return filePath.endsWith('/') ? `${name}/` : name
}

function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)} MB`
}

function createClientSendId(): string {
  return `send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const SessionComposer = forwardRef<SessionComposerHandle, SessionComposerProps>(function SessionComposer({
  sessionName,
  agentType,
  theme = 'light',
  variant = 'desktop',
  placeholder = 'Send a message...',
  disabled = false,
  disabledMessage,
  sendReady = true,
  contextFilePaths = [],
  contextDirectoryPaths = [],
  contextFileAnnotations = [],
  onRemoveContextFilePath,
  onRemoveContextDirectoryPath,
  onRemoveContextFileAnnotation,
  onClearContextFilePaths,
  onRestoreContextAttachments,
  onOpenWorkspace,
  showWorkspaceShortcut = false,
  queueSnapshot,
  queueError,
  isQueueMutating = false,
  onClearQueue,
  onMoveQueuedMessage,
  onRemoveQueuedMessage,
  onSend,
  onQueue,
}, ref) {
  const isMobileVariant = variant === 'mobile'
  const composerHintId = useId()
  const {
    inputText,
    setInputText,
    draftMode,
    setDraftMode,
    showDraftSaved,
    focusTextarea,
    textareaRef,
    clearDraft,
    restoreDraft,
    pendingImages,
    setPendingImages,
  } = useSessionDraft(sessionName, { variant })
  const [imageError, setImageError] = useState<string | null>(null)
  const [isQueueSubmitPending, setIsQueueSubmitPending] = useState(false)
  const [isSendSubmitPending, setIsSendSubmitPending] = useState(false)
  const [skillsPickerMode, setSkillsPickerMode] = useState<SkillsPickerMode | null>(null)
  const [showQueuePanel, setShowQueuePanel] = useState(false)
  const [showAddToChatSheet, setShowAddToChatSheet] = useState(false)
  const [selectedAbilityIds, setSelectedAbilityIds] = useState<string[]>([])
  const [showCustomAbilityForm, setShowCustomAbilityForm] = useState(false)
  const [customAbilityLabel, setCustomAbilityLabel] = useState('')
  const [customAbilityPrompt, setCustomAbilityPrompt] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queueSubmitPendingRef = useRef(false)
  const sendSubmitPendingRef = useRef(false)
  const isComposingRef = useRef(false)
  const justEndedCompositionRef = useRef(false)
  const {
    abilities: composerAbilities,
    customAbilitiesEnabled,
    addCustomAbility,
    removeCustomAbility,
    isSaving: isSavingComposerAbility,
    loadError: composerAbilitiesLoadError,
    retryLoad: retryComposerAbilitiesLoad,
  } = useComposerAbilities()
  const {
    primarySkillName,
    setPrimarySkillName,
    clearPrimarySkillName,
    isSaving: isSavingSkillSlot,
    loadError: composerSkillSlotsLoadError,
    retryLoad: retryComposerSkillSlotsLoad,
  } = useComposerSkillSlots()
  const { data: realtimeTranscriptionConfig } = useOpenAITranscriptionConfig()
  const realtimeTranscriptionTerms = useMemo(
    () => [sessionName, agentType].filter((term): term is string => typeof term === 'string' && term.length > 0),
    [agentType, sessionName],
  )
  const openAITranscription = useOpenAITranscription({
    enabled: Boolean(realtimeTranscriptionConfig?.openaiConfigured),
    terms: realtimeTranscriptionTerms,
  })
  const speechRecognition = useSpeechRecognition()
  const activeTranscription =
    realtimeTranscriptionConfig?.openaiConfigured && openAITranscription.isSupported
      ? openAITranscription
      : speechRecognition
  const isMicConnecting = activeTranscription === openAITranscription
    ? openAITranscription.isConnecting
    : false
  const {
    isListening: isMicListening,
    transcript: speechTranscript,
    startListening,
    stopListening,
    isSupported: isMicSupported,
  } = activeTranscription

  useEffect(() => {
    if (!realtimeTranscriptionConfig?.openaiConfigured || !openAITranscription.isSupported) {
      return
    }

    void preloadOpenAITranscriptionWorklet()
  }, [openAITranscription.isSupported, realtimeTranscriptionConfig?.openaiConfigured])

  const queueDraftsSupported = !disabled && typeof onQueue === 'function'
  const totalQueuedCount = getQueuePendingCount(queueSnapshot)
  const queueMaxSize = typeof queueSnapshot?.maxSize === 'number' ? queueSnapshot.maxSize : 0
  const canOpenQueuePanel = !disabled && queueMaxSize > 0
  const showMobileQueueButton = isMobileVariant && canOpenQueuePanel
  const isQueueDraftBlocked = isQueueSubmitPending || isQueueMutating || isSendSubmitPending
  const queueButtonLabel = queueMaxSize > 0
    ? `Queue ${totalQueuedCount}/${queueMaxSize}`
    : 'Queue'
  const hasContextAttachments = contextFilePaths.length > 0 || contextDirectoryPaths.length > 0 || contextFileAnnotations.length > 0
  const canQueueDraft = (
    queueDraftsSupported
    && !isQueueDraftBlocked
    && (inputText.trim().length > 0 || pendingImages.length > 0 || hasContextAttachments)
  )
  const canSend = (
    !disabled
    && !isQueueSubmitPending
    && !isSendSubmitPending
    && sendReady
    && (inputText.trim().length > 0 || pendingImages.length > 0 || hasContextAttachments)
  )
  const primaryActionDisabled = !canSend
  const primaryActionLabel = isMobileVariant ? 'Send message' : 'Send'
  const primaryActionTitle = !sendReady && !disabled ? 'Connecting…' : primaryActionLabel
  const queueButtonTitle = canOpenQueuePanel
    ? 'Open queue'
    : !queueDraftsSupported
      ? 'Queue is only available for stream agent sessions'
      : 'Queue unavailable'
  const quickModeHint = queueDraftsSupported ? 'Enter send · Tab queue' : 'Enter send'
  const markdownModeHint = 'Markdown · Enter newline · ⌘Enter send'
  const footerHint = disabled
    ? (disabledMessage ?? 'Composer unavailable')
    : isSendSubmitPending
      ? 'Sending message...'
    : isQueueSubmitPending
      ? 'Queuing message...'
    : draftMode === 'markdown'
      ? markdownModeHint
      : quickModeHint
  const selectedAbilities = composerAbilities.filter((ability) => selectedAbilityIds.includes(ability.id))
  const showSkills = skillsPickerMode !== null
  const composerSettingsLoadError = composerAbilitiesLoadError ?? composerSkillSlotsLoadError
  const effectivePlaceholder = isMobileVariant && disabled && disabledMessage
    ? disabledMessage
    : placeholder

  useImperativeHandle(ref, () => ({
    seedText(nextText: string) {
      setInputText(nextText)
      focusTextarea()
    },
    openImagePicker() {
      fileInputRef.current?.click()
    },
    openSkillsPicker() {
      setSkillsPickerMode('insert')
    },
  }), [focusTextarea, setInputText])

  useEffect(() => {
    const normalizedTranscript = speechTranscript.trim()
    if (!normalizedTranscript) {
      return
    }

    setInputText((prev) => {
      const currentText = prev.trimEnd()
      return currentText ? `${currentText} ${normalizedTranscript}` : normalizedTranscript
    })
    focusTextarea()
  }, [focusTextarea, setInputText, speechTranscript])

  function clearComposer() {
    setPendingImages([])
    setImageError(null)
    setSelectedAbilityIds([])
    onClearContextFilePaths?.()
    clearDraft()
  }

  function restoreComposer(snapshot: {
    inputText: string
    draftMode: SessionDraftMode
    pendingImages: SessionComposerImage[]
    selectedAbilityIds: string[]
    context: SessionComposerContextAttachments
  }) {
    restoreDraft(snapshot.inputText, snapshot.pendingImages, snapshot.draftMode)
    setImageError(null)
    setSelectedAbilityIds(snapshot.selectedAbilityIds)
    onRestoreContextAttachments?.(snapshot.context)
  }

  function buildContextPayload(): SessionComposerSubmitPayload['context'] | undefined {
    const filePaths = contextFilePaths.filter((filePath) => filePath.trim().length > 0)
    const directoryPaths = contextDirectoryPaths.filter((directoryPath) => directoryPath.trim().length > 0)
    const fileAnnotations = contextFileAnnotations
      .filter((annotation) => annotation.path.trim().length > 0 && annotation.body.trim().length > 0)
      .map((annotation) => ({
        path: annotation.path,
        body: annotation.body,
        quote: annotation.quote ?? null,
        range: annotation.range ?? null,
      }))
    if (filePaths.length === 0 && directoryPaths.length === 0 && fileAnnotations.length === 0) {
      return undefined
    }
    return {
      ...(filePaths.length > 0 ? { filePaths } : {}),
      ...(directoryPaths.length > 0 ? { directoryPaths } : {}),
      ...(fileAnnotations.length > 0 ? { fileAnnotations } : {}),
    }
  }

  function isCompositionShortcutEvent(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const nativeEvent = event.nativeEvent as KeyboardEvent<HTMLTextAreaElement>['nativeEvent'] & {
      isComposing?: boolean
      keyCode?: number
    }
    return Boolean(
      nativeEvent.isComposing ||
      isComposingRef.current ||
      justEndedCompositionRef.current ||
      event.key === 'Process' ||
      nativeEvent.keyCode === 229,
    )
  }

  async function handleSend() {
    const text = inputText.trim()
    const context = buildContextPayload()
    if (
      (!text && pendingImages.length === 0 && !context) ||
      disabled ||
      !sendReady ||
      sendSubmitPendingRef.current
    ) {
      return
    }

    const images = pendingImages.slice()
    const clientSendId = createClientSendId()
    const snapshot = {
      inputText,
      draftMode,
      pendingImages: images,
      selectedAbilityIds: selectedAbilityIds.slice(),
      context: {
        filePaths: contextFilePaths.slice(),
        directoryPaths: contextDirectoryPaths.slice(),
        fileAnnotations: contextFileAnnotations.slice(),
      },
    }
    const payload: SessionComposerSubmitPayload = {
      text: applyComposerAbilitiesToText(text, selectedAbilities),
      images: images.length > 0 ? images : undefined,
      clientSendId,
      context,
    }
    let shouldRestoreComposer = false
    sendSubmitPendingRef.current = true
    setIsSendSubmitPending(true)
    clearComposer()
    try {
      const sent = onSend(payload)
      if (sent === false) {
        shouldRestoreComposer = true
        return
      }
      const resolved = await Promise.resolve(sent)
      if (resolved === false) {
        shouldRestoreComposer = true
        return
      }
    } catch {
      shouldRestoreComposer = true
      return
    } finally {
      sendSubmitPendingRef.current = false
      setIsSendSubmitPending(false)
      if (shouldRestoreComposer) {
        restoreComposer(snapshot)
      }
    }
  }

  async function handleQueueDraft() {
    if (!canQueueDraft || !onQueue || queueSubmitPendingRef.current) {
      return
    }

    const images = pendingImages.slice()
    const clientSendId = createClientSendId()
    const context = buildContextPayload()
    queueSubmitPendingRef.current = true
    setIsQueueSubmitPending(true)
    try {
      const queued = await onQueue({
        text: applyComposerAbilitiesToText(inputText.trim(), selectedAbilities),
        images: images.length > 0 ? images : undefined,
        clientSendId,
        context,
      })
      if (queued === false) {
        return
      }
    } catch {
      return
    } finally {
      queueSubmitPendingRef.current = false
      setIsQueueSubmitPending(false)
    }
    clearComposer()
  }

  function handleImageFiles(files: FileList | File[]) {
    const selectedImageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (selectedImageFiles.length === 0) {
      return
    }

    const unsupportedImage = selectedImageFiles.find((file) => !ALLOWED_MESSAGE_IMAGE_TYPES.has(file.type))
    if (unsupportedImage) {
      setImageError('Unsupported image type. Use PNG, JPEG, GIF, or WebP.')
      return
    }

    const oversizedImage = selectedImageFiles.find((file) => file.size > MAX_MESSAGE_IMAGE_BYTES)
    if (oversizedImage) {
      const name = oversizedImage.name.trim() || 'Selected image'
      setImageError(
        `Image too large: ${name} is ${formatFileSize(oversizedImage.size)}. Maximum is ${MAX_MESSAGE_IMAGE_SIZE_MB} MB per image.`,
      )
      return
    }

    const availableSlots = Math.max(0, MAX_MESSAGE_IMAGE_COUNT - pendingImages.length)
    if (availableSlots === 0) {
      setImageError(`At most ${MAX_MESSAGE_IMAGE_COUNT} images can be sent at once.`)
      return
    }

    const imageFiles = selectedImageFiles.slice(0, availableSlots)
    if (selectedImageFiles.length > availableSlots) {
      setImageError(`At most ${MAX_MESSAGE_IMAGE_COUNT} images can be sent at once. Extra images were not attached.`)
    } else {
      setImageError(null)
    }

    imageFiles.forEach((file) => {
      const reader = new FileReader()
      reader.onload = (event) => {
        const result = typeof event.target?.result === 'string' ? event.target.result : undefined
        if (!result) {
          return
        }
        const data = result.split(',')[1]
        if (!data) {
          return
        }
        setPendingImages((prev) => {
          if (prev.length >= MAX_MESSAGE_IMAGE_COUNT) {
            return prev
          }
          return [...prev, { mediaType: file.type, data }]
        })
      }
      reader.onerror = () => {
        setImageError('Could not read image. Try another file.')
      }
      reader.readAsDataURL(file)
    })
  }

  function handleTextareaInput(event: ChangeEvent<HTMLTextAreaElement>) {
    setInputText(event.target.value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isCompositionShortcutEvent(event)) {
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
      event.preventDefault()
      toggleDraftMode()
      return
    }

    if (queueDraftsSupported && event.key === 'Tab' && !event.shiftKey && canQueueDraft) {
      event.preventDefault()
      void handleQueueDraft()
      return
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
      return
    }

    if (draftMode === 'quick' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  function handleCompositionStart() {
    isComposingRef.current = true
    justEndedCompositionRef.current = false
  }

  function handleCompositionEnd() {
    isComposingRef.current = false
    justEndedCompositionRef.current = true
    window.setTimeout(() => {
      justEndedCompositionRef.current = false
    }, 0)
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedText = event.clipboardData.getData('text')
    if (draftMode === 'quick' && /\r\n|\r|\n/u.test(pastedText)) {
      setDraftMode('markdown')
    }

    const items = event.clipboardData.items
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          imageFiles.push(file)
        }
      }
    }

    if (imageFiles.length === 0) {
      return
    }

    event.preventDefault()
    handleImageFiles(imageFiles)
  }

  function toggleDraftMode() {
    setDraftMode((current) => current === 'markdown' ? 'quick' : 'markdown')
    focusTextarea()
  }

  function handleMicToggle() {
    if (isMicListening || isMicConnecting) {
      stopListening()
      return
    }
    startListening()
  }

  const micButtonLabel = isMicListening || isMicConnecting
    ? 'Stop voice input'
    : 'Start voice input'
  const micButtonTitle = isMicListening && isMicConnecting
    ? 'Capturing voice input; connecting transcription'
    : isMicConnecting
      ? 'Starting voice input'
      : isMicListening
        ? 'Stop listening'
        : 'Start voice input'

  function toggleAbility(abilityId: string) {
    setSelectedAbilityIds((current) => (
      current.includes(abilityId)
        ? current.filter((id) => id !== abilityId)
        : [...current, abilityId]
    ))
  }

  function skillCommand(skillName: string): string {
    return `/${skillName.trim().replace(/^\/+/u, '')}`
  }

  function applySkillCommand(command: string) {
    const normalizedCommand = command.trim()
    if (!normalizedCommand) {
      return
    }

    setInputText((current) => {
      const trimmed = current.trim()
      if (!trimmed) {
        return `${normalizedCommand} `
      }
      if (trimmed === normalizedCommand || trimmed.startsWith(`${normalizedCommand} `)) {
        return current
      }
      return `${normalizedCommand} ${trimmed}`
    })
    focusTextarea()
  }

  function abilityIcon(ability: ComposerAbility) {
    if (ability.id === 'think-hard') {
      return <BrainCircuit size={14} />
    }
    return <ListChecks size={14} />
  }

  async function handleCustomAbilitySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const added = await addCustomAbility(customAbilityLabel, customAbilityPrompt)
    if (!added) {
      return
    }
    setCustomAbilityLabel('')
    setCustomAbilityPrompt('')
    setShowCustomAbilityForm(false)
  }

  async function handleRemoveCustomAbility(abilityId: string) {
    const removed = await removeCustomAbility(abilityId)
    if (!removed) {
      return
    }
    setSelectedAbilityIds((current) => current.filter((id) => id !== abilityId))
  }

  function renderQuickSkillSlot() {
    const configuredSkill = primarySkillName?.trim() || null
    const disabledSlot = disabled || isSavingSkillSlot

    if (!configuredSkill) {
      return (
        <span className="composer-ability-chip">
          <button
            type="button"
            className="composer-ability-btn"
            onClick={() => setSkillsPickerMode('quick-slot')}
            aria-label="Configure quick skill slot"
            title="Configure quick skill slot"
            disabled={disabledSlot}
          >
            <Plus size={14} />
            <span>Skill Slot</span>
          </button>
        </span>
      )
    }

    const command = skillCommand(configuredSkill)
    return (
      <span className="composer-ability-chip">
        <button
          type="button"
          className="composer-ability-btn composer-ability-btn--with-remove"
          onClick={() => applySkillCommand(command)}
          aria-label={`Apply ${command} skill`}
          title={`Apply ${command}`}
          disabled={disabledSlot}
        >
          <Zap size={14} />
          <span>{command}</span>
        </button>
        <button
          type="button"
          className="composer-ability-remove-btn"
          onClick={() => void clearPrimarySkillName()}
          aria-label={`Clear ${command} quick skill slot`}
          title={`Clear ${command}`}
          disabled={disabledSlot}
        >
          <X size={12} />
        </button>
      </span>
    )
  }

  function renderAbilityActions() {
    if (composerAbilities.length === 0 && !customAbilitiesEnabled) {
      return null
    }

    return (
      <>
        {composerAbilities.map((ability) => {
          const selected = selectedAbilityIds.includes(ability.id)
          return (
            <span key={ability.id} className="composer-ability-chip">
              <button
                type="button"
                className={cn('composer-ability-btn', selected && 'composer-ability-btn--active')}
                onClick={() => toggleAbility(ability.id)}
                aria-label={`${selected ? 'Disable' : 'Enable'} ${ability.label} ability`}
                aria-pressed={selected}
                title={ability.label}
                disabled={disabled}
              >
                {abilityIcon(ability)}
                <span>{ability.label}</span>
              </button>
              {customAbilitiesEnabled && ability.source === 'custom' && (
                <button
                  type="button"
                  className="composer-ability-remove-btn"
                  onClick={() => void handleRemoveCustomAbility(ability.id)}
                  aria-label={`Remove ${ability.label} ability`}
                  title={`Remove ${ability.label}`}
                  disabled={disabled || isSavingComposerAbility}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          )
        })}
        {customAbilitiesEnabled && (
          <button
            type="button"
            className="composer-ability-btn composer-ability-btn--custom"
            onClick={() => setShowCustomAbilityForm((visible) => !visible)}
            aria-label="Add custom composer ability"
            aria-expanded={showCustomAbilityForm}
            disabled={disabled}
          >
            <Plus size={14} />
            <span>Custom</span>
          </button>
        )}
      </>
    )
  }

  function retryComposerSettingsLoad() {
    if (composerAbilitiesLoadError) {
      retryComposerAbilitiesLoad()
    }
    if (composerSkillSlotsLoadError) {
      retryComposerSkillSlotsLoad()
    }
  }

  function renderComposerField() {
    if (isSendSubmitPending) {
      return (
        <div
          className="composer-queueing-overlay"
          role="status"
          aria-live="polite"
          aria-label="Sending message"
        >
          <ArrowUp size={16} aria-hidden="true" />
          <span>Sending message...</span>
        </div>
      )
    }

    if (isQueueSubmitPending) {
      return (
        <div
          className="composer-queueing-overlay"
          role="status"
          aria-live="polite"
          aria-label="Queuing message"
        >
          <ListPlus size={16} aria-hidden="true" />
          <span>Queuing message...</span>
        </div>
      )
    }

    return (
      <>
        <textarea
          ref={textareaRef}
          className="input-field"
          rows={1}
          placeholder={effectivePlaceholder}
          value={inputText}
          onChange={handleTextareaInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          aria-describedby={composerHintId}
          disabled={disabled}
        />
        <button
          type="button"
          className={cn('composer-mode-toggle', draftMode === 'markdown' && 'composer-mode-toggle--active')}
          onClick={toggleDraftMode}
          aria-label={draftMode === 'markdown' ? 'Switch composer to quick mode' : 'Switch composer to markdown mode'}
          aria-pressed={draftMode === 'markdown'}
          aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
          title={draftMode === 'markdown' ? 'Markdown mode on' : 'Markdown mode'}
          disabled={disabled}
        >
          ¶
        </button>
      </>
    )
  }

  return (
    <div className={cn(
      'hervald-session-composer',
      isMobileVariant && 'hervald-session-composer--mobile',
      draftMode === 'markdown' && 'hervald-session-composer--markdown',
    )}>
      <div className="input-bar">
        {hasContextAttachments && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-1">
            {contextFilePaths.map((filePath) => (
              <span
                key={filePath}
                className="file-chip"
                title={filePath}
              >
                {basename(filePath)}
                <button
                  type="button"
                  onClick={() => onRemoveContextFilePath?.(filePath)}
                  className="file-chip-remove"
                  aria-label={`Remove ${basename(filePath)}`}
                >
                  ×
                </button>
              </span>
            ))}
            {contextDirectoryPaths.map((directoryPath) => (
              <span
                key={directoryPath}
                className="file-chip"
                title={directoryPath}
              >
                {basename(`${directoryPath.replace(/\/+$/u, '')}/`)}
                <button
                  type="button"
                  onClick={() => onRemoveContextDirectoryPath?.(directoryPath)}
                  className="file-chip-remove"
                  aria-label={`Remove ${basename(`${directoryPath.replace(/\/+$/u, '')}/`)}`}
                >
                  ×
                </button>
              </span>
            ))}
            {contextFileAnnotations.map((annotation) => (
              <span
                key={annotation.id}
                className="file-chip"
                title={`${annotation.path}\n${annotation.body}`}
              >
                {basename(annotation.path)} annotation
                <button
                  type="button"
                  onClick={() => onRemoveContextFileAnnotation?.(annotation.id)}
                  className="file-chip-remove"
                  aria-label={`Remove annotation for ${basename(annotation.path)}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {pendingImages.length > 0 && (
          <div className="composer-attachments flex flex-wrap gap-2 px-2 pb-2">
            {pendingImages.map((image, index) => (
              <div key={`${image.mediaType}-${index}`} className="composer-attachment relative inline-block">
                <img
                  src={`data:${image.mediaType};base64,${image.data}`}
                  className="h-16 w-16 rounded border object-cover"
                  alt="attachment"
                />
                <button
                  type="button"
                  className="composer-attachment-remove absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--hv-button-primary-bg)] text-[color:var(--hv-fg-inverse)] text-xs leading-none"
                  onClick={() => {
                    setImageError(null)
                    setPendingImages((prev) => prev.filter((_, imageIndex) => imageIndex !== index))
                  }}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {imageError && (
          <div className="composer-image-error" role="alert" aria-live="assertive">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{imageError}</span>
          </div>
        )}
        {composerSettingsLoadError && (
          <div className="composer-image-error" role="alert" aria-live="assertive">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Unable to load composer settings.</span>
            <button
              type="button"
              className="font-mono text-[11px] underline"
              onClick={retryComposerSettingsLoad}
            >
              Retry
            </button>
          </div>
        )}
        {!isMobileVariant && customAbilitiesEnabled && showCustomAbilityForm && (
          <form className="composer-custom-ability-form" onSubmit={handleCustomAbilitySubmit}>
            <input
              value={customAbilityLabel}
              onChange={(event) => setCustomAbilityLabel(event.target.value)}
              placeholder="Ability name"
              aria-label="Custom ability name"
              maxLength={40}
              disabled={disabled || isSavingComposerAbility}
            />
            <textarea
              value={customAbilityPrompt}
              onChange={(event) => setCustomAbilityPrompt(event.target.value)}
              placeholder="Prompt instructions"
              aria-label="Custom ability prompt"
              rows={2}
              maxLength={4000}
              disabled={disabled || isSavingComposerAbility}
            />
            <div className="composer-custom-ability-actions">
              <button
                type="button"
                onClick={() => setShowCustomAbilityForm(false)}
                disabled={isSavingComposerAbility}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  isSavingComposerAbility
                  || customAbilityLabel.trim().length === 0
                  || customAbilityPrompt.trim().length === 0
                }
              >
                Add
              </button>
            </div>
          </form>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) {
              handleImageFiles(event.target.files)
            }
            event.target.value = ''
          }}
        />

        {isMobileVariant ? (
          <>
            <div className="composer-field-stack composer-field-stack--mobile">
              {renderComposerField()}
            </div>

            <div className="composer-row composer-row--mobile">
              <div className="composer-mobile-utility-actions">
                <button
                  type="button"
                  className={cn(
                    'composer-add-btn',
                    showAddToChatSheet && 'composer-add-btn--active',
                  )}
                  onClick={() => setShowAddToChatSheet(true)}
                  aria-label="Add to chat"
                  title="Add to chat"
                  disabled={disabled}
                >
                  <Plus size={19} />
                </button>

                <button
                  type="button"
                  className={cn(
                    'composer-add-btn',
                    showSkills && skillsPickerMode === 'insert' && 'composer-add-btn--active',
                  )}
                  onClick={() => setSkillsPickerMode('insert')}
                  aria-label="Insert skill"
                  aria-pressed={showSkills && skillsPickerMode === 'insert'}
                  title="Insert skill"
                  disabled={disabled}
                >
                  <Zap size={18} />
                </button>

                {showMobileQueueButton && (
                  <button
                    type="button"
                    className="composer-queue-keycap"
                    onClick={() => setShowQueuePanel(true)}
                    aria-label="Open queue"
                    title={queueButtonLabel}
                  >
                    <span className="composer-queue-keycap-cap" aria-hidden="true">Q</span>
                    {totalQueuedCount > 0 && (
                      <span
                        className="composer-queue-keycap-badge"
                        data-testid="composer-queue-count-badge"
                        aria-hidden="true"
                      >
                        {totalQueuedCount}
                      </span>
                    )}
                  </button>
                )}
              </div>

              <div className="composer-mobile-primary-actions">
                {isMicSupported && (
                  <button
                    type="button"
                    className={cn('mic-btn', isMicListening && 'recording', isMicConnecting && 'connecting')}
                    onClick={handleMicToggle}
                    aria-label={micButtonLabel}
                    aria-pressed={isMicListening}
                    title={micButtonTitle}
                    disabled={disabled}
                  >
                    <Mic size={18} />
                  </button>
                )}

                <button
                  type="button"
                  className="send-btn"
                  onClick={() => {
                    void handleSend()
                  }}
                  disabled={primaryActionDisabled}
                  aria-label={primaryActionLabel}
                  title={primaryActionTitle}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="composer-field-stack">
              {renderComposerField()}
            </div>

            <div className="composer-row composer-row--desktop">
              <div className="composer-desktop-actions">
                <button
                  type="button"
                  className="composer-icon-btn p-2 text-[var(--msg-text-muted)] transition-colors hover:text-[var(--msg-text)] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach image"
                  title="Attach image"
                  disabled={disabled || pendingImages.length >= MAX_MESSAGE_IMAGE_COUNT}
                >
                  <Paperclip size={18} />
                </button>

                <button
                  type="button"
                  className={cn(
                    'composer-icon-btn p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    showSkills ? 'text-[var(--msg-text)]' : 'text-[var(--msg-text-muted)] hover:text-[var(--msg-text)]',
                  )}
                  onClick={() => setSkillsPickerMode('insert')}
                  aria-label="Skills"
                  disabled={disabled}
                >
                  <Zap size={18} />
                </button>

                {renderQuickSkillSlot()}
                {renderAbilityActions()}

                {isMicSupported && (
                  <button
                    type="button"
                    className={cn('mic-btn', isMicListening && 'recording', isMicConnecting && 'connecting')}
                    onClick={handleMicToggle}
                    aria-label={micButtonLabel}
                    aria-pressed={isMicListening}
                    title={micButtonTitle}
                    disabled={disabled}
                  >
                    <Mic size={18} />
                  </button>
                )}

                <button
                  type="button"
                  className="composer-queue-btn composer-queue-btn--mobile rounded-lg border border-[var(--msg-border)] px-3 py-2 font-mono text-[11px] text-[var(--msg-text-muted)] transition-colors hover:bg-[var(--msg-surface-elevated)] disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => setShowQueuePanel(true)}
                  disabled={!canOpenQueuePanel}
                  aria-label="Open queue"
                  title={queueButtonTitle}
                >
                  {queueButtonLabel}
                </button>
              </div>

              <div className="composer-desktop-actions composer-desktop-actions--right">
                <button
                  type="button"
                  className="send-btn"
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  aria-label="Send"
                  title={!sendReady && !disabled ? 'Connecting…' : 'Send'}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          </>
        )}

        {!isMobileVariant && (
        <div className="composer-footer flex items-center justify-between px-3 pb-1 pt-0.5">
          <span id={composerHintId} className="font-mono text-[10px] text-[var(--msg-text-muted)]">
            {showDraftSaved ? 'Draft saved · ' : ''}
            {footerHint}
          </span>
          {showWorkspaceShortcut && onOpenWorkspace && (
            <button
              type="button"
              className="font-mono text-[10px] text-[var(--msg-text-muted)] transition-colors hover:text-[var(--msg-text-secondary)]"
              onClick={onOpenWorkspace}
            >
              {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl+'}K workspace
            </button>
          )}
        </div>
        )}
        {isMobileVariant && (
          <span id={composerHintId} className="sr-only">
            {footerHint}
          </span>
        )}
      </div>

      <SkillsPicker
        visible={showSkills}
        variant="hervald"
        theme={theme}
        onSelectSkill={(command) => {
          if (skillsPickerMode === 'quick-slot') {
            return setPrimarySkillName(command)
          }
          setInputText(`${command} `)
          focusTextarea()
          return true
        }}
        onClose={() => setSkillsPickerMode(null)}
        quickSlot={isMobileVariant ? {
          skillName: primarySkillName?.trim() || null,
          configuring: skillsPickerMode === 'quick-slot',
          isSaving: isSavingSkillSlot,
          onApply: () => {
            const configuredSkill = primarySkillName?.trim()
            if (configuredSkill) {
              applySkillCommand(skillCommand(configuredSkill))
            }
            setSkillsPickerMode(null)
          },
          onClear: () => clearPrimarySkillName(),
          onEnterConfigure: () => setSkillsPickerMode('quick-slot'),
          onExitConfigure: () => setSkillsPickerMode('insert'),
        } : undefined}
      />

      {isMobileVariant && (
        <AddToChatSheet
          open={showAddToChatSheet}
          theme={theme}
          onClose={() => setShowAddToChatSheet(false)}
          onPickImage={() => fileInputRef.current?.click()}
          onPickSkill={() => setSkillsPickerMode('insert')}
          onPickFile={() => onOpenWorkspace?.()}
          abilities={{
            items: composerAbilities,
            selectedIds: selectedAbilityIds,
            onToggle: toggleAbility,
            customAbilitiesEnabled,
            onRemoveCustom: handleRemoveCustomAbility,
            onAddCustom: addCustomAbility,
            isSaving: isSavingComposerAbility,
            disabled,
          }}
        />
      )}

      <QueuePanel
        open={showQueuePanel}
        theme={theme}
        queueSnapshot={queueSnapshot}
        queueError={queueError}
        isQueueMutating={isQueueMutating}
        canQueueDraft={canQueueDraft}
        onQueueDraft={handleQueueDraft}
        onClearQueue={onClearQueue}
        onMoveQueuedMessage={onMoveQueuedMessage}
        onRemoveQueuedMessage={onRemoveQueuedMessage}
        onClose={() => setShowQueuePanel(false)}
      />
    </div>
  )
})
