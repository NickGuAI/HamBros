import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Zap, X } from 'lucide-react'
import { useSkills } from '@/hooks/use-skills'
import { cn } from '@/lib/utils'

export function SkillsPicker({
  visible,
  onSelectSkill,
  onClose,
}: {
  visible: boolean
  onSelectSkill: (command: string) => void
  onClose: () => void
}) {
  const { data: skills, isLoading } = useSkills()
  const [query, setQuery] = useState('')
  const filteredSkills = useMemo(() => {
    if (!skills) return []
    const normalized = query.trim().toLowerCase()
    if (!normalized) return skills
    return skills.filter((skill) => skill.name.toLowerCase().includes(normalized))
  }, [skills, query])

  return createPortal(
    <>
      <div
        className={cn('sheet-backdrop', visible && 'visible')}
        onClick={onClose}
      />
      <div className={cn('sheet', visible && 'visible')}>
        <div className="sheet-handle">
          <div className="sheet-handle-bar" />
        </div>
        <div className="px-5 pb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-display text-heading text-sumi-black">Skills</h3>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-ink-wash transition-colors"
              aria-label="Close"
            >
              <X size={16} className="text-sumi-diluted" />
            </button>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full px-3 py-2 mb-3 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            placeholder="Search skills..."
            aria-label="Search skills"
          />
          <div className="space-y-2 max-h-[60dvh] overflow-y-auto">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
              </div>
            ) : skills?.length === 0 ? (
              <div className="text-center py-8 text-sumi-diluted text-sm">
                No user-invocable skills installed
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="text-center py-8 text-sumi-diluted text-sm">
                No skills match your search
              </div>
            ) : (
              filteredSkills.map((skill) => (
                <button
                  key={skill.name}
                  onClick={() => {
                    const cmd = `/${skill.name}`
                    onSelectSkill(cmd)
                    onClose()
                  }}
                  className="w-full text-left p-3 rounded-lg border border-ink-border bg-washi-aged hover:bg-ink-wash transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Zap size={14} className="text-accent-vermillion shrink-0" />
                    <span className="font-mono text-sm text-sumi-black">/{skill.name}</span>
                  </div>
                  {skill.description && (
                    <p className="text-xs text-sumi-diluted mt-1.5 line-clamp-2">{skill.description}</p>
                  )}
                  {skill.argumentHint && (
                    <p className="text-xs text-sumi-mist mt-1 font-mono">
                      args: {skill.argumentHint}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
