import { useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { CommanderList } from './components/CommanderList'
import { CommanderDetailPanel } from './components/CommanderDetailPanel'
import { useCommander, type CommanderAgentType } from './hooks/useCommander'

/** Parse /commanders[/:id[/:tab]] from location.pathname */
function parseUrl(pathname: string): { commanderId: string | null; tab: string } {
  // Strip leading /commanders/ prefix and split remainder
  const rest = pathname.replace(/^\/commanders\/?/, '')
  const segments = rest.split('/').filter(Boolean)
  return {
    commanderId: segments[0] ?? null,
    tab: segments[1] ?? 'quests',
  }
}

export default function CommandersPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const commander = useCommander()

  const { commanderId: urlCommanderId, tab: urlTab } = parseUrl(location.pathname)

  // Sync URL commander ID into hook state (for WS, crons, etc.)
  useEffect(() => {
    if (urlCommanderId && urlCommanderId !== commander.selectedCommanderId) {
      commander.setSelectedCommanderId(urlCommanderId)
    }
  }, [urlCommanderId, commander.selectedCommanderId, commander.setSelectedCommanderId])

  // Auto-navigate to first commander when landing on /commanders with no ID
  useEffect(() => {
    if (!urlCommanderId && !commander.commandersLoading && commander.commanders.length > 0) {
      const firstId = commander.commanders[0]?.id
      if (firstId) {
        navigate(`/commanders/${firstId}`, { replace: true })
      }
    }
  }, [urlCommanderId, commander.commandersLoading, commander.commanders, navigate])

  function handleSelectCommander(id: string): void {
    navigate(`/commanders/${id}`)
  }

  function handleTabChange(tab: string): void {
    if (!urlCommanderId) return
    // 'quests' is the default — use the bare /:id URL for it
    if (tab === 'quests') {
      navigate(`/commanders/${urlCommanderId}`)
    } else {
      navigate(`/commanders/${urlCommanderId}/${tab}`)
    }
  }

  async function handleOpenChat(commanderId: string, agentType?: CommanderAgentType): Promise<void> {
    const params = new URLSearchParams({ session: `commander-${commanderId}` })
    if (agentType) params.set('agentType', agentType)
    navigate(`/agents?${params.toString()}`)
  }

  // On mobile: show detail panel when a commander ID is in the URL
  const showDetailOnMobile = Boolean(urlCommanderId)

  const pageError = commander.actionError ?? commander.commandersError
  const commanderOptions = commander.commanders.map((session) => ({
    id: session.id,
    label: session.displayName?.trim() || session.host,
  }))

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {pageError && (
        <p className="px-5 py-2 text-sm text-accent-vermillion border-b border-ink-border bg-accent-vermillion/5 shrink-0">
          {pageError}
        </p>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* ── Left panel: Commander list ── */}
        <div
          className={cn(
            'flex flex-col overflow-hidden border-r border-ink-border bg-washi-aged/10',
            // Mobile: hide list when detail is shown
            showDetailOnMobile ? 'hidden md:flex' : 'flex',
            'w-full md:w-64 lg:w-72 shrink-0',
          )}
        >
          <CommanderList
            commanders={commander.commanders}
            selectedCommanderId={urlCommanderId}
            onSelect={handleSelectCommander}
            loading={commander.commandersLoading}
            onAddCommander={commander.createCommander}
            isAddingCommander={commander.createCommanderPending}
            onDeleteCommander={commander.deleteCommander}
            isDeletePending={commander.deleteCommanderPending}
            onOpenChat={handleOpenChat}
            onStartCommander={commander.startCommander}
            onStopCommander={commander.stopCommander}
            isStartPending={commander.startPending}
            isStopPending={commander.stopPending}
          />
        </div>

        {/* ── Right panel: Commander detail ── */}
        <div
          className={cn(
            'flex-1 min-w-0',
            // Mobile: show only when a commander is selected
            showDetailOnMobile ? 'flex' : 'hidden md:flex',
          )}
        >
          {commander.selectedCommander ? (
            <CommanderDetailPanel
              commander={commander.selectedCommander}
              activeTab={urlTab}
              onTabChange={handleTabChange}
              onBack={() => navigate('/commanders')}
              commanderOptions={commanderOptions}
              onSelectCommander={handleSelectCommander}
              onOpenChat={handleOpenChat}
              onStartCommander={commander.startCommander}
              onStopCommander={commander.stopCommander}
              isStartPending={commander.startPending}
              isStopPending={commander.stopPending}
              crons={commander.crons}
              cronsLoading={commander.cronsLoading}
              cronsError={commander.cronsError}
              addCron={commander.addCron}
              addCronPending={commander.addCronPending}
              toggleCron={commander.toggleCron}
              toggleCronPending={commander.toggleCronPending}
              deleteCron={commander.deleteCron}
              deleteCronPending={commander.deleteCronPending}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sumi-diluted text-sm">
              {commander.commandersLoading ? (
                <div className="w-3 h-3 rounded-full bg-sumi-mist animate-breathe" />
              ) : (
                <p>Select a commander to view details.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
