import { useState } from 'react'
import { Clock3, Plus } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/api'
import { SentinelPanel } from './components/SentinelPanel'

interface Commander {
  id: string
  host: string
  state: string
}

export default function SentinelsPage() {
  const [selectedCommanderId, setSelectedCommanderId] = useState<string | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const { data: commanders = [] } = useQuery({
    queryKey: ['commanders', 'list'],
    queryFn: () => fetchJson<Commander[]>('/api/commanders'),
  })

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-center gap-3">
            <Clock3 size={20} className="text-sumi-diluted" />
            <div>
              <h2 className="font-display text-display text-sumi-black">Sentinels</h2>
              <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
                Scheduled automation for commanders
              </p>
            </div>
          </div>

          <div className="flex items-end gap-3">
            <div>
              <label className="section-title block mb-1.5" htmlFor="sentinels-commander-select">
                Commander
              </label>
              <select
                id="sentinels-commander-select"
                value={selectedCommanderId ?? ''}
                onChange={(e) => setSelectedCommanderId(e.target.value || null)}
                className="w-full min-w-[15rem] lg:w-[21rem] rounded-lg border border-ink-border bg-washi-aged px-3 py-2 text-sm text-sumi-black focus:outline-none focus:ring-1 focus:ring-sumi-mist"
              >
                <option value="">&mdash; Select Commander &mdash;</option>
                {commanders.map((commander) => (
                  <option key={commander.id} value={commander.id}>
                    {commander.host} ({commander.id.slice(0, 8)})
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              disabled={!selectedCommanderId}
              className="btn-ghost min-h-[44px] inline-flex items-center gap-1.5 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Plus size={14} />
              New
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6 flex flex-col">
        <div className="flex-1 min-h-0">
          <SentinelPanel
            commanderId={selectedCommanderId}
            showCreateForm={showCreateForm}
            onCloseCreateForm={() => setShowCreateForm(false)}
          />
        </div>
      </div>
    </div>
  )
}
