import { useState, useRef, type FormEvent, type ChangeEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import type { CommanderSession } from '../hooks/useCommander'

interface ProfileUpdates {
  persona?: string
  borderColor?: string
  accentColor?: string
  speakingTone?: string
}

interface EditCommanderFormProps {
  commander: CommanderSession
  onSave: (updates: ProfileUpdates, avatarFile: File | null) => Promise<void>
  onClose: () => void
  isPending: boolean
}

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20 placeholder:text-sumi-mist'

const LABEL_CLASS = 'text-whisper uppercase tracking-wide text-sumi-diluted'

export function EditCommanderForm({ commander, onSave, onClose, isPending }: EditCommanderFormProps) {
  const [persona, setPersona] = useState(commander.persona ?? '')
  const [speakingTone, setSpeakingTone] = useState(commander.ui?.speakingTone ?? '')
  const [borderColor, setBorderColor] = useState(commander.ui?.borderColor ?? '')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const currentAvatarSrc = avatarPreview ?? commander.avatarUrl ?? null

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }
    if (avatarPreview) {
      URL.revokeObjectURL(avatarPreview)
    }
    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await onSave(
        {
          persona: persona.trim() || undefined,
          speakingTone: speakingTone.trim() || undefined,
          borderColor: borderColor.trim() || undefined,
        },
        avatarFile,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes.')
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
      {/* Avatar + identity */}
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          {currentAvatarSrc ? (
            <img
              src={currentAvatarSrc}
              alt=""
              className="h-16 w-16 rounded-full border-2 border-sumi-mist object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-sumi-mist bg-sumi-mist font-mono text-xl font-semibold text-sumi-black">
              {commander.host.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-1.5">
          <p className="font-mono text-sm font-medium text-sumi-black truncate">{commander.host}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5 min-h-[36px]"
          >
            <ImagePlus size={12} />
            {currentAvatarSrc ? 'Change Image' : 'Choose Image'}
          </button>
          {avatarFile && (
            <p className="text-whisper text-sumi-diluted truncate max-w-[180px]">{avatarFile.name}</p>
          )}
        </div>
      </div>

      <div className="divider-ink" />

      {/* Persona */}
      <label className="block">
        <span className={LABEL_CLASS}>Persona</span>
        <input
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="Senior engineer who owns infra"
          className={INPUT_CLASS}
        />
      </label>

      {/* Speaking tone */}
      <label className="block">
        <span className={LABEL_CLASS}>Speaking Tone</span>
        <input
          value={speakingTone}
          onChange={(e) => setSpeakingTone(e.target.value)}
          placeholder="Concise, direct, prefers bullet points"
          className={INPUT_CLASS}
        />
      </label>

      {/* Border color */}
      <label className="block">
        <span className={LABEL_CLASS}>Card Border Color</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="color"
            value={borderColor || '#1C1C1C'}
            onChange={(e) => setBorderColor(e.target.value)}
            className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-ink-border bg-washi-white p-0.5"
            title="Pick a color"
          />
          <input
            value={borderColor}
            onChange={(e) => setBorderColor(e.target.value)}
            placeholder="#1C1C1C"
            className="flex-1 rounded-lg border border-ink-border px-3 py-2 text-[16px] md:text-sm bg-washi-white focus:outline-none focus:ring-1 focus:ring-sumi-black/20 placeholder:text-sumi-mist"
          />
          {borderColor && (
            <button
              type="button"
              onClick={() => setBorderColor('')}
              className="shrink-0 text-whisper text-sumi-diluted hover:text-sumi-black transition-colors px-1"
            >
              clear
            </button>
          )}
        </div>
      </label>

      {error && <p className="text-sm text-accent-vermillion">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="btn-ghost !px-4 !py-2 text-sm min-h-[44px]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="btn-primary !px-4 !py-2 text-sm min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
