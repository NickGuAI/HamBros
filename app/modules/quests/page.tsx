import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck } from 'lucide-react'
import { fetchJson } from '@/lib/api'
import { QuestBoard } from '../commanders/components/QuestBoard'

interface Commander {
  id: string
  host: string
  state: string
}

export default function QuestsPage() {
  const [searchParams] = useSearchParams()
  const initialCommanderId = searchParams.get('commander')
  const [selectedCommanderId] = useState<string | null>(initialCommanderId)

  const commandersQuery = useQuery({
    queryKey: ['commanders', 'sessions'],
    queryFn: () => fetchJson<Commander[]>('/api/commanders'),
    staleTime: 30_000,
  })

  const commanders = commandersQuery.data ?? []

  return (
    <div className="h-full flex flex-col">
      <header className="px-5 md:px-7 py-5 border-b border-ink-border bg-washi-aged/40">
        <div className="flex items-center gap-3">
          <ClipboardCheck size={20} className="text-sumi-diluted" />
          <div>
            <h2 className="font-display text-display text-sumi-black">Quests</h2>
            <p className="text-whisper text-sumi-mist mt-1 uppercase tracking-wider">
              Manage work for your commanders
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-4 md:p-6 flex flex-col">
        <div className="flex-1 min-h-0">
          <QuestBoard commanders={commanders} selectedCommanderId={selectedCommanderId} />
        </div>
      </div>
    </div>
  )
}
