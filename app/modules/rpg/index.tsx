import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useWorldState, type WorldAgent } from './use-world-state'
import { EconomyScreen } from './screens/EconomyScreen'
import { LogScreen, type ToolLogEntry } from './screens/LogScreen'
import { OverworldScreen } from './screens/OverworldScreen'
import { PartyScreen } from './screens/PartyScreen'
import { QuestsScreen } from './screens/QuestsScreen'

type RpgScreen = 'overworld' | 'party' | 'quests' | 'economy' | 'log'

interface EconomyPoint {
  time: string
  totalCost: number
}

const SCREENS: RpgScreen[] = ['overworld', 'party', 'quests', 'economy', 'log']

const SCREEN_LABELS: Record<RpgScreen, string> = {
  overworld: 'Overworld',
  party: 'Party',
  quests: 'Quests',
  economy: 'Economy',
  log: 'Log',
}

function normalizeScreen(raw: string | null): RpgScreen {
  if (raw && SCREENS.includes(raw as RpgScreen)) {
    return raw as RpgScreen
  }
  return 'overworld'
}

function formatScreenStatus(isLoading: boolean, isFetching: boolean, isError: boolean): 'live' | 'syncing' | 'offline' {
  if (isError) {
    return 'offline'
  }
  if (isLoading || isFetching) {
    return 'syncing'
  }
  return 'live'
}

export default function RpgScreenRouter() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawScreen = searchParams.get('screen')
  const screen = normalizeScreen(rawScreen)

  const {
    data: agents = [],
    isLoading,
    isFetching,
    isError,
    error,
  } = useWorldState()

  const [economyHistory, setEconomyHistory] = useState<EconomyPoint[]>([])
  const [logEntries, setLogEntries] = useState<ToolLogEntry[]>([])
  const lastToolMarkersRef = useRef<Record<string, string>>({})

  useEffect(() => {
    if (rawScreen !== screen) {
      const next = new URLSearchParams(searchParams)
      next.set('screen', screen)
      setSearchParams(next, { replace: true })
    }
  }, [rawScreen, screen, searchParams, setSearchParams])

  useEffect(() => {
    const totalCost = agents.reduce((sum, agent) => sum + agent.usage.costUsd, 0)
    const label = new Date().toLocaleTimeString([], { hour12: false })

    setEconomyHistory((previous) => {
      const last = previous[previous.length - 1]
      if (last && last.totalCost === totalCost && last.time === label) {
        return previous
      }

      const next = [...previous, { time: label, totalCost }]
      if (next.length > 300) {
        next.shift()
      }
      return next
    })
  }, [agents])

  useEffect(() => {
    const newEntries: ToolLogEntry[] = []

    for (const agent of agents) {
      if (!agent.lastToolUse || (agent.phase !== 'tool_use' && agent.phase !== 'blocked')) {
        continue
      }

      const marker = `${agent.lastToolUse}:${agent.lastUpdatedAt}:${agent.phase}`
      if (lastToolMarkersRef.current[agent.id] === marker) {
        continue
      }

      lastToolMarkersRef.current[agent.id] = marker
      newEntries.push({
        id: `${agent.id}:${agent.lastUpdatedAt}:${agent.lastToolUse}`,
        ts: agent.lastUpdatedAt,
        agentId: agent.id,
        toolName: agent.lastToolUse,
      })
    }

    if (newEntries.length === 0) {
      return
    }

    setLogEntries((previous) =>
      [...newEntries, ...previous]
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
        .slice(0, 50),
    )
  }, [agents])

  const worldStatus = formatScreenStatus(isLoading, isFetching, isError)
  const worldError = isError
    ? (error instanceof Error ? error.message : 'Failed to load world state')
    : undefined

  const screenNode = useMemo(() => {
    switch (screen) {
      case 'party':
        return <PartyScreen agents={agents} />
      case 'quests':
        return <QuestsScreen agents={agents} />
      case 'economy':
        return <EconomyScreen history={economyHistory} />
      case 'log':
        return <LogScreen entries={logEntries} />
      default:
        return (
          <OverworldScreen
            agents={agents}
            worldStatus={worldStatus}
            worldError={worldError}
          />
        )
    }
  }, [agents, economyHistory, logEntries, screen, worldError, worldStatus])

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black">
      {screenNode}

      <div className="pointer-events-none absolute inset-x-0 top-2 z-50 flex justify-center px-3">
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-md border border-white/20 bg-black/60 p-1 backdrop-blur-[2px]">
          {SCREENS.map((name) => {
            const selected = name === screen
            return (
              <button
                key={name}
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams)
                  next.set('screen', name)
                  setSearchParams(next)
                }}
                className={`rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] transition ${selected
                  ? 'bg-emerald-300/20 text-emerald-100'
                  : 'bg-black/40 text-white/70 hover:text-white'}`}
              >
                {SCREEN_LABELS[name]}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export type { EconomyPoint }
export type { WorldAgent }
