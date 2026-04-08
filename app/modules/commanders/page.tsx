import { useState } from 'react'
import { Crown, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useCommander } from './hooks/useCommander'
import { CommanderCard } from './components/CommanderCard'
import { CreateCommanderForm } from './components/CreateCommanderForm'
import { EditCommanderForm } from './components/EditCommanderForm'
import { ModalFormContainer } from '../components/ModalFormContainer'

export default function CommandersPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const commander = useCommander()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingCommanderId, setEditingCommanderId] = useState<string | null>(null)
  const editingCommander = commander.commanders.find((c) => c.id === editingCommanderId) ?? null

  const pageError = commander.actionError ?? commander.commandersError

  async function handleOpenChat(
    commanderId: string,
    agentType: 'claude' | 'codex',
  ): Promise<void> {
    await queryClient.refetchQueries({ queryKey: ['agents', 'sessions'] })
    const params = new URLSearchParams({
      session: `commander-${commanderId}`,
      agentType,
    })
    navigate(`/agents?${params.toString()}`)
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Crown size={20} className="text-sumi-diluted" />
            <div>
              <h2 className="font-display text-display text-sumi-black">Commanders</h2>
              <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
                Fleet overview
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="btn-ghost min-h-[44px] inline-flex items-center gap-1.5 text-sm"
          >
            <Plus size={14} />
            New Commander
          </button>
        </div>
      </header>

      <ModalFormContainer
        open={showCreateForm}
        title="New Commander"
        onClose={() => setShowCreateForm(false)}
      >
        <CreateCommanderForm
          onAdd={async (input) => {
            await commander.createCommander(input)
            setShowCreateForm(false)
          }}
          isPending={commander.createCommanderPending}
          onClose={() => setShowCreateForm(false)}
        />
      </ModalFormContainer>

      <ModalFormContainer
        open={editingCommanderId !== null}
        title="Edit Commander"
        onClose={() => setEditingCommanderId(null)}
      >
        {editingCommander && (
          <EditCommanderForm
            commander={editingCommander}
            onSave={async (updates, avatarFile) => {
              if (avatarFile) {
                await commander.uploadAvatar({ commanderId: editingCommander.id, file: avatarFile })
              }
              await commander.updateProfile({ commanderId: editingCommander.id, ...updates })
              setEditingCommanderId(null)
            }}
            onClose={() => setEditingCommanderId(null)}
            isPending={commander.updateProfilePending || commander.uploadAvatarPending}
          />
        )}
      </ModalFormContainer>

      <div className="flex-1 min-h-0 p-4 md:p-6 overflow-y-auto">
        {pageError && (
          <p className="text-sm text-accent-vermillion mb-4">{pageError}</p>
        )}

        {commander.commandersLoading && commander.commanders.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <div className="w-4 h-4 rounded-full bg-sumi-mist animate-breathe" />
          </div>
        )}

        {!commander.commandersLoading && commander.commanders.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-sumi-diluted">
            <p className="text-sm">No commanders yet.</p>
            <p className="text-xs mt-1">Create one to get started.</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {commander.commanders.map((session) => (
            <CommanderCard
              key={session.id}
              commander={session}
              onStart={commander.startCommander}
              onStop={commander.stopCommander}
              onOpenChat={handleOpenChat}
              onDelete={commander.deleteCommander}
              onEdit={setEditingCommanderId}
              isStartPending={commander.startPending}
              isStopPending={commander.stopPending}
              isDeletePending={commander.deleteCommanderPending}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
