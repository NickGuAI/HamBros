import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AskDialog } from '../AskDialog'
import { CommandPrompt } from '../CommandPrompt'
import { DialoguePanel } from '../DialoguePanel'
import { PartyHud } from '../PartyHud'
import { RpgScene, type RpgSceneHandle } from '../RpgScene'
import { useSessionWs } from '../use-session-ws'
import type { WorldAgent } from '../use-world-state'

interface OverworldScreenProps {
  agents: WorldAgent[]
  worldStatus: 'live' | 'syncing' | 'offline'
  worldError?: string
}

export function OverworldScreen({ agents, worldStatus, worldError }: OverworldScreenProps) {
  const sceneRef = useRef<RpgSceneHandle | null>(null)

  const streamAgents = useMemo(
    () => agents.filter((agent) => agent.sessionType === 'stream'),
    [agents],
  )
  const streamAgentIds = useMemo(
    () => new Set(streamAgents.map((agent) => agent.id)),
    [streamAgents],
  )

  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined)
  const [nearestAgentId, setNearestAgentId] = useState<string | null>(null)
  const [dialogueAgentId, setDialogueAgentId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedAgentId((previous) => {
      if (previous && streamAgents.some((agent) => agent.id === previous)) {
        return previous
      }
      return streamAgents[0]?.id
    })
  }, [streamAgents])

  useEffect(() => {
    if (!nearestAgentId || streamAgentIds.has(nearestAgentId)) {
      return
    }
    setNearestAgentId(null)
  }, [nearestAgentId, streamAgentIds])

  useEffect(() => {
    if (!dialogueAgentId || streamAgentIds.has(dialogueAgentId)) {
      return
    }
    setDialogueAgentId(null)
  }, [dialogueAgentId, streamAgentIds])

  useEffect(() => {
    if (!dialogueAgentId) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      event.preventDefault()
      setDialogueAgentId(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [dialogueAgentId])

  const handleInteract = useCallback(() => {
    if (!nearestAgentId || dialogueAgentId) {
      return
    }
    setSelectedAgentId(nearestAgentId)
    setDialogueAgentId(nearestAgentId)
  }, [dialogueAgentId, nearestAgentId])

  const handleToolUse = useCallback((toolName: string) => {
    if (!selectedAgentId) {
      return
    }
    sceneRef.current?.emitToolFx(selectedAgentId, toolName)
  }, [selectedAgentId])

  const {
    status: wsStatus,
    pendingAsk,
    sendInput,
    sendToolAnswer,
  } = useSessionWs({
    sessionName: selectedAgentId,
    onToolUse: handleToolUse,
  })

  return (
    <section className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <RpgScene
        ref={sceneRef}
        agents={agents}
        className="absolute inset-0"
        streamAgentIds={streamAgentIds}
        onNearestStreamAgentChange={setNearestAgentId}
        onInteract={handleInteract}
        playerFrozen={Boolean(dialogueAgentId)}
      />

      <PartyHud
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={setSelectedAgentId}
        worldStatus={worldStatus}
        wsStatus={wsStatus}
      />

      <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
        <div className="rounded-md border border-white/20 bg-black/55 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-white/85 backdrop-blur-[2px]">
          selected {selectedAgentId ?? 'none'}
        </div>
      </div>

      {worldError ? (
        <div className="pointer-events-none absolute inset-x-0 top-12 z-20 px-3 text-center text-[10px] font-mono text-red-200/95">
          {worldError}
        </div>
      ) : null}

      {streamAgents.length === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 px-3 text-center text-[11px] font-mono uppercase tracking-[0.08em] text-amber-100/90">
          create a stream agent session to enable command + dialog input
        </div>
      ) : null}

      {!dialogueAgentId ? (
        <AskDialog
          pendingAsk={pendingAsk}
          disabled={wsStatus !== 'connected'}
          onSubmit={sendToolAnswer}
        />
      ) : null}

      {!dialogueAgentId ? (
        <CommandPrompt
          selectedAgentId={selectedAgentId}
          disabled={wsStatus !== 'connected'}
          onSubmit={sendInput}
        />
      ) : null}

      {dialogueAgentId ? (
        <DialoguePanel
          agentId={dialogueAgentId}
          onClose={() => setDialogueAgentId(null)}
        />
      ) : null}
    </section>
  )
}
