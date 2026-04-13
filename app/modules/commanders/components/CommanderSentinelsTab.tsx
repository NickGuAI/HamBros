import { useState } from 'react'
import { Plus, Shield } from 'lucide-react'
import { SentinelPanel } from '../../sentinels/components/SentinelPanel'
import type { CommanderSession } from '../hooks/useCommander'

export function CommanderSentinelsTab({
  commander,
}: {
  commander: CommanderSession
}) {
  const [showCreateForm, setShowCreateForm] = useState(false)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 md:px-6 py-3 border-b border-ink-border flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Shield size={14} strokeWidth={1.75} className="text-sumi-diluted shrink-0" />
            <span className="text-xs uppercase tracking-wide text-sumi-diluted">
              Attached sentinels
            </span>
          </div>
          <p className="text-sm text-sumi-gray mt-1 pl-6">
            Scheduled automations scoped to {commander.host}.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateForm((current) => !current)}
          className="btn-ghost !px-3 !py-1.5 text-xs inline-flex items-center gap-1.5 shrink-0"
        >
          <Plus size={12} />
          {showCreateForm ? 'Close' : 'Add Sentinel'}
        </button>
      </div>

      <div className="flex-1 min-h-0 p-4 md:p-6">
        <SentinelPanel
          commanderId={commander.id}
          showCreateForm={showCreateForm}
          onCloseCreateForm={() => setShowCreateForm(false)}
        />
      </div>
    </div>
  )
}
