import { useState } from 'react'
import { Clock3 } from 'lucide-react'
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

  const { data: commanders = [] } = useQuery({
    queryKey: ['commanders', 'list'],
    queryFn: () => fetchJson<Commander[]>('/api/commanders'),
  })

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <Clock3 size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Sentinels</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Scheduled automation for commanders
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6 flex flex-col gap-4">
        <div className="card-sumi px-4 py-3">
          <label className="section-title block mb-2" htmlFor="commander-select">
            Commander
          </label>
          <select
            id="commander-select"
            value={selectedCommanderId ?? ''}
            onChange={(e) => setSelectedCommanderId(e.target.value || null)}
            className="w-full rounded-lg border border-ink-border bg-washi-aged px-3 py-2 text-sm text-sumi-black focus:outline-none focus:ring-1 focus:ring-sumi-mist"
          >
            <option value="">&mdash; Select Commander &mdash;</option>
            {commanders.map((commander) => (
              <option key={commander.id} value={commander.id}>
                {commander.host} ({commander.id.slice(0, 8)})
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-h-0">
          <SentinelPanel commanderId={selectedCommanderId} />
        </div>
      </div>
    </div>
  )
}
