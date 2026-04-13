import type { FormEvent } from 'react'
import { AlertTriangle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

export type QuestSource = 'idea' | 'github-issue' | 'manual' | 'voice-log'
export type QuestAgentType = 'claude' | 'codex' | 'gemini'
export type QuestPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
export type QuestArtifactType = 'github_issue' | 'github_pr' | 'url' | 'file'

export interface QuestArtifact {
  type: QuestArtifactType
  label: string
  href: string
}

const QUEST_SOURCES: Array<{ value: QuestSource; label: string }> = [
  { value: 'manual', label: 'manual' },
  { value: 'github-issue', label: 'github-issue' },
  { value: 'idea', label: 'idea' },
  { value: 'voice-log', label: 'voice-log' },
]

const QUEST_ARTIFACT_TYPES: Array<{ value: QuestArtifactType; label: string }> = [
  { value: 'github_issue', label: 'github_issue' },
  { value: 'github_pr', label: 'github_pr' },
  { value: 'url', label: 'url' },
  { value: 'file', label: 'file' },
]

export const QUEST_ARTIFACT_PREFIX: Record<QuestArtifactType, string> = {
  github_issue: 'issue',
  github_pr: 'PR',
  url: 'url',
  file: 'file',
}

interface QuestCreateFormProps {
  source: QuestSource
  onSourceChange: (source: QuestSource) => void
  githubIssueUrl: string
  onGitHubIssueUrlChange: (value: string) => void
  onFetchIssue: () => void
  fetchingIssue: boolean
  instruction: string
  onInstructionChange: (value: string) => void
  cwd: string
  onCwdChange: (value: string) => void
  agentType: QuestAgentType
  onAgentTypeChange: (value: QuestAgentType) => void
  permissionMode: QuestPermissionMode
  onPermissionModeChange: (value: QuestPermissionMode) => void
  skillsInput: string
  onSkillsInputChange: (value: string) => void
  artifacts: QuestArtifact[]
  showArtifactForm: boolean
  onToggleArtifactForm: () => void
  artifactType: QuestArtifactType
  onArtifactTypeChange: (value: QuestArtifactType) => void
  artifactLabel: string
  onArtifactLabelChange: (value: string) => void
  artifactHref: string
  onArtifactHrefChange: (value: string) => void
  onAddArtifact: () => void
  onRemoveArtifact: (indexToRemove: number) => void
  formError: string | null
  submitPending: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function QuestCreateForm({
  source,
  onSourceChange,
  githubIssueUrl,
  onGitHubIssueUrlChange,
  onFetchIssue,
  fetchingIssue,
  instruction,
  onInstructionChange,
  cwd,
  onCwdChange,
  agentType,
  onAgentTypeChange,
  permissionMode,
  onPermissionModeChange,
  skillsInput,
  onSkillsInputChange,
  artifacts,
  showArtifactForm,
  onToggleArtifactForm,
  artifactType,
  onArtifactTypeChange,
  artifactLabel,
  onArtifactLabelChange,
  artifactHref,
  onArtifactHrefChange,
  onAddArtifact,
  onRemoveArtifact,
  formError,
  submitPending,
  onSubmit,
}: QuestCreateFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm text-sumi-gray">Add quest</p>

      <div>
        <label className="section-title block mb-2">Source</label>
        <div className="flex flex-wrap gap-2">
          {QUEST_SOURCES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSourceChange(opt.value)}
              className={cn(
                'rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors',
                source === opt.value
                  ? 'border-sumi-black bg-sumi-black text-washi-aged'
                  : 'border-ink-border bg-washi-aged text-sumi-black hover:border-ink-border-hover',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {source === 'github-issue' && (
        <div>
          <label className="section-title block mb-2">GitHub Issue URL</label>
          <div className="flex gap-2">
            <input
              value={githubIssueUrl}
              onChange={(event) => onGitHubIssueUrlChange(event.target.value)}
              placeholder="https://github.com/NickGuAI/monorepo-g/issues/412"
              className="flex-1 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
            />
            <button
              type="button"
              onClick={onFetchIssue}
              disabled={fetchingIssue || !githubIssueUrl.trim()}
              className="px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-xs hover:bg-ink-wash disabled:opacity-60 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {fetchingIssue ? 'Fetching...' : 'Fetch'}
            </button>
          </div>
        </div>
      )}

      <div>
        <label className="section-title block mb-2">Instruction</label>
        <textarea
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          placeholder="Investigate Auth0 token expiry on mobile sessions"
          className="w-full min-h-20 px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="section-title block mb-2">cwd</label>
          <input
            value={cwd}
            onChange={(event) => onCwdChange(event.target.value)}
            placeholder="~/App"
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged font-mono text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          />
        </div>
        <div>
          <label className="section-title block mb-2">agentType</label>
          <select
            value={agentType}
            onChange={(event) => onAgentTypeChange(event.target.value as QuestAgentType)}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        </div>
        <div>
          <label className="section-title block mb-2">permissionMode</label>
          <select
            value={permissionMode}
            onChange={(event) => onPermissionModeChange(event.target.value as QuestPermissionMode)}
            className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
          >
            <option value="default">default</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </div>
      </div>

      <div>
        <label className="section-title block mb-2">skills (comma-separated)</label>
        <input
          value={skillsInput}
          onChange={(event) => onSkillsInputChange(event.target.value)}
          placeholder="legion-investigate, legion-implement"
          className="w-full px-3 py-2 rounded-lg border border-ink-border bg-washi-aged text-[16px] md:text-sm focus:outline-none focus:border-ink-border-hover"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="section-title">Artifacts</label>
          <button
            type="button"
            onClick={onToggleArtifactForm}
            className="rounded-lg border border-ink-border bg-washi-aged px-2 py-1 text-xs hover:bg-ink-wash transition-colors"
          >
            {showArtifactForm ? 'Cancel' : 'Add artifact'}
          </button>
        </div>

        {artifacts.length > 0 && (
          <div className="space-y-1">
            {artifacts.map((artifact, index) => (
              <div
                key={`${artifact.type}-${artifact.href}-${index}`}
                className="flex items-center justify-between gap-2 rounded border border-ink-border bg-washi-aged px-2 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate">
                  [{QUEST_ARTIFACT_PREFIX[artifact.type]}] {artifact.label} ({artifact.href})
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveArtifact(index)}
                  className="rounded border border-ink-border px-1.5 py-0.5 text-[10px] hover:bg-ink-wash transition-colors shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {showArtifactForm && (
          <div className="rounded-lg border border-ink-border bg-washi-aged/60 p-2 space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <select
                value={artifactType}
                onChange={(event) => onArtifactTypeChange(event.target.value as QuestArtifactType)}
                className="w-full px-2 py-1.5 rounded border border-ink-border bg-washi-aged text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
              >
                {QUEST_ARTIFACT_TYPES.map((typeOption) => (
                  <option key={typeOption.value} value={typeOption.value}>
                    {typeOption.label}
                  </option>
                ))}
              </select>
              <input
                value={artifactLabel}
                onChange={(event) => onArtifactLabelChange(event.target.value)}
                placeholder="Label"
                className="w-full px-2 py-1.5 rounded border border-ink-border bg-washi-aged text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
              />
              <input
                value={artifactHref}
                onChange={(event) => onArtifactHrefChange(event.target.value)}
                placeholder="https://github.com/... or path"
                className="w-full px-2 py-1.5 rounded border border-ink-border bg-washi-aged text-[16px] md:text-xs focus:outline-none focus:border-ink-border-hover"
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onAddArtifact}
                className="rounded-lg border border-ink-border bg-washi-aged px-2 py-1 text-xs hover:bg-ink-wash transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>

      {formError && (
        <div className="flex items-start gap-2 rounded-lg bg-accent-vermillion/10 px-3 py-2 text-sm text-accent-vermillion">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{formError}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={submitPending}
        className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        <Plus size={14} />
        {submitPending ? 'Adding...' : 'Add Quest'}
      </button>
    </form>
  )
}
