import { useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { useMachines } from '@/hooks/use-agents'
import { ModalFormContainer } from '../components/ModalFormContainer'
import { CreateTaskForm } from './components/CreateTaskForm'
import { RunHistory } from './components/RunHistory'
import { TaskList } from './components/TaskList'
import { useCommandRoom } from './hooks/useCommandRoom'

export default function CommandRoomPage() {
  const commandRoom = useCommandRoom()
  const { data: machines } = useMachines()
  const machineList = machines ?? []
  const [showCreateForm, setShowCreateForm] = useState(false)

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <CalendarClock size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Command Room</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Cron workflows for Claude/Codex sessions with run reports
            </p>
          </div>
        </div>
      </header>

      <ModalFormContainer
        open={showCreateForm}
        title="New Cron Task"
        onClose={() => setShowCreateForm(false)}
      >
        <CreateTaskForm
          onCreate={commandRoom.createTask}
          onClose={() => setShowCreateForm(false)}
          machines={machineList}
          createPending={commandRoom.createTaskPending}
        />
      </ModalFormContainer>

      <div className="flex-1 min-h-0 p-4 md:p-6 flex flex-col gap-3">
        {(commandRoom.tasksError || commandRoom.runsError || commandRoom.actionError) && (
          <p className="text-sm text-accent-vermillion">
            {commandRoom.actionError ?? commandRoom.runsError ?? commandRoom.tasksError}
          </p>
        )}

        <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] gap-4">
          <TaskList
            tasks={commandRoom.tasks}
            selectedTaskId={commandRoom.selectedTaskId}
            onSelect={commandRoom.setSelectedTaskId}
            onNewTask={() => setShowCreateForm(true)}
            onToggle={async (taskId, enabled) => {
              await commandRoom.updateTask({
                taskId,
                patch: { enabled },
              })
            }}
            onDelete={commandRoom.deleteTask}
            onRunNow={commandRoom.triggerTask}
            updateTaskId={commandRoom.updateTaskId}
            deleteTaskId={commandRoom.deleteTaskId}
            triggerTaskId={commandRoom.triggerTaskId}
            loading={commandRoom.tasksLoading}
          />
          <RunHistory
            task={commandRoom.selectedTask}
            runs={commandRoom.runs}
            loading={commandRoom.runsLoading}
          />
        </div>
      </div>
    </div>
  )
}
