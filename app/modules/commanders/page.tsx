import { Crown } from 'lucide-react'
import { CommanderList } from './components/CommanderList'
import { CommanderTerminal } from './components/CommanderTerminal'
import { CommanderControls } from './components/CommanderControls'
import { TaskDrawer } from './components/TaskDrawer'
import { CronDrawer } from './components/CronDrawer'
import { useCommander } from './hooks/useCommander'

export default function CommandersPage() {
  const commander = useCommander()

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <Crown size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Commanders</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Runtime control, live output, tasks, and cron schedules
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6 flex flex-col gap-4">
        <CommanderControls
          commander={commander.selectedCommander}
          wsStatus={commander.terminalConnectionStatus}
          heartbeatPulseAt={commander.heartbeatPulseAt}
          onStart={commander.startCommander}
          onStop={commander.stopCommander}
          onSendMessage={commander.sendMessage}
          isStarting={commander.startPending}
          isStopping={commander.stopPending}
          isSendingMessage={commander.sendMessagePending}
        />

        {(commander.commandersError || commander.actionError) && (
          <p className="text-sm text-accent-vermillion">
            {commander.actionError ?? commander.commandersError}
          </p>
        )}

        <div className="flex-1 min-h-[18rem] grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-4">
          <CommanderList
            commanders={commander.commanders}
            selectedCommanderId={commander.selectedCommanderId}
            onSelect={commander.setSelectedCommanderId}
            loading={commander.commandersLoading}
            onAddCommander={commander.createCommander}
            isAddingCommander={commander.createCommanderPending}
            onDeleteCommander={commander.deleteCommander}
            isDeletePending={commander.deleteCommanderPending}
          />
          <CommanderTerminal
            commander={commander.selectedCommander}
            lines={commander.terminalLines}
            resetKey={commander.terminalResetKey}
            wsStatus={commander.terminalConnectionStatus}
          />
        </div>

        <div className="min-h-[14rem] xl:h-56 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <TaskDrawer
            commander={commander.selectedCommander}
            tasks={commander.tasks}
            loading={commander.tasksLoading}
            error={commander.tasksError}
            onAssignTask={commander.assignTask}
            assignTaskPending={commander.assignTaskPending}
          />
          <CronDrawer
            commander={commander.selectedCommander}
            crons={commander.crons}
            loading={commander.cronsLoading}
            error={commander.cronsError}
            onAddCron={commander.addCron}
            onDeleteCron={commander.deleteCron}
            onToggleCron={commander.toggleCron}
            addCronPending={commander.addCronPending}
            toggleCronPending={commander.toggleCronPending}
            deleteCronPending={commander.deleteCronPending}
          />
        </div>
      </div>
    </div>
  )
}
